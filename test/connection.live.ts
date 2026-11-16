// Real sing-box-lx + an explicitly supplied private AWG profile. No system TUN,
// route, adapter, DNS or firewall mutation. No credentials are written to the report.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildConfig, checkConfig, parseConf, redact, REST_SEL, tagOf } from '../src/main/awg'
import { DEFAULTS } from '../src/main/store-core'
import type { Profile, Settings } from '../src/shared/types'

type Outcome = 'pass' | 'fail' | 'blocked'
type Evidence = { name: string; outcome: Outcome; detail: string; milliseconds?: number }
const option = (name: string): string => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}
const binary = option('--engine'), source = option('--config'), reportFile = option('--report')
if (source === reportFile || binary === reportFile) throw new Error('Report must not overwrite an input')
if (statSync(source).size > 1024 * 1024) throw new Error('Config exceeds import limit')
const profile = parseConf(readFileSync(source, 'utf8'), 'Private live-test profile')
// Repeatable labels in reports; the real generated ID and endpoint are not published.
profile.id = 'private-live'
const root = mkdtempSync(join(tmpdir(), 'waarp-live-')); chmodSync(root, 0o700)
const rows: Evidence[] = [], children = new Set<ChildProcess>()
const startedAt = new Date().toISOString(), started = performance.now()
const secretValues = [profile.privateKey, profile.peer.publicKey, profile.peer.presharedKey, profile.peer.host, ...profile.dns, ...profile.address.map(x => x.split('/')[0])].filter((x): x is string => !!x)
const safe = (text: string) => redact(secretValues.reduce((s, key) => s.split(key).join('[redacted]'), text)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(-2500)
const record = (name: string, outcome: Outcome, detail: string, since?: number) => {
  const row = { name, outcome, detail: safe(detail), ...(since === undefined ? {} : { milliseconds: Math.round(performance.now() - since) }) }
  rows.push(row); console.log(JSON.stringify(row))
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const alive = (child: ChildProcess) => !!child.pid && child.exitCode === null && child.signalCode === null
async function exited(child: ChildProcess, budget: number): Promise<boolean> {
  if (!alive(child)) return true
  return new Promise(resolve => {
    const finish = (ok: boolean) => { clearTimeout(timer); child.off('exit', done); resolve(ok) }
    const done = () => finish(true)
    const timer = setTimeout(() => finish(!alive(child)), budget)
    child.once('exit', done)
  })
}
async function terminate(child: ChildProcess, crash = false): Promise<boolean> {
  if (alive(child)) child.kill(crash ? 'SIGKILL' : 'SIGTERM')
  if (!(await exited(child, 5000)) && alive(child)) child.kill('SIGKILL')
  const stopped = await exited(child, 2000)
  if (stopped) children.delete(child)
  return stopped
}
async function command(file: string, args: string[], budget = 25_000): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let output = '', timedOut = false, settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (!alive(child)) children.delete(child)
      resolve({ code, output, timedOut })
    }
    const timer = setTimeout(() => { timedOut = true; void terminate(child, true).then(() => finish(null)) }, budget)
    child.stdout?.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.stderr?.on('data', chunk => { output = (output + chunk).slice(-65536) })
    child.on('error', error => { output += error.message; finish(null) })
    child.on('close', finish)
  })
}
async function port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No loopback address')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
async function closed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(700, () => finish(false)); socket.once('connect', () => finish(false)); socket.once('error', () => finish(true))
  })
}
const settings: Settings = { ...DEFAULTS, routes: [], groups: [], rest: profile.id, ruDirect: false, lanDirect: false, autoConnect: false, autostart: false, notify: false }
const privateFile = (name: string, cfg: unknown) => {
  const path = join(root, name)
  writeFileSync(path, JSON.stringify(cfg), { mode: 0o600 }); chmodSync(path, 0o600)
  return path
}
type Session = { child: ChildProcess; apiPort: number; proxyPort: number; request: (path: string, init?: RequestInit) => Promise<Response>; log: () => string }
let generation = 0
async function startCore(profiles: Profile[], name: string): Promise<Session | undefined> {
  const since = performance.now()
  const apiPort = await port(), proxyPort = await port(), secret = randomBytes(24).toString('hex')
  secretValues.push(secret)
  const cfg: any = buildConfig(profiles, settings, { api: { port: apiPort, secret }, selectors: true })
  // Only the ingress/platform layer changes. Routing/DNS/selectors/endpoint
  // bytes come from the same builders as the production app.
  cfg.inbounds = [{ type: 'mixed', tag: 'live-audit', listen: '127.0.0.1', listen_port: proxyPort }]
  cfg.endpoints = cfg.endpoints.map((ep: any) => ({ ...ep, system: false }))
  cfg.route.auto_detect_interface = false; cfg.route.find_process = false
  const file = privateFile(`session-${++generation}.json`, cfg)
  const child = spawn(binary, ['run', '-c', file, '-D', root, '--disable-color'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout?.on('data', data => { output = (output + data).slice(-65536) })
  child.stderr?.on('data', data => { output = (output + data).slice(-65536) })
  child.on('error', error => { output += error.message })
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${apiPort}${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, ...init.headers }, signal: AbortSignal.timeout(8500) })
  let ready = false
  for (const end = performance.now() + 20_000; alive(child) && performance.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/version`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(600) })).ok) { ready = true; break } } catch { /* bounded startup */ }
    await sleep(150)
  }
  if (!ready) {
    await terminate(child)
    record(name, /operation not permitted|permission denied|EPERM|EACCES/i.test(output) ? 'blocked' : 'fail', 'Local core did not become ready. ' + output, since)
    return undefined
  }
  // Once parsed, the secret configuration is not needed on disk by the core.
  rmSync(file, { force: true })
  record(name, 'pass', 'Real core process answered its authenticated loopback controller; userspace ingress ready.', since)
  return { child, apiPort, proxyPort, request, log: () => safe(output) }
}
async function stopCore(session: Session, name: string, crash = false) {
  const since = performance.now(), stopped = await terminate(session.child, crash)
  const gone = await closed(session.apiPort) && await closed(session.proxyPort)
  record(name, stopped && gone ? 'pass' : 'fail', `${crash ? 'SIGKILL' : 'Graceful stop'}: owned process exited=${stopped}; both local ports closed=${gone}.`, since)
}
async function throughHost(session: Session, name: string) {
  const since = performance.now()
  for (const url of ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204']) {
    try {
      const response = await session.request(`/proxies/${tagOf(profile.id)}/delay?timeout=6000&url=${encodeURIComponent(url)}`)
      const value = await response.json() as { delay?: unknown; message?: unknown }
      if (response.ok && typeof value.delay === 'number' && Number.isFinite(value.delay) && value.delay >= 0) {
        record(name, 'pass', `HTTP probe through the explicit AWG endpoint succeeded (${value.delay} ms); no direct fallback configured for this probe.`, since)
        return true
      }
    } catch { /* one second independent HTTP target, no infinite retry */ }
  }
  record(name, 'fail', 'Neither HTTP target answered through the supplied endpoint. This does not identify whether the host, credentials, UDP path or this environment caused the failure. ' + session.log(), since)
  return false
}
async function proxyRequest(session: Session, name: string) {
  const since = performance.now()
  const result = await command('curl', ['--silent', '--show-error', '--fail', '--connect-timeout', '8', '--max-time', '18', '--proxy', `http://127.0.0.1:${session.proxyPort}`, '--noproxy', '', 'https://www.cloudflare.com/cdn-cgi/trace'], 20_000)
  const hasTrace = /^ip=\S+$/m.test(result.output)
  record(name, result.code === 0 && hasTrace ? 'pass' : 'fail', `Real HTTPS request over loopback proxy completed=${result.code === 0}; remote trace body received=${hasTrace}. Exit address intentionally omitted.`, since)
}

async function removedRouteRefuses(session: Session) {
  // A controlled local origin distinguishes intentional route rejection from
  // an unrelated Internet/DNS outage. Direct must work while the removed path fails.
  const origin = httpServer((_req, res) => { res.writeHead(200); res.end('waarp-local-route-control') })
  await new Promise<void>((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve) })
  try {
    const address = origin.address()
    if (!address || typeof address === 'string') throw new Error('Local control origin did not bind')
    const url = `http://127.0.0.1:${address.port}/`
    const common = ['--silent', '--show-error', '--fail', '--max-time', '5']
    const direct = await command('curl', [...common, '--proxy', '', '--noproxy', '*', url], 7000)
    const proxy = await command('curl', [...common, '--proxy', `http://127.0.0.1:${session.proxyPort}`, '--noproxy', '', url], 7000)
    const control = direct.code === 0 && direct.output === 'waarp-local-route-control'
    record('removed-profile-does-not-leak-direct', control && proxy.code !== 0 && !proxy.timedOut ? 'pass' : 'fail', `Controlled origin works directly=${control}; request through the removed route refused=${proxy.code !== 0}; timeout=${proxy.timedOut}.`)
  } finally { origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())) }
}

