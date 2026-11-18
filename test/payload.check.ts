import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { proxyRequest, transferUrl } from '../src/main/proxy-http'
import { checkPayload, readPayloadReport, uploadPayload, verifyDownload, verifyUploadReply } from '../src/main/payload-check'
import { PAYLOAD_DOWNLOAD, PAYLOAD_UPLOAD_BYTES } from '../src/shared/payload'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
async function run() {
  const sent = uploadPayload()
  assert.equal(sent.length, PAYLOAD_UPLOAD_BYTES)
  assert(sent.every(byte => byte < 128))
  const receipt = Buffer.from(JSON.stringify({ bytes: sent.length, sha256: hash(sent) }))
  assert(verifyUploadReply(receipt, sent))
  assert(!verifyUploadReply(Buffer.from('{"bytes":1,"sha256":"fake"}'), sent))
  assert.equal(verifyDownload(Buffer.from('tiny 204 substitute')), 'size')
  assert.equal(verifyDownload(Buffer.alloc(PAYLOAD_DOWNLOAD.bytes)), 'digest')
  for (const url of ['http://example.org', 'https://user:pass@example.org', 'file:///tmp/x', 'https://example.org/#key', 'https://example.org:0']) assert(!transferUrl(url), url)
  assert(transferUrl('https://my-own-server.example/check?token=private'))
  const fake: DiagnosticTransport = { host: '127.0.0.1', port: 1, username: 'local', password: 'fixture', signal: new AbortController().signal }
  let requests = 0
  const report = await checkPayload('own', fake, undefined, async () => { requests++; return { status: 200, headers: {}, body: Buffer.from('wrong content') } })
  assert.equal(requests, 1); assert.equal(report.download.state, 'fail')
  assert.equal(report.upload.state, 'not_measured', 'without user endpoint there is no upload or invented pass')
  const exported = readPayloadReport({ ...report, token: 'must not survive', download: { ...report.download, url: 'secret' } })!
  assert(!JSON.stringify(exported).includes('secret')); assert(!JSON.stringify(exported).includes('must not survive'))
  const verifiedUpload = await checkPayload('own', fake, 'https://own.example/check', async (_proxy, _url, options) => ({
    status: 200, headers: {}, body: options?.body ? Buffer.from(JSON.stringify({ bytes: options.body.length, sha256: hash(options.body) })) : Buffer.from('small wrong body')
  }))
  assert.equal(verifiedUpload.upload.state, 'pass'); assert.equal(verifiedUpload.upload.bytes, 65536)

  const dir = process.env.WAARP_TLS_FIXTURE!
  const sockets = new Set<net.Socket>()
  const track = (socket: net.Socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }
  const server = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://another.example/' }); response.end(); return }
    if (request.url === '/oversize') { response.writeHead(200, { 'Content-Length': '400000' }); response.end('x'); return }
    if (request.url === '/partial') { response.writeHead(200, { 'Content-Length': '10000' }); response.write('cut'); setImmediate(() => response.destroy()); return }
    if (request.url === '/stall') { response.writeHead(200); response.write('partial'); return }
    if (request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.once('end', () => { const body = Buffer.concat(chunks); response.end(JSON.stringify({ bytes: body.length, sha256: hash(body) })) })
    } else response.end('complete encrypted body')
  })
  server.on('connection', track); server.on('tlsClientError', () => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const remotePort = (server.address() as net.AddressInfo).port
  let authorized = 0
  const relay = http.createServer()
  relay.on('connection', track)
  relay.on('connect', (request, socket, head) => {
    if (request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('local:fixture').toString('base64')) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return
    }
    authorized++
    const upstream = net.connect(remotePort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    track(upstream); socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy())
  })
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
  const proxy = { ...fake, port: (relay.address() as net.AddressInfo).port }
  const url = (path: string, host = 'localhost') => new URL(`https://${host}:${remotePort}${path}`)
  try {
    const valid = await proxyRequest(proxy, url('/'), { maxBytes: 128 })
    assert.equal(valid.body.toString(), 'complete encrypted body'); assert.equal(authorized, 1)
    const upload = await proxyRequest(proxy, url('/upload'), { body: sent, maxBytes: 4096 })
    assert(verifyUploadReply(upload.body, sent), 'actual TLS server confirms exact upload bytes')
    await assert.rejects(proxyRequest({ ...proxy, password: 'wrong' }, url('/'), { maxBytes: 128 }), error => (error as any).code === 'http')
    await assert.rejects(proxyRequest(proxy, url('/', 'wrong.example'), { maxBytes: 128 }), error => (error as any).code === 'tls', 'TLS hostname verification is mandatory')
    await assert.rejects(proxyRequest(proxy, url('/redirect'), { maxBytes: 128 }), error => (error as any).code === 'http')
    await assert.rejects(proxyRequest(proxy, url('/oversize'), { maxBytes: 128 }), error => (error as any).code === 'size')
    await assert.rejects(proxyRequest(proxy, url('/partial'), { maxBytes: 16384 }))
    const cancelled = new AbortController()
    const pending = proxyRequest({ ...proxy, signal: cancelled.signal }, url('/stall'), { maxBytes: 16384 })
    const timer = setTimeout(() => cancelled.abort(), 60)
    await assert.rejects(pending, error => (error as any).code === 'cancelled'); clearTimeout(timer)
    console.log('payload: real authenticated CONNECT + verified TLS, exact upload receipt, limits, truncation, redirect refusal, cancellation, metadata redaction PASS')
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => relay.close(() => resolve()))])
  }
}

if (process.env.WAARP_TLS_FIXTURE) run().catch(error => { console.error(error); process.exitCode = 1 })
else {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-payload-tls-'))
  try {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore', timeout: 15000 })
    if (generated.error) throw generated.error
    assert.equal(generated.status, 0)
    const child = spawnSync(process.execPath, [process.argv[1]], { env: { ...process.env, WAARP_TLS_FIXTURE: dir, NODE_EXTRA_CA_CERTS: join(dir, 'cert.pem') }, encoding: 'utf8', timeout: 30000 })
    process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '')
    assert.equal(child.status, 0, child.error?.message ?? 'TLS fixture child failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
