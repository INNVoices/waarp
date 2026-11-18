import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { OutProfile } from '../src/shared/types'
import { checkConfig, tagOf } from '../src/main/awg'
import { RELAY_DNS_IP, relayOutbounds } from '../src/main/relay-config'
import { pickPort, waitReady } from '../src/main/tun'
import { waitExit } from '../src/main/stop'

/** Controlled SOCKS5 server: it never opens an Internet socket. TCP and UDP
 * replies identify the selected fixture, making direct fallback fail the test. */
export async function fixture(label: string) {
  const sockets = new Set<net.Socket>(), datagrams = new Set<dgram.Socket>()
  const received = { udp: 0, dns: 0, head: 0 }
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket))
    let stage = 0, data = Buffer.alloc(0)
    socket.on('data', chunk => {
      data = Buffer.concat([data, typeof chunk === 'string' ? Buffer.from(chunk) : chunk])
      if (data.length > 8192) { socket.destroy(); return }
      if (stage === 0) {
        if (data.length < 2 || data.length < 2 + data[1]) return
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]).includes(0)) { socket.destroy(); return }
        data = data.subarray(2 + data[1]); socket.write(Buffer.from([5, 0])); stage = 1
      }
      if (stage === 1) {
        if (data.length < 5) return
        const length = data[3] === 1 ? 10 : data[3] === 4 ? 22 : data[3] === 3 ? 7 + data[4] : 0
        if (!length) { socket.destroy(); return }
        if (data.length < length) return
        const command = data[1]
        data = data.subarray(length)
        if (command === 3) {
          stage = 3
          const udp = dgram.createSocket('udp4'); datagrams.add(udp)
          const close = () => { try { udp.close() } catch {} }
          udp.on('error', () => socket.destroy())
          udp.once('close', () => { datagrams.delete(udp); socket.off('close', close) })
          socket.once('close', close)
          udp.on('message', (packet, peer) => {
            // Only the exact IPv4 fixture destinations are accepted; no forwarding.
            if (peer.address !== '127.0.0.1' || packet.length < 10 || !packet.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))) return
            const host = [...packet.subarray(4, 8)].join('.'), port = packet.readUInt16BE(8)
            const payload = packet.subarray(10)
            let reply: Buffer
            if (host === '198.18.0.53' && port === 53) {
              const answer = dnsAnswer(payload)
              if (!answer) return
              received.dns++; reply = answer
            } else if (host === '198.18.0.9' && port === 40000) {
              received.udp++; reply = Buffer.concat([Buffer.from(label + ':'), payload])
            } else return
            udp.send(Buffer.concat([packet.subarray(0, 10), reply]), peer.port, peer.address)
          })
          udp.bind(0, '127.0.0.1', () => {
            if (socket.destroyed) { close(); return }
            const port = (udp.address() as net.AddressInfo).port
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >>> 8, port & 255]))
          })
          return
        }
        if (command !== 1) { socket.destroy(); return }
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); stage = 2
      }
      if (stage === 2 && data.length) {
        const request = data.toString()
        if (request.startsWith('GET ') || request.startsWith('HEAD ')) {
          if (!data.includes(Buffer.from('\r\n\r\n'))) return
          // The pinned core's URLTest sends HEAD. Keep its actual native
          // readiness measurement; answer HEAD with GET headers and no body.
          const head = request.startsWith('HEAD ')
          if (head) received.head++
          socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ' + label.length + '\r\n\r\n' + (head ? '' : label))
        } else if (request.startsWith('PING')) { socket.write(data); data = Buffer.alloc(0) }
        else if (data.length > 64) socket.destroy()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as net.AddressInfo).port, received, close: async () => {
    for (const socket of sockets) socket.destroy()
    for (const udp of datagrams) { try { udp.close() } catch {} }
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

export const dnsQuestion = () => Buffer.concat([
  Buffer.from([0x57, 0x52, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
  ...'dns.fixture.invalid'.split('.').map(part => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
  Buffer.from([0, 0, 1, 0, 1])
])

function dnsAnswer(query: Buffer): Buffer | undefined {
  const expected = dnsQuestion()
  // A resolver chooses its own transaction ID; the question itself must match.
  if (query.length < expected.length || !query.subarray(12, expected.length).equals(expected.subarray(12))) return undefined
  const header = Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])
  return Buffer.concat([header, expected.subarray(12), Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 198, 18, 0, 12])])
}