;(async () => {
  try {
    const version = await command(binary, ['version'], 5000)
    const pinned = version.code === 0 && version.output.includes('1.14.2-lx.11')
    record('pinned-engine-version', pinned ? 'pass' : 'fail', version.output)
    if (!pinned) return
    const checkApi = { port: await port(), secret: randomBytes(24).toString('hex') }; secretValues.push(checkApi.secret)
    for (const [name, cfg] of [
      ['production-config-schema', buildConfig([profile], settings, { api: checkApi, selectors: true })],
      ['checker-config-schema', checkConfig([profile], checkApi)]
    ] as const) {
      const file = privateFile(name + '.json', cfg), since = performance.now()
      const result = await command(binary, ['check', '-c', file, '-D', root, '--disable-color'], 15_000)
      record(name, result.code === 0 ? 'pass' : 'fail', result.code === 0 ? 'Exact generated configuration accepted by the pinned real core.' : result.output, since)
      rmSync(file, { force: true })
      if (result.code !== 0) return
    }

    const first = await startCore([profile], 'start-with-imported-profile')
    if (!first) return
    const reachable = await throughHost(first, 'remote-host-through-awg')
    if (reachable) await proxyRequest(first, 'https-through-production-route')
    for (const choice of ['direct', tagOf(profile.id)]) {
      const response = await first.request(`/proxies/${encodeURIComponent(REST_SEL)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: choice }) })
      const actual = await (await first.request(`/proxies/${encodeURIComponent(REST_SEL)}`)).json() as { now?: string }
      record(choice === 'direct' ? 'switch-route-off' : 'switch-route-on', response.ok && actual.now === choice ? 'pass' : 'fail', `Controller acknowledged=${response.ok}; actual selected route matches=${actual.now === choice}.`)
    }
    await stopCore(first, 'normal-off')

    const crashed = await startCore([profile], 'normal-on-again')
    if (!crashed) return
    if (reachable) await throughHost(crashed, 'remote-host-after-on-off')
    await stopCore(crashed, 'crash-owned-core', true)

    const removed = await startCore([], 'restart-after-crash-with-profile-removed')
    if (!removed) return
    const missing = await removed.request(`/proxies/${tagOf(profile.id)}`)
    record('removed-profile-not-loaded', missing.status === 404 ? 'pass' : 'fail', `Controller returns HTTP ${missing.status} for the removed endpoint.`)
    await removedRouteRefuses(removed)
    await stopCore(removed, 'stop-after-removal')

    const reimported = { ...parseConf(readFileSync(source, 'utf8'), 'Private live-test profile'), id: profile.id }
    const added = await startCore([reimported], 'reimport-and-add-profile')
    if (!added) return
    if (reachable) { await throughHost(added, 'remote-host-after-crash-and-readd'); await proxyRequest(added, 'https-after-readd') }
    else record('remote-host-after-crash-and-readd', 'blocked', 'Not repeated: the first two independent remote probes already failed; local lifecycle was still exercised.')
    await stopCore(added, 'final-off')
  } catch (error) { record('unexpected-runner-failure', 'fail', error instanceof Error ? error.message : String(error)) }
  finally {
    let cleanup = true
    for (const child of [...children]) cleanup = await terminate(child) && cleanup
    if (cleanup) rmSync(root, { recursive: true, force: true })
    record('cleanup', cleanup && !existsSync(root) ? 'pass' : 'fail', 'Owned processes stopped and temporary private configurations removed.')
    const report = {
      startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), platform: process.platform,
      engineSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      profile: { protocol: profile.version, addresses: profile.address.length, dnsServers: profile.dns.length, hasAllowedIPs: !!profile.peer.allowedIPs?.length },
      systemTunTested: false,
      adaptation: 'Production builder with TUN inbound replaced by loopback mixed inbound; endpoint system=false; route auto_detect_interface/find_process disabled. Windows lifecycle ownership is tested separately.',
      results: rows
    }
    mkdirSync(dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    if (rows.some(row => row.outcome !== 'pass')) process.exitCode = 1
  }
})()
