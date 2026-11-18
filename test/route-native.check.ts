import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { Checker } from '../src/main/checker'
import type { OutProfile, Profile, Settings } from '../src/shared/types'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'
import { fixture, datagram, nativeDns } from './route-native-fixtures'
import { installNativeTestCA } from './route-native-trust'
import { redactVless } from '../src/main/vless'

function body(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port: 80, path: '/', agent: false }, response => {
      let output = ''; response.setEncoding('utf8'); response.on('data', chunk => { output += chunk })
      response.on('end', () => resolve(output)); response.on('error', reject)
    })
    request.setTimeout(6000, () => request.destroy(new Error('fixture request timed out')))
    request.on('error', reject)
  })
}
function proxyBody(proxy: DiagnosticTransport): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: '198.18.0.11:80',
      headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64') }, signal: proxy.signal, agent: false })
    request.on('error', reject)
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error('diagnostic proxy refused authentication')); return }
      let output = head.toString()
      socket.setTimeout(6000, () => socket.destroy(new Error('diagnostic proxy fixture timed out')))
      socket.on('error', reject); socket.on('data', data => { output += data.toString() })
      socket.once('end', () => resolve(output.split('\r\n\r\n')[1]))
      socket.write('GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n')
    })
    request.setTimeout(6000, () => request.destroy(new Error('diagnostic CONNECT timeout')))
    request.end()
  })
}
async function main() {
  if (process.env.WAARP_NATIVE_SWITCH_TEST !== '1') { console.log('route-native: SKIP (explicit disposable Windows opt-in required)'); return }
  assert.equal(process.platform, 'win32'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const dir = mkdtempSync(join(tmpdir(), 'waarp-route-native-'))
  const a = await fixture('A'), b = await fixture('B'), c = await fixture('C', { https: true })
  const profile = (id: string, port: number): OutProfile => ({ kind: 'out', id, name: id, host: '127.0.0.1', port,
    version: 'SOCKS fixture', source: 'personal', addedAt: 1,
    outbound: { type: 'socks', server: '127.0.0.1', server_port: port, version: '5' } })
  const profiles = [profile('a', a.port), profile('b', b.port)]
  let settings: Settings = { rest: 'direct', routes: [
    { id: 'selected', kind: 'custom', name: 'Selected', value: '198.18.0.9', via: 'a', on: true },
    { id: 'neighbor', kind: 'custom', name: 'Neighbor', value: '198.18.0.10', via: 'a', on: true }
  ], groups: [], lanDirect: false, ruDirect: false, dnsAll: false, notify: false, tray: true, autoConnect: false, autostart: false }
  const engine = new Engine(join(process.cwd(), 'engine', 'sing-box.exe'), dir, 'C:\\waarp-test-never.exe')
  // Test only the controlled fixtures. No public health requests are needed.
  ;(engine as any).pingAll = async () => ({ a: 1, b: 2 })
  engine.hostV6 = async () => false
  // Production pins/rejects public endpoints; this disposable native test deliberately uses only its loopback fixture.
  ;(engine as any).relays.preparePublic = async (candidate: Profile) => {
    assert.equal(candidate.id, 'late-public'); assert.equal(candidate.kind, 'out')
    const checked = candidate as OutProfile
    assert.equal(checked.host, '127.0.0.1'); assert.equal(checked.port, c.port)
    return structuredClone(candidate)
  }
  let neighbor: net.Socket | undefined
  let trust: Awaited<ReturnType<typeof installNativeTestCA>> | undefined
  // Clash API replaces plain http:// probe URLs with its external HTTPS
  // default. Use real HTTPS here so it measures precisely this local fixture.
  const originalPings = Checker.prototype.pings
  Checker.prototype.pings = async function () {
    const state = this as unknown as { api: { port: number; secret: string }; ids: string[];
      child?: ChildProcess; diagnostic?: { username: string; password: string } }
    const known = [state.api.secret, state.diagnostic?.username, state.diagnostic?.password].filter((value): value is string => !!value)
    const nativeFetch = globalThis.fetch, responses: { status?: number; body?: string; error?: string }[] = []
    let logs = '', result: Record<string, number | null> = {}
    const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000) }
    state.child?.stdout?.on('data', capture); state.child?.stderr?.on('data', capture)
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const measured = url.hostname === '127.0.0.1' && url.port === String(state.api.port) && url.pathname.endsWith('/delay')
      try {
        const response = await nativeFetch(input, init)
        if (measured) responses.push({ status: response.status, body: redactVless(await response.clone().text(), known).slice(0, 512) })
        return response
      } catch (error) { if (measured) responses.push({ error: redactVless(String(error), known) }); throw error }
    }
    try { result = await this.probe('https://198.18.0.11') }
    finally {
      globalThis.fetch = nativeFetch
      state.child?.stdout?.off('data', capture); state.child?.stderr?.off('data', capture)
      console.log('ROUTE_NATIVE readiness evidence', JSON.stringify({ ids: state.ids, result, responses,
        fixtureCA: trust?.thumbprint, received: c.received, requests: c.requests, tlsErrors: c.tlsErrors,
        workerLogs: redactVless(logs, known) }))
    }
    return Object.fromEntries(Object.entries(result).map(([id, ms]) => [id, ms ?? undefined]))
  }
  try {
    trust = await installNativeTestCA(dir)
    assert(await engine.killOrphans())
    await engine.start(profiles, settings)
    assert.equal(engine.status.phase, 'on', engine.status.error ?? 'core not ready')
    const pid = (engine as any).child.pid, since = engine.status.since
    assert.equal(await body('198.18.0.9'), 'A')
    assert.equal(await engine.withHttpProxy('b', new AbortController().signal, proxyBody), 'B')
    assert.equal(await body('198.18.0.9'), 'A', 'diagnostic selection does not change the card')
    await assert.rejects(engine.withHttpProxy('b', new AbortController().signal, proxy => proxyBody({ ...proxy, password: 'wrong' })))
    console.log('ROUTE_NATIVE authenticated diagnostic CONNECT: selected B; card A preserved PASS')
    neighbor = net.connect(80, '198.18.0.10'); neighbor.on('error', () => {})
    await new Promise<void>((resolve, reject) => { neighbor!.once('connect', resolve); neighbor!.once('error', reject) })
    const echo = (n: number) => new Promise<void>((resolve, reject) => {
      const expected = Buffer.from('PING' + n)
      const timeout = setTimeout(() => { cleanup(); reject(new Error('neighbor echo timeout')) }, 6000)
      let received = Buffer.alloc(0)
      const cleanup = () => { clearTimeout(timeout); neighbor!.off('data', onData); neighbor!.off('close', onClose) }
      const onClose = () => { cleanup(); reject(new Error('neighbor closed during unrelated route edit')) }
      const onData = (data: Buffer) => { received = Buffer.concat([received,data]); if (received.length >= expected.length) {
        cleanup(); try { assert.deepEqual(received, expected); resolve() } catch (error) { reject(error) }
      } }
      neighbor!.on('data', onData); neighbor!.once('close', onClose); neighbor!.write(expected)
    })
    await echo(0)
    for (const [i, via] of ['b','a','direct','b'].entries()) {
      settings = { ...settings, routes: settings.routes.map(r => r.id === 'selected' ? { ...r, via } : r) }
      assert(await engine.applyLive(profiles, settings), 'switch to ' + via + '\n' + engine.log().join('\n'))
      assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since)
      if (via !== 'direct') assert.equal(await body('198.18.0.9'), via.toUpperCase())
      await echo(i + 1)
      console.log('ROUTE_NATIVE switch', via, 'same PID; neighbor alive; selected tunnel verified where applicable')
    }
    // Import a public profile after startup: it was never in the primary core graph.
    const late = { ...profile('late-public', c.port), source: 'public' as const }
    profiles.push(late)
    settings = { ...settings, routes: settings.routes.map(r => r.id === 'selected' ? { ...r, via: late.id } : r) }
    assert(await engine.applyLive(profiles, settings), engine.log().join('\n') + '\n' + JSON.stringify({
      fixtureCA: trust.thumbprint, received: c.received, requests: c.requests, tlsErrors: c.tlsErrors
    }))
    assert(c.received.httpsHead > 0, 'real native readiness verified HTTPS and received its HEAD response')
    assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since)
    assert.equal(await body('198.18.0.9'), 'C', 'late selected public server carries real TCP payload')
    assert.equal(await engine.withHttpProxy(late.id, new AbortController().signal, proxyBody), 'C')
    console.log('ROUTE_NATIVE late C selected TCP and authenticated diagnostic payload PASS')
    const udpPayload = Buffer.from('selected-public-native-udp')
    assert.equal((await datagram('198.18.0.9', 40000, udpPayload)).toString(), 'C:' + udpPayload.toString(),
      'late selected server carries real UDP through main TUN and the native loopback worker')
    assert(c.received.udp > 0, 'selected C fixture received the UDP datagram')
    assert.equal(a.received.udp, 0); assert.equal(b.received.udp, 0)
    console.log('ROUTE_NATIVE late C main-TUN UDP round trip and selected-only receiver PASS')
    console.log('ROUTE_NATIVE starting generated no-TUN UoT DNS request')
    await nativeDns(join(process.cwd(), 'engine', 'sing-box.exe'), join(dir, 'dns-fixture'), late)
    assert(c.received.dns > 0, 'worker hijack DNS request reached its selected profile resolver')
    console.log('ROUTE_NATIVE generated no-TUN UoT DNS answer and worker cleanup PASS')
    assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since)
    await echo(20)
    console.log('ROUTE_NATIVE newly imported public server: same main PID/TUN; selected TCP and UDP payload C; neighbor alive PASS')
    settings = { ...settings, routes: settings.routes.map(r => r.id === 'selected' ? { ...r, via: 'b' } : r) }
    assert(await engine.applyLive(profiles, settings)); assert.equal(await body('198.18.0.9'), 'B'); await echo(21)
    settings = { ...settings, routes: settings.routes.filter(r => r.id !== 'selected') }
    assert(await engine.applyLive(profiles, settings)); await echo(5)
    assert.equal((engine as any).child.pid, pid)
    console.log('ROUTE_NATIVE delete active selected route: same PID and neighbor alive PASS')
    settings = { ...settings, routes: [...settings.routes, { id:'disabled',kind:'custom',name:'Off',value:'198.18.0.11',via:'b',on:false }] }
    assert(await engine.applyLive(profiles, settings)); await echo(6)
    settings = { ...settings, routes: settings.routes.filter(r => r.id !== 'disabled') }
    assert(await engine.applyLive(profiles, settings)); await echo(7)
    assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since)
    console.log('ROUTE_NATIVE inactive addition/deletion: same PID and neighbor alive PASS')
    neighbor.destroy(); neighbor = undefined
    settings = { ...settings, routes: [] }
    assert(await engine.applyLive(profiles, settings))
    assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since); assert.equal(engine.status.phase, 'on')
    settings = { ...settings, routes: [{ id: 'again', kind: 'custom', name: 'Again', value: '198.18.0.9', via: 'b', on: true }] }
    assert(await engine.applyLive(profiles, settings)); assert.equal(await body('198.18.0.9'), 'B')
    assert.equal((engine as any).child.pid, pid); assert.equal(engine.status.since, since)
    console.log('ROUTE_NATIVE last-route removal and re-addition: same PID and new selected path verified PASS')
  } finally {
    neighbor?.destroy()
    try { assert(await engine.stop(), 'native cleanup must complete') }
    finally {
      Checker.prototype.pings = originalPings
      let trustClean = false
      try { if (trust) { await trust.remove(); trustClean = true } }
      finally {
        await a.close(); await b.close(); await c.close()
        if (trustClean) rmSync(dir, { recursive:true, force:true })
      }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
