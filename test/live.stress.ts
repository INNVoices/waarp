/** Real Windows adapter lifecycle gate for an explicitly disposable, elevated VM.
 * No private profiles, public probes, default-route changes, or DNS interception.
 * This does not prove full routing, remote connectivity, or physical sleep.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildConfig, checkConfig, parseConf } from '../src/main/awg'
import { parseLink } from '../src/main/links'
import { parseOpenVpn } from '../src/main/openvpn'
import { DEFAULTS } from '../src/main/store-core'
import { verifyEngine } from '../src/main/integrity'
import { isAdmin, ps } from '../src/main/ps'
import { RuntimeJournal } from '../src/main/runtime-journal'
import { ctrlBreak, waitExit } from '../src/main/stop'
import type { Profile } from '../src/shared/types'

const CYCLES = 50
const BUDGET_MS = 420_000 // Leave bounded cleanup time inside an eight-minute job step.
const args = process.argv.slice(2)
const reportAt = args.indexOf('--report')
const reportPath = resolve(reportAt >= 0 ? args[reportAt + 1] || '' : 'out/validation/native-lifecycle.json')
const exe = resolve('engine/sing-box.exe')
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
type Row = Record<string, string | number | string[]>
interface Snapshot { adapters: Row[]; addresses: Row[]; routes: Row[]; dns: Row[]; peakBytes: number }
interface Cycle {
  cycle: number; request: 'stop' | 'crash'; passed: boolean
  stopMethod?: 'ctrl-break' | 'no-console-force' | 'crash'
  startupMs?: number; stopMs?: number; peakWorkingSetBytes?: number
  apiReady?: boolean; adapterAndAddressPresent?: boolean; adapterAndRoutesRemoved?: boolean
  foreignNetworkUnchanged?: boolean; error?: string
}
interface ConfigCheck { protocol: string; production: boolean; checker: boolean }
const report = {
  schema: 1, scope: 'native-windows-adapter-lifecycle', passed: false,
  requestedCycles: CYCLES, completedCycles: 0, engineVersion: '', engineGoVersion: null as string | null, engineSha256: '', engineIntegrityVerified: false,
  elevated: false, noExternalProbes: true, autoRoute: false, dnsMode: 'disabled',
  protocolChecks: [] as ConfigCheck[], cycles: [] as Cycle[], metrics: {} as Record<string, number | null>,
  cleanup: { childExited: true, adapterAndRoutesRemoved: false, foreignNetworkUnchanged: false, temporaryFilesRemoved: false },
  errors: [] as string[], elapsedMs: 0
}
let child: ChildProcess | undefined
let journal: RuntimeJournal | undefined
let workDir: string | undefined
let iface = '', subnet = '', address = '', cancelled = ''
let baseline: Snapshot | undefined
let currentIndex: number | undefined
const started = performance.now()
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null && c.pid !== undefined
const ensureBudget = () => { if (cancelled) throw new Error(cancelled); if (performance.now() - started >= BUDGET_MS) throw new Error('lifecycle_budget_exceeded') }
const cancel = (reason: string) => { cancelled ||= reason; if (child && alive(child)) child.kill('SIGKILL') }
const watchdog = setTimeout(() => cancel('lifecycle_budget_exceeded'), BUDGET_MS)
process.on('SIGINT', () => cancel('interrupted'))
process.on('SIGTERM', () => cancel('terminated'))

function command(argv: string[], label: string, timeout = 15_000): Promise<string> {
  ensureBudget()
  return new Promise((resolveCommand, reject) => {
    execFile(exe, argv, { cwd: workDir, windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      // Even synthetic credentials do not belong in a report or CI log.
      if (error) reject(new Error(`${label}_failed`)); else resolveCommand(stdout)
    })
  })
}
async function snapshot(): Promise<Snapshot> {
  const ownedPid = child && alive(child) ? child.pid : undefined
  const identity = ownedPid ? journal?.recordedIdentity(ownedPid) : undefined
  const memory = ownedPid && identity ? `
  $owned=$null
  try {
    $owned=[Diagnostics.Process]::GetProcessById(${ownedPid});$null=$owned.Handle
    $identity=Get-CimInstance Win32_Process -Filter 'ProcessId = ${ownedPid}'
    if($null -ne $identity -and $identity.ExecutablePath -ieq ${quote(identity.path)} -and $identity.CreationDate.ToUniversalTime().ToString('o') -ceq ${quote(identity.started)} -and -not $owned.HasExited){$peak=[double]$owned.PeakWorkingSet64}
  } catch {} finally {if($null -ne $owned){$owned.Dispose()}}
  ` : ''
  const value = await ps<Snapshot>(`$ErrorActionPreference='Stop'
  $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop | ForEach-Object {[pscustomobject]@{index=[int]$_.ifIndex;name=[string]$_.Name;guid=[string]$_.InterfaceGuid;status=[string]$_.Status;mac=[string]$_.MacAddress}})
  $addresses=@(Get-NetIPAddress -ErrorAction Stop | ForEach-Object {[pscustomobject]@{index=[int]$_.InterfaceIndex;address=[string]$_.IPAddress;prefix=[int]$_.PrefixLength;family=[string]$_.AddressFamily}})
  $routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {[pscustomobject]@{index=[int]$_.InterfaceIndex;prefix=[string]$_.DestinationPrefix;nextHop=[string]$_.NextHop;metric=[int]$_.RouteMetric;protocol=[string]$_.Protocol}})
  $dns=@(Get-DnsClientServerAddress -ErrorAction Stop | ForEach-Object {[pscustomobject]@{index=[int]$_.InterfaceIndex;family=[int]$_.AddressFamily;servers=@($_.ServerAddresses | ForEach-Object {[string]$_})}})
  $peak=0;${memory}
  [pscustomobject]@{adapters=@($adapters);addresses=@($addresses);routes=@($routes);dns=@($dns);peakBytes=$peak}|ConvertTo-Json -Compress -Depth 6`, 10_000)
  if (!value || !['adapters', 'addresses', 'routes', 'dns'].every(key => Array.isArray(value[key as keyof Snapshot])) || !value.adapters.length || !Number.isFinite(value.peakBytes)) throw new Error('invalid_native_snapshot')
  for (const rows of [value.adapters, value.addresses, value.routes, value.dns]) {
    // Non-present hidden adapters can legitimately have ifIndex=0.
    if (rows.some(row => !row || !Number.isInteger(row.index) || Number(row.index) < (rows === value.adapters ? 0 : 1))) throw new Error('invalid_native_snapshot_row')
  }
  return value
}
function canonical(rows: Row[]): string { return JSON.stringify(rows.map(row => JSON.stringify(row)).sort()) }
function foreignState(s: Snapshot, ownIndex?: number): string {
  return JSON.stringify({
    adapters: canonical(s.adapters.filter(a => a.name !== iface)),
    addresses: canonical(s.addresses.filter(a => a.index !== ownIndex)),
    routes: canonical(s.routes.filter(a => a.index !== ownIndex)),
    dns: canonical(s.dns.filter(a => a.index !== ownIndex))
  })
}
function assertForeignUnchanged(s: Snapshot, ownIndex?: number): void {
  if (!baseline || foreignState(s, ownIndex) !== foreignState(baseline)) throw new Error('foreign_adapter_route_address_or_dns_changed')
}
function ipv4(s: string): number { return s.split('.').reduce((v, part) => (v * 256 + Number(part)) >>> 0, 0) }
function overlaps(a: string, b: string): boolean {
  if (!/^\d+(?:\.\d+){3}\/\d+$/.test(a) || !/^\d+(?:\.\d+){3}\/\d+$/.test(b)) return false
  const [aa, ap] = a.split('/'), [ba, bp] = b.split('/')
  const bits = Math.min(Number(ap), Number(bp))
  if (!bits) return false // Existing default routes are expected and never modified.
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipv4(aa) & mask) === (ipv4(ba) & mask)
}
function chooseSubnet(s: Snapshot): void {
  for (let attempt = 0; attempt < 128; attempt++) {
    const bytes = randomBytes(3)
    const base = `198.${18 + (bytes[0] & 1)}.${bytes[1]}.${bytes[2] & 252}`
    const candidate = `${base}/30`
    if (s.routes.some(r => overlaps(String(r.prefix), candidate)) || s.addresses.some(a => overlaps(`${a.address}/${a.prefix}`, candidate))) continue
    subnet = candidate; address = base.replace(/\d+$/, String((bytes[2] & 252) + 1)); return
  }
  throw new Error('no_unused_benchmark_subnet')
}
function absent(s: Snapshot): boolean {
  return !s.adapters.some(a => a.name === iface) && !s.addresses.some(a => a.address === address || a.index === currentIndex) &&
    !s.routes.some(r => r.index === currentIndex || overlaps(String(r.prefix), subnet))
}
async function waitRemoved(timeout = 12_000): Promise<void> {
  const until = performance.now() + timeout
  while (true) {
    const s = await snapshot()
    if (absent(s)) { assertForeignUnchanged(s); return }
    if (performance.now() >= until) throw new Error('owned_adapter_or_routes_remain')
    await sleep(150)
  }
}
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    let settled = false
    const finish = (error?: Error | null, port?: number) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error || !port) reject(error || new Error('loopback_port_unavailable')); else resolvePort(port)
    }
    const timer = setTimeout(() => { server.close(); finish(new Error('loopback_port_timeout')) }, 2500)
    server.once('error', error => finish(error))
    server.listen(0, '127.0.0.1', () => {
      const bound = server.address()
      if (!bound || typeof bound === 'string') { server.close(); finish(new Error('loopback_port_unavailable')); return }
      server.close(error => finish(error, bound.port))
    })
  })
}
async function waitReady(api: { port: number; secret: string }, c: ChildProcess): Promise<Snapshot> {
  const until = performance.now() + 15_000
  let apiReady = false
  while (performance.now() < until) {
    ensureBudget()
    if (!alive(c)) throw new Error('core_exited_before_ready')
    if (!apiReady) {
      try {
        const response = await fetch(`http://127.0.0.1:${api.port}/version`, { headers: { Authorization: `Bearer ${api.secret}` }, signal: AbortSignal.timeout(500) })
        const body = response.ok ? await response.json() as { version?: string } : undefined
        apiReady = typeof body?.version === 'string' && body.version.includes(report.engineVersion)
      } catch { /* API is not listening yet. */ }
    }
    if (apiReady) {
      const s = await snapshot()
      const matches = s.adapters.filter(a => a.name === iface)
      if (matches.length > 1) throw new Error('duplicate_owned_adapter')
      if (matches.length === 1) {
        currentIndex = Number(matches[0].index)
        if (currentIndex < 1) throw new Error('owned_adapter_has_no_interface_index')
        if (s.addresses.some(a => a.index === currentIndex && a.address === address && a.prefix === 30)) {
          if (s.routes.some(r => r.index === currentIndex && ['0.0.0.0/0', '::/0'].includes(String(r.prefix)))) throw new Error('unexpected_owned_default_route')
          assertForeignUnchanged(s, currentIndex)
          return s
        }
      }
    }
    await sleep(100)
  }
  throw new Error('api_or_adapter_readiness_timeout')
}
function syntheticProfiles(): Array<[string, Profile]> {
  const client = generateKeyPairSync('x25519'), peer = generateKeyPairSync('x25519')
  const pk = client.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
  const pub = peer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  const conf = (params: string) => `[Interface]\nPrivateKey=${pk}\nAddress=10.77.0.2/32\nDNS=10.77.0.1\n${params}\n[Peer]\nPublicKey=${pub}\nAllowedIPs=0.0.0.0/0\nEndpoint=192.0.2.1:51820\nPersistentKeepalive=0\n`
  const id = randomUUID()
  const links: Array<[string, string]> = [
    ['VLESS', `vless://${id}@192.0.2.1:443?security=tls&type=ws&sni=node.example.invalid&path=%2Ftest`],
    ['VMess', 'vmess://' + Buffer.from(JSON.stringify({ v: '2', add: '192.0.2.1', port: 443, id, aid: 0, net: 'ws', path: '/test', tls: 'tls', sni: 'node.example.invalid' })).toString('base64')],
    ['Trojan', 'trojan://synthetic@192.0.2.1:443?sni=node.example.invalid'],
    ['Shadowsocks', 'ss://' + Buffer.from('aes-256-gcm:synthetic').toString('base64') + '@192.0.2.1:8388'],
    ['Hysteria2', 'hy2://synthetic@192.0.2.1:443?sni=node.example.invalid&obfs=salamander&obfs-password=synthetic-obfs'],
    ['TUIC', `tuic://${id}:synthetic@192.0.2.1:443?sni=node.example.invalid&congestion_control=cubic`]
  ]
  return [
    ['WireGuard', parseConf(conf(''), 'Synthetic WG')],
    ['AWG2', parseConf(conf('Jc=3\nJmin=47\nJmax=199\nS1=145\nS2=45\nS3=46\nS4=22\nH1=100-199\nH2=200-299\nH3=300-399\nH4=400-499\nI1=<r 219>'), 'Synthetic AWG2')],
    ...links.map(([label, link]): [string, Profile] => { const p = parseLink(link); if (!p) throw new Error('synthetic_profile_parse_failed'); return [label, p] }),
    ['OpenVPN', parseOpenVpn(`client\ndev tun\nproto udp\nremote 192.0.2.1 1194\nremote-cert-tls server\npeer-fingerprint ${'1'.repeat(64)}\ndata-ciphers AES-256-GCM:AES-128-GCM\n<auth-user-pass>\nsynthetic-user\nsynthetic-password\n</auth-user-pass>`, 'Synthetic OpenVPN')]
  ]
}
async function protocolChecks(api: { port: number; secret: string }): Promise<void> {
  for (const [label, profile] of syntheticProfiles()) {
    const check: ConfigCheck = { protocol: label, production: false, checker: false }
    report.protocolChecks.push(check)
    const configs = { production: buildConfig([profile], { ...DEFAULTS, rest: profile.id }, { api }), checker: checkConfig([profile], api) }
    for (const kind of ['production', 'checker'] as const) {
      const file = join(workDir!, 'schema.json')
      try {
        writeFileSync(file, JSON.stringify(configs[kind]), { mode: 0o600 })
        await command(['check', '-c', file, '-D', workDir!, '--disable-color'], `${label}_${kind}_schema`)
        check[kind] = true
      } finally { rmSync(file, { force: true }) }
    }
  }
}
async function runCycle(n: number): Promise<void> {
  ensureBudget()
  const result: Cycle = { cycle: n, request: n % 2 ? 'stop' : 'crash', passed: false }
  report.cycles.push(result)
  const api = { port: await freePort(), secret: randomBytes(24).toString('hex') }
  const file = join(workDir!, 'run.json')
  const config = {
    log: { level: 'error' },
    inbounds: [{ type: 'tun', tag: 'synthetic-tun', interface_name: iface, address: [`${address}/30`], mtu: 1400,
      auto_route: false, auto_redirect: false, strict_route: false, dns_mode: 'disabled', stack: 'mixed' }],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct', auto_detect_interface: false, find_process: false },
    experimental: { clash_api: { external_controller: `127.0.0.1:${api.port}`, secret: api.secret } }
  }
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
  try {
    await command(['check', '-c', file, '-D', workDir!, '--disable-color'], 'lifecycle_config')
    const begin = performance.now()
    const c = spawn(exe, ['run', '-c', file, '-D', workDir!, '--disable-color'], { windowsHide: true, cwd: workDir, stdio: 'ignore' })
    child = c
    // Wait for successful creation before querying native identity; no polling of a missing PID.
    await new Promise<void>((resolveSpawn, reject) => { c.once('spawn', resolveSpawn); c.once('error', () => reject(new Error('core_spawn_failed'))) })
    if (!c.pid) throw new Error('core_spawn_failed')
    journal = new RuntimeJournal(workDir!, exe, 'run.json')
    if (!(await journal.record(c.pid))) throw new Error('core_ownership_record_failed')
    const ready = await waitReady(api, c)
    result.startupMs = Math.round(performance.now() - begin)
    result.peakWorkingSetBytes = ready.peakBytes
    result.apiReady = true; result.adapterAndAddressPresent = true; result.foreignNetworkUnchanged = true
    const stopStart = performance.now()
    if (result.request === 'stop') {
      const identity = journal.recordedIdentity(c.pid)
      if (!identity || (await journal.owned(c.pid)) !== 'same') throw new Error('core_ownership_lost_before_stop')
      const sent = await ctrlBreak(c.pid, identity, 5000)
      if (sent) {
        result.stopMethod = 'ctrl-break'
        if (!(await waitExit(c, 3000))) throw new Error('delivered_ctrl_break_did_not_stop_core')
      } else {
        // Production CREATE_NO_WINDOW has no attachable console. Do not count this as graceful.
        result.stopMethod = 'no-console-force'
        if (alive(c) && !c.kill('SIGKILL')) throw new Error('owned_force_stop_failed')
      }
    } else {
      result.stopMethod = 'crash'
      if (!c.kill('SIGKILL')) throw new Error('owned_crash_signal_failed')
    }
    if (!(await waitExit(c, 5000))) throw new Error('owned_child_exit_timeout')
    await waitRemoved()
    result.stopMs = Math.round(performance.now() - stopStart)
    result.adapterAndRoutesRemoved = true
    if (!journal.clear()) throw new Error('owned_config_cleanup_failed')
    child = undefined; journal = undefined; currentIndex = undefined
    result.passed = true; report.completedCycles++
    console.log(`Windows lifecycle ${n}/${CYCLES}: PASS (${result.stopMethod}; start ${result.startupMs} ms; stop ${result.stopMs} ms)`)
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'cycle_failed'
    throw error // A bad cycle fails the gate and starts bounded cleanup immediately.
  }
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}
async function main(): Promise<void> {
  try {
    if (process.platform !== 'win32' || !args.includes('--disposable-windows')) throw new Error('requires_windows_and_explicit_disposable_windows_flag')
    const allowed = args.filter((_, i) => i !== reportAt && (reportAt < 0 || i !== reportAt + 1))
    if (allowed.some(a => a !== '--disposable-windows') || (reportAt >= 0 && (!args[reportAt + 1] || args[reportAt + 1].startsWith('--')))) throw new Error('invalid_arguments')
    report.elevated = await isAdmin()
    if (!report.elevated) throw new Error('requires_elevated_disposable_vm')
    if (!verifyEngine(exe)) throw new Error('pinned_engine_integrity_failed')
    report.engineIntegrityVerified = true
    const manifest = JSON.parse(readFileSync(join(dirname(exe), 'integrity.json'), 'utf8')) as { version?: unknown; 'sing-box.exe'?: string }
    if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+-lx\.\d+$/.test(manifest.version)) throw new Error('invalid_engine_manifest_version')
    report.engineVersion = manifest.version
    report.engineSha256 = manifest['sing-box.exe'] || ''
    const version = await command(['version'], 'engine_version')
    if (!version.includes(`sing-box version ${report.engineVersion}`)) throw new Error('pinned_engine_version_mismatch')
    report.engineGoVersion = /\bgo\d+\.\d+(?:\.\d+)?\b/.exec(version)?.[0] ?? null
    workDir = mkdtempSync(join(tmpdir(), 'waarp-native-ci-'))
    iface = `WCI${randomBytes(5).toString('hex')}`
    baseline = await snapshot()
    if (baseline.adapters.some(a => a.name === iface)) throw new Error('interface_name_collision')
    chooseSubnet(baseline)
    await protocolChecks({ port: await freePort(), secret: randomBytes(24).toString('hex') })
    assertForeignUnchanged(await snapshot())
    for (let n = 1; n <= CYCLES; n++) await runCycle(n)
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : 'lifecycle_failed')
  } finally {
    clearTimeout(watchdog)
    if (child && alive(child)) {
      child.kill('SIGKILL') // Only the exact ChildProcess handle; never taskkill/name/PID tree kills.
      report.cleanup.childExited = await waitExit(child, 5000)
    } else report.cleanup.childExited = true
    if (baseline && iface && report.cleanup.childExited) {
      try {
        await waitRemoved(12_000)
        report.cleanup.adapterAndRoutesRemoved = true; report.cleanup.foreignNetworkUnchanged = true
      } catch (error) { report.errors.push(error instanceof Error ? error.message : 'native_cleanup_failed') }
    }
    if (workDir && report.cleanup.childExited) {
      try {
        if (journal && !journal.clear()) throw new Error('owned_config_cleanup_failed')
        rmSync(workDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        report.cleanup.temporaryFilesRemoved = true
      } catch { report.errors.push('temporary_files_cleanup_failed') }
    }
    if (cancelled && !report.errors.includes(cancelled)) report.errors.push(cancelled)
    const starts = report.cycles.flatMap(c => c.startupMs === undefined ? [] : [c.startupMs])
    const stops = report.cycles.flatMap(c => c.stopMs === undefined ? [] : [c.stopMs])
    const memory = report.cycles.flatMap(c => c.peakWorkingSetBytes ? [c.peakWorkingSetBytes] : [])
    report.metrics = { startupP50Ms: percentile(starts, .5), startupP95Ms: percentile(starts, .95), stopP50Ms: percentile(stops, .5), stopP95Ms: percentile(stops, .95), peakWorkingSetBytes: memory.length ? Math.max(...memory) : null }
    report.elapsedMs = Math.round(performance.now() - started)
    report.passed = !report.errors.length && report.completedCycles === CYCLES && report.cycles.every(c => c.passed) && Object.values(report.cleanup).every(Boolean)
    try { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
    catch { report.passed = false; console.error('Unable to write lifecycle report') }
    console.log(`Native Windows lifecycle: ${report.passed ? 'PASS' : 'FAIL'}; ${report.completedCycles}/${CYCLES} cycles; ${report.errors.join(', ') || 'no errors'}`)
    process.exitCode = report.passed ? 0 : 1
  }
}
void main()
