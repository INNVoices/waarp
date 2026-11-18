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
async function read(socket: net.Socket, bytes: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(4000)
  for (;;) {
    const data = socket.read(bytes) as Buffer | null
    if (data) { assert.equal(data.length, bytes); return data }
    assert(!socket.destroyed, 'fixture socket closed')
    await once(socket, 'readable', { signal })
  }
}
async function socks(port: number, command: 1 | 3, host: number[], destinationPort: number) {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(4000) })
    socket.write(Buffer.from([5, 1, 0]))
    assert.deepEqual(await read(socket, 2), Buffer.from([5, 0]))
    socket.write(Buffer.from([5, command, 0, 1, ...host, destinationPort >>> 8, destinationPort & 255]))
    const reply = await read(socket, 4)
    assert.equal(reply[1], 0, 'SOCKS request accepted')
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
async function httpBody(port: number): Promise<string> {
  const { socket } = await socks(port, 1, [198, 18, 0, 9], 80)
  try {
    socket.write('GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n')
    let result = ''
    socket.setTimeout(4000, () => socket.destroy(new Error('fixture HTTP timeout')))
    for await (const chunk of socket) result += chunk.toString()
    return result.split('\r\n\r\n')[1]
  } finally { socket.destroy() }
}
async function udpClient(port: number) {
  const socket = dgram.createSocket('udp4')
  socket.bind(0, '127.0.0.1'); await once(socket, 'listening')
  let control: net.Socket | undefined
  try {
    const associated = await socks(port, 3, [127, 0, 0, 1], (socket.address() as net.AddressInfo).port)
    control = associated.socket
    return {
      exchange: async (text: string) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'waarp-selector-proof-'))
  const a = await fixture('A'), b = await fixture('B')
  const port = await freePort(), api = await freePort(), secret = randomBytes(16).toString('hex')
  const config = {
    log: { level: 'error' },
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
  core.stderr?.on('data', chunk => { log = (log + chunk.toString()).slice(-3000) })
  const headers = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }
  const request = (path: string, init?: RequestInit) => fetch('http://127.0.0.1:' + api + path,
    { ...init, headers, signal: AbortSignal.timeout(3000) })
  let tcp: net.Socket | undefined, udp: Awaited<ReturnType<typeof udpClient>> | undefined
  try {
    const deadline = Date.now() + 8000
    let ready = false
    while (Date.now() < deadline && core.exitCode === null && !startedError) {
      ready = await request('/version').then(response => response.ok).catch(() => false)
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(ready, startedError?.message ?? log)
    assert.equal(await httpBody(port), 'A')
    tcp = (await socks(port, 1, [198, 18, 0, 10], 80)).socket
    const echo = async (label: string) => { const data = Buffer.from('PING-' + label); tcp!.write(data); assert.deepEqual(await read(tcp!, data.length), data) }
    udp = await udpClient(port)
    await echo('before'); assert.equal(await udp.exchange('before'), 'A:before')
    const before = performance.now()
    assert((await request('/proxies/choice', { method: 'PUT', body: JSON.stringify({ name: 'b' }) })).ok)
    const selection = await (await request('/proxies/choice')).json()
    assert.equal(selection.now, 'b')
    const selectorAckMs = performance.now() - before
    let retainedTcp = false, retainedUdp = false
    if (!interrupt) {
      for (let n = 0; n < 6; n++) {
        await echo('after-' + n)
        assert.equal(await udp.exchange('after-' + n), 'A:after-' + n)
      }
      retainedTcp = retainedUdp = true
    } else {
      if (!tcp.destroyed) {
        const closed = once(tcp, 'close', { signal: AbortSignal.timeout(4000) })
        tcp.resume(); await closed
      }
      assert(tcp.destroyed, 'strict selector interrupts the old external TCP stream')
      // The next UDP datagram may create a new packet connection. Do not infer
      // application-session continuity from it; only record the observed exit.
      assert.equal(await udp.exchange('after-hard'), 'B:after-hard')
    }
    assert.equal(await httpBody(port), 'B', 'new flow uses acknowledged selection')
    assert(a.received.udp > 0 && (interrupt ? b.received.udp > 0 : b.received.udp === 0))
    return { interruptExisting: interrupt, retainedTcp, retainedUdp, newHttpExit: 'B',
      selectorAckMs: Math.round(selectorAckMs * 100) / 100, udpRequests: { a: a.received.udp, b: b.received.udp } }
  } finally {
    tcp?.destroy(); udp?.close()
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
  const version = execFileSync(exe, ['version'], { encoding: 'utf8', timeout: 5000 })
  assert(version.includes('1.14.2-lx.11') && version.includes('3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d'), 'use the pinned desktop engine')
  const results = [await scenario(exe, false), await scenario(exe, true)]
  const report = { platform: process.platform, arch: process.arch, core: '1.14.2-lx.11',
    sourceRevision: '3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d', at: new Date().toISOString(),
    scope: 'Loopback SOCKS/TCP/UDP selector semantics; no TUN, WAN failover or Android AAR claim', results }
  mkdirSync('out/validation', { recursive: true })
  writeFileSync('out/validation/continuity-native.json', JSON.stringify(report, null, 2) + '\n')
  console.log('continuity-native PASS', JSON.stringify(report))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