export function datagram(host: string, port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    const timer = setTimeout(() => { socket.close(); reject(new Error('native UDP fixture timed out')) }, 8000)
    socket.once('error', error => { clearTimeout(timer); socket.close(); reject(error) })
    socket.once('message', data => { clearTimeout(timer); socket.close(); resolve(data) })
    socket.send(payload, port, host)
  })
}

export function udpPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', () => { try { socket.close() } catch {}; resolve(false) })
    socket.bind({ address: '127.0.0.1', port, exclusive: true }, () => socket.close(() => resolve(true)))
  })
}

/** Use the production UoT outbound and worker hijack rule. Only the remote DNS
 * endpoint is replaced by the deterministic fixture; it still travels through
 * the selected profile. Neither additional native process has a TUN inbound. */
export async function nativeDns(exe: string, dir: string, profile: OutProfile): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const chosen = new Set<number>()
  const port = async (udp = false) => {
    for (let i = 0; i < 30; i++) {
      const value = await pickPort(udp ? udpPortFree : undefined)
      if (value && !chosen.has(value)) { chosen.add(value); return value }
    }
    throw new Error('native DNS fixture has no free port')
  }
  const workerApi = await port(), clientApi = await port(), input = await port(true)
  const slot = { id: 'dns-fixture-relay', port: await port(), username: 'native-fixture-user', password: 'native-fixture-password' }
  const secret = 'native-dns-fixture-controller'
  const worker = checkConfig([profile], { port: workerApi, secret }, undefined, { proxy: slot, profileId: profile.id })
  const originalResolver = worker.dns.servers.find(server => server.tag === 'forward-dns')
  assert.deepEqual(originalResolver, { type: 'https', server: '1.1.1.1', tag: 'forward-dns', detour: tagOf(profile.id) })
  worker.dns.servers = worker.dns.servers.map(server => server.tag === 'forward-dns'
    ? { type: 'udp', server: '198.18.0.53', server_port: 53, tag: 'forward-dns', detour: tagOf(profile.id) } : server)
  const client = {
    log: { level: 'warn' },
    inbounds: [{ type: 'direct', listen: '127.0.0.1', listen_port: input, network: 'udp', override_address: RELAY_DNS_IP, override_port: 53 }],
    outbounds: relayOutbounds([slot]), route: { final: slot.id, auto_detect_interface: true },
    experimental: { clash_api: { external_controller: '127.0.0.1:' + clientApi, secret } }
  }
  const processes: { child: ReturnType<typeof spawn>; logs: () => string }[] = []
  const start = async (name: string, config: unknown, apiPort: number) => {
    const path = join(dir, name + '.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const child = spawn(exe, ['run', '-c', path, '--disable-color'], { cwd: dir, windowsHide: true })
    let output = ''
    const log = (data: Buffer) => { output = (output + data.toString()).slice(-8000) }
    child.stdout?.on('data', log); child.stderr?.on('data', log); child.on('error', error => { output += error.message })
    processes.push({ child, logs: () => output })
    const ready = await waitReady({ budget: 10_000, every: 150, alive: () => !!child.pid && child.exitCode === null && child.signalCode === null,
      probe: async () => { try { return (await fetch('http://127.0.0.1:' + apiPort + '/version', {
        headers: { Authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(500)
      })).ok } catch { return false } }
    })
    assert.equal(ready, 'ready', name + ': ' + output)
  }
  try {
    await start('worker', worker, workerApi)
    await start('client', client, clientApi)
    const question = dnsQuestion(), answer = await datagram('127.0.0.1', input, question)
    assert.equal(answer.readUInt16BE(0), question.readUInt16BE(0), 'DNS response preserves request identity')
    assert.equal(answer.readUInt16BE(2) & 15, 0, 'selected worker DNS answered successfully')
    assert.equal(answer.readUInt16BE(6), 1, 'fixture returned one DNS answer')
    assert.deepEqual([...answer.subarray(-4)], [198, 18, 0, 12], 'DNS answer came from selected profile fixture')
  } catch (error) {
    throw new Error(String(error) + '\n' + processes.map(item => item.logs()).join('\n'))
  } finally {
    const clean = await Promise.all(processes.map(async ({ child }) => {
      if (!child.pid) return true
      if (child.exitCode === null && child.signalCode === null) child.kill()
      return await waitExit(child, 4000)
    }))
    rmSync(dir, { recursive: true, force: true })
    assert(clean.every(Boolean), 'all native DNS fixture processes must stop')
  }
}
