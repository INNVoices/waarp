import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fixture } from './route-native-fixtures'

// No TUN, route changes, public endpoints or elevated privileges. This tests
// exact-core selector semantics; it does not claim WAN/app-session migration.
const CORE_VERSION = '1.14.2-lx.11'
const CORE_REVISION = '3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d'
const CONTRACT = {
  scope: 'Loopback SOCKS/TCP/UDP selector semantics; no TUN, WAN failover or Android AAR claim',
  selector: `https://github.com/Leadaxe/sing-box-lx/blob/${CORE_REVISION}/protocol/group/selector.go`,
  socksAssociation: 'https://github.com/SagerNet/sing/blob/0ad23b637bd4/protocol/socks/packet.go',
  strict: 'Closes both old TCP and SOCKS UDP association; a new association must use B',
  soft: 'Preserves old TCP/UDP through A; new TCP/UDP must use B'
}
type Progress = (stage: string) => void
const noProgress: Progress = () => {}
const socketState = (socket?: net.Socket) => socket ? {
  destroyed: socket.destroyed, readableEnded: socket.readableEnded, readableLength: socket.readableLength,
  bytesRead: socket.bytesRead, bytesWritten: socket.bytesWritten
} : undefined
const errorText = (error: unknown) => (error instanceof Error ? error.name + ': ' + error.message : String(error)).slice(0, 1200)
function evidence(name: string, report: object) {
  mkdirSync('out/validation', { recursive: true })
  const complete = { platform: process.platform, arch: process.arch, core: CORE_VERSION, sourceRevision: CORE_REVISION,
    at: new Date().toISOString(), contract: CONTRACT, ...report }
  writeFileSync(join('out/validation', name), JSON.stringify(complete, null, 2) + '\n')
  return complete
}
async function read(socket: net.Socket, bytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(4000)
  try {
    for (;;) {
      const data = socket.read(bytes) as Buffer | null
      if (data) { assert.equal(data.length, bytes); return data }
      assert(!socket.destroyed && !socket.readableEnded, 'fixture socket closed before expected bytes')
      await once(socket, 'readable', { signal })
    }
  } catch (error) {
    throw new Error(`read ${bytes} bytes; socket=${JSON.stringify(socketState(socket))}; ${errorText(error)}`)
  }
}
async function closed(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return
  // A reset is an allowed strict interruption, but it must actually close.
  // events.once('close') also rejects on 'error', which would confuse reset with a failed assertion.
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { socket.off('close', done); reject(new Error('socket did not close: ' + JSON.stringify(socketState(socket)))) }, 4000)
    socket.once('close', done); socket.resume()
  })
  assert(socket.destroyed, 'strict interruption closed the socket')
}
async function socks(port: number, command: 1 | 3, host: number[], destinationPort: number, progress: Progress = noProgress) {
  progress('connect')
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(4000) })
    progress('auth')
    socket.write(Buffer.from([5, 1, 0]))
    assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]))
    progress('request-reply')
    socket.write(Buffer.from([5, command, 0, 1, ...host, destinationPort >>> 8, destinationPort & 255]))
    const reply = await read(socket, 4)
    assert.equal(reply[1], 0, 'SOCKS request accepted')
    assert(reply[3] === 1 || reply[3] === 4, 'fixture expects IP-bound SOCKS response')
    progress('bound-address')
    const address = await read(socket, reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : 0)
    assert(address.length >= 6, 'fixture expects IP-bound SOCKS response')
    return { socket, port: address.readUInt16BE(address.length - 2) }
  } catch (error) { socket.destroy(); throw error }
}
async function freePort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function httpBody(port: number, progress: Progress = noProgress): Promise<string> {
  const { socket } = await socks(port, 1, [198, 18, 0, 9], 80, stage => progress('socks/' + stage))
  try {
    progress('request-body')
    socket.write('GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n')
    let result = ''
    socket.setTimeout(4000, () => socket.destroy(new Error('fixture HTTP timeout')))
    for await (const chunk of socket) result += chunk.toString()
    return result.split('\r\n\r\n')[1]
  } finally { socket.destroy() }
}
async function udpClient(port: number, progress: Progress = noProgress) {
  progress('bind')
  const socket = dgram.createSocket('udp4')
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening')
  let control: net.Socket | undefined
  try {
    const associated = await socks(port, 3, [127, 0, 0, 1], (socket.address() as net.AddressInfo).port, stage => progress('socks/' + stage))
    control = associated.socket
    return {
      control,
      exchange: async (text: string) => {
        progress('exchange-' + text)
        const answer = once(socket, 'message', { signal: AbortSignal.timeout(4000) })
        const packet = Buffer.concat([Buffer.from([0, 0, 0, 1, 198, 18, 0, 9, 0x9c, 0x40]), Buffer.from(text)])
        socket.send(packet, associated.port, '127.0.0.1')
        const [data] = await answer
        assert(data.length >= 10)
        return (data as Buffer).subarray(10).toString()
      },
      close: () => { control?.destroy(); socket.close() }
    }
  } catch (error) { control?.destroy(); socket.close(); throw error }
}

