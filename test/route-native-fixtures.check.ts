import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { fixture, datagram, dnsQuestion, udpPortFree, nativeReadinessTargets } from './route-native-fixtures'
import { NATIVE_TEST_CA, NATIVE_TEST_CERT } from './route-native-tls'

function exchange(socket: net.Socket, request: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose) }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => onError(new Error('fixture closed before SOCKS reply'))
    const onData = (data: Buffer) => {
      received = Buffer.concat([received, data])
      if (received.length >= length) { cleanup(); resolve(received) }
    }
    const timer = setTimeout(() => onError(new Error('fixture SOCKS reply timeout')), 3000)
    socket.on('data', onData); socket.once('error', onError); socket.once('close', onClose); socket.write(request)
  })
}

async function httpReply(port: number, method: 'HEAD' | 'GET'): Promise<string> {
  const socket = net.connect(port, '127.0.0.1')
  try {
    assert.deepEqual([...await exchange(socket, Buffer.from([5, 1, 0]), 2)], [5, 0])
    assert.equal((await exchange(socket, Buffer.from([5, 1, 0, 1, 198, 18, 0, 11, 0, 80]), 10))[1], 0)
    return await new Promise<string>((resolve, reject) => {
      let reply = ''
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('fixture HTTP reply timeout')) }, 3000)
      socket.setEncoding('utf8'); socket.on('data', data => { reply += data })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
      socket.once('end', () => { clearTimeout(timer); resolve(reply) })
      // Matches the method used by the pinned native URLTest readiness probe.
      socket.write(method + ' / HTTP/1.1\r\nHost: 198.18.0.11\r\nUser-Agent: Go-http-client/1.1\r\nConnection: close\r\n\r\n')
    })
  } finally { socket.destroy() }
}

async function httpsReply(port: number, ca?: string): Promise<string> {
  const socket = net.connect(port, '127.0.0.1')
  let secure: tls.TLSSocket | undefined
  try {
    assert.deepEqual([...await exchange(socket, Buffer.from([5, 1, 0]), 2)], [5, 0])
    assert.equal((await exchange(socket, Buffer.from([5, 1, 0, 1, 198, 18, 0, 11, 1, 187]), 10))[1], 0)
    secure = tls.connect({ socket, ca, servername: 'waarp-native.invalid', rejectUnauthorized: true })
    return await new Promise<string>((resolve, reject) => {
      let reply = ''
      secure!.setTimeout(3000, () => secure!.destroy(new Error('fixture HTTPS reply timeout')))
      secure!.setEncoding('utf8'); secure!.on('data', data => { reply += data })
      secure!.once('error', reject); secure!.once('end', () => resolve(reply))
      secure!.once('secureConnect', () => secure!.write('HEAD / HTTP/1.1\r\nHost: 198.18.0.11\r\nConnection: close\r\n\r\n'))
    })
  } finally { secure?.destroy(); socket.destroy() }
}

async function main() {
  const requested: string[] = []
  const endpoints = await nativeReadinessTargets(async host => {
    requested.push(host)
    if (host === 'www.gstatic.com') throw new Error('synthetic DNS failure')
    return [{ address: '1.1.1.1', family: 4 }]
  })
  assert.deepEqual(requested.sort(), ['cp.cloudflare.com', 'www.gstatic.com'])
  assert.deepEqual([...endpoints.pins], [['cp.cloudflare.com', '1.1.1.1']], 'one unavailable host preserves native fallback')
  assert.equal(endpoints.unavailable[0].host, 'www.gstatic.com')
  await assert.rejects(nativeReadinessTargets(async () => [{ address: '127.0.0.1', family: 4 }]), /Neither HTTPS/,
    'private resolved addresses cannot become the public readiness relay')
  const server = await fixture('C', { https: true })
  const control = net.connect(server.port, '127.0.0.1')
  const occupied = dgram.createSocket('udp4')
  try {
    const head = await httpReply(server.port, 'HEAD'), get = await httpReply(server.port, 'GET')
    assert(head.startsWith('HTTP/1.1 200 OK\r\n'), 'native HEAD readiness receives an actual HTTP success')
    assert.equal(head.split('\r\n\r\n')[0], get.split('\r\n\r\n')[0], 'HEAD and GET have identical representation headers')
    assert.equal(head.split('\r\n\r\n')[1], '', 'HEAD must not include a body')
    assert.equal(get.split('\r\n\r\n')[1], 'C', 'GET retains the selected fixture payload')
    assert.equal(server.received.head, 1)
    const certificate = new X509Certificate(NATIVE_TEST_CERT)
    assert.equal(certificate.checkIP('198.18.0.11'), '198.18.0.11', 'native HTTPS probe IP has a matching SAN')
    assert.equal(certificate.checkIP('198.18.0.12'), undefined)
    await assert.rejects(httpsReply(server.port), /certificate|issuer|verify/, 'fixture TLS must reject an untrusted certificate')
    const secure = await httpsReply(server.port, NATIVE_TEST_CA)
    assert(secure.startsWith('HTTP/1.1 200 OK\r\n'))
    assert.equal(secure.split('\r\n\r\n')[1], '', 'verified HTTPS HEAD has no response body')
    assert.equal(server.received.httpsHead, 1, 'only the trusted native-style HTTPS request reached the fixture')

    assert.deepEqual([...await exchange(control, Buffer.from([5, 1, 0]), 2)], [5, 0])
    const association = await exchange(control, Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]), 10)
    assert.equal(association[1], 0)
    const relay = association.readUInt16BE(8)
    const echoed = await datagram('127.0.0.1', relay, Buffer.concat([
      Buffer.from([0, 0, 0, 1, 198, 18, 0, 9, 0x9c, 0x40]), Buffer.from('native-udp')
    ]))
    assert.equal(echoed.subarray(10).toString(), 'C:native-udp')
    const answer = await datagram('127.0.0.1', relay, Buffer.concat([
      Buffer.from([0, 0, 0, 1, 198, 18, 0, 53, 0, 53]), dnsQuestion()
    ]))
    assert.equal(answer.readUInt16BE(10), 0x5752)
    assert.deepEqual([...answer.subarray(-4)], [198, 18, 0, 12])
    assert.deepEqual(server.received, { udp: 1, dns: 1, head: 1, httpsHead: 1, publicHttps: 0, publicHttpsBytes: 0 })

    await new Promise<void>(resolve => occupied.bind({ address: '127.0.0.1', port: 0, exclusive: true }, resolve))
    assert.equal(await udpPortFree(occupied.address().port), false, 'a UDP-only occupied port is rejected')
    assert.equal(await udpPortFree(0), true, 'a free UDP port is accepted and released')
    console.log('route-native-fixtures: real SOCKS HEAD/GET, trusted HTTPS and rejected untrusted TLS, UDP/DNS and occupied UDP port checks PASS')
  } finally {
    control.destroy(); try { occupied.close() } catch {}; await server.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