async function scenario(exe: string, interrupt: boolean) {
  const mode = interrupt ? 'strict' : 'soft', began = performance.now()
  let stage = 'prepare-fixtures'
  const stages: { stage: string; ms: number }[] = []
  const progress: Progress = next => {
    stage = next; stages.push({ stage, ms: Math.round(performance.now() - began) })
    if (stages.length > 80) stages.shift()
    console.log('CONTINUITY_NATIVE', mode, stage)
  }
  const scoped = (name: string): Progress => part => progress(name + '/' + part)
  progress(stage)
  const dir = mkdtempSync(join(tmpdir(), 'waarp-selector-proof-'))
  const a = await fixture('A'), b = await fixture('B')
  const port = await freePort(), api = await freePort(), secret = randomBytes(16).toString('hex')
  const config = {
    log: { level: 'info', timestamp: false },
    inbounds: [{ type: 'mixed', tag: 'fixture', listen: '127.0.0.1', listen_port: port }],
    outbounds: [
      { type: 'socks', tag: 'a', server: '127.0.0.1', server_port: a.port, version: '5' },
      { type: 'socks', tag: 'b', server: '127.0.0.1', server_port: b.port, version: '5' },
      { type: 'selector', tag: 'choice', outbounds: ['a', 'b'], default: 'a', interrupt_exist_connections: interrupt }
    ],
    route: { final: 'choice' },
    experimental: { clash_api: { external_controller: '127.0.0.1:' + api, secret } }
  }
  const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify(config))
  const core = spawn(exe, ['run', '-c', file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', startedError: Error | undefined
  core.on('error', error => { startedError = error })
  const capture = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-6000) }
  core.stderr?.on('data', capture); core.stdout?.on('data', capture)
  const headers = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }
  const request = (path: string, init?: RequestInit) => fetch('http://127.0.0.1:' + api + path,
    { ...init, headers, signal: AbortSignal.timeout(3000) })
  let tcp: net.Socket | undefined, udp: Awaited<ReturnType<typeof udpClient>> | undefined, newUdp: Awaited<ReturnType<typeof udpClient>> | undefined
  try {
    progress('core-ready')
    const deadline = Date.now() + 8000
    let ready = false
    while (Date.now() < deadline && core.exitCode === null && !startedError) {
      ready = await request('/version').then(response => response.ok).catch(() => false)
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(ready, startedError?.message ?? log)
    assert.equal(await httpBody(port, scoped('initial-http')), 'A')
    tcp = (await socks(port, 1, [198, 18, 0, 10], 80, scoped('tcp-open'))).socket
    const echo = async (label: string) => { progress('tcp-echo-' + label); const data = Buffer.from('PING-' + label); tcp!.write(data); assert.deepEqual(await read(tcp!, data.length), data) }
    udp = await udpClient(port, scoped('udp-open'))
    await echo('before'); assert.equal(await udp.exchange('before'), 'A:before')
    const before = performance.now()
    progress('selector-put')
    assert((await request('/proxies/choice', { method: 'PUT', body: JSON.stringify({ name: 'b' }) })).ok)
    progress('selector-get-ack')
    const selection = await (await request('/proxies/choice')).json()
    assert.equal(selection.now, 'b')
    const selectorAckMs = performance.now() - before
    progress('selector-acknowledged-b')
    let retainedTcp = false, retainedUdp = false
    if (!interrupt) {
      for (let n = 0; n < 6; n++) {
        await echo('after-' + n)
        assert.equal(await udp.exchange('after-' + n), 'A:after-' + n)
      }
      retainedTcp = retainedUdp = true
      assert.equal(b.received.udp, 0, 'soft switch kept every old UDP request on A')
    } else {
      progress('strict-close-old-tcp')
      await closed(tcp)
      assert(tcp.destroyed, 'strict selector interrupts the old external TCP stream')
      progress('strict-close-old-udp-association')
      // The pinned selector closes the inbound PacketConn. AssociatePacketConn
      // closes its UDP socket and control TCP together (see CONTRACT source pins).
      // Reusing that destroyed association cannot test the next selected path.
      await closed(udp.control)
      assert(udp.control.destroyed, 'strict selector interrupts the old SOCKS UDP association')
    }
    newUdp = await udpClient(port, scoped('new-udp-association'))
    assert.equal(await newUdp.exchange('new-flow'), 'B:new-flow', 'new UDP association uses acknowledged selection')
    assert.equal(await httpBody(port, scoped('new-http')), 'B', 'new TCP flow uses acknowledged selection')
    assert(a.received.udp > 0 && b.received.udp > 0)
    progress('passed')
    return { interruptExisting: interrupt, retainedTcp, retainedUdp, oldUdpAssociationClosed: udp.control.destroyed,
      newHttpExit: 'B', newUdpExit: 'B', selectorAckMs: Math.round(selectorAckMs * 100) / 100,
      udpRequests: { a: a.received.udp, b: b.received.udp }, stages }
  } catch (error) {
    const report = evidence(`continuity-native-${mode}-failed.json`, { status: 'failed', mode, stage, stages,
      error: errorText(error).replaceAll(secret, '[secret]'),
      coreExit: core.exitCode, coreSignal: core.signalCode,
      tcp: socketState(tcp), udpControl: socketState(udp?.control), newUdpControl: socketState(newUdp?.control),
      fixtures: { a: { received: a.received, requests: a.requests }, b: { received: b.received, requests: b.requests } },
      nativeLog: log.replace(/\x1b\[[0-9;]*m/g, '').replaceAll(secret, '[secret]').replaceAll(dir, '[fixture-dir]') })
    console.error('CONTINUITY_NATIVE failed evidence', JSON.stringify(report))
    throw new Error(`${mode} failed at ${stage}: ${errorText(error).replaceAll(secret, '[secret]')}`)
  } finally {
    tcp?.destroy(); udp?.close(); newUdp?.close()
    if (core.exitCode === null) {
      const exit = once(core, 'exit', { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
      core.kill(); await exit
      if (core.exitCode === null && core.signalCode === null) core.kill('SIGKILL')
    }
    await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true })
  }
}
async function main() {
  if (process.env.WAARP_CONTINUITY_NATIVE_TEST !== '1') {
    console.log('[SKIP] continuity-native: explicit native loopback opt-in required'); return
  }
  const exe = process.env.WAARP_CONTINUITY_NATIVE_EXE ?? join(process.cwd(), 'engine', 'sing-box.exe')
  const results: Awaited<ReturnType<typeof scenario>>[] = []
  let stage = 'engine-version'
  try {
    const version = execFileSync(exe, ['version'], { encoding: 'utf8', timeout: 5000 })
    assert(version.includes(CORE_VERSION) && version.includes(CORE_REVISION), 'use the pinned desktop engine')
    for (const interrupt of [false, true]) { stage = interrupt ? 'strict-scenario' : 'soft-scenario'; results.push(await scenario(exe, interrupt)) }
    const report = evidence('continuity-native.json', { status: 'passed', results })
    console.log('continuity-native PASS', JSON.stringify(report))
  } catch (error) {
    const report = evidence('continuity-native-failed.json', { status: 'failed', stage, error: errorText(error), completed: results })
    console.error('continuity-native FAIL', JSON.stringify(report))
    throw error
  }
}
void main().catch(error => { console.error(errorText(error)); process.exitCode = 1 })
