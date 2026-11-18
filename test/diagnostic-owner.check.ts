import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { Checker } from '../src/main/checker'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-diagnostic-owner-'))
  let now = 'direct', accepts = false, reads = 0, writes = 0
  let onRead: (() => void) | undefined
  const api = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture')
    if (request.method === 'PUT') {
      writes++; let body = ''
      request.on('data', chunk => { body += chunk })
      request.once('end', () => { if (accepts) now = JSON.parse(body).name; response.writeHead(204).end() })
    } else {
      reads++; onRead?.()
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ now }))
    }
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const apiConfig = { port: (api.address() as AddressInfo).port, secret: 'fixture' }
  const proxy = { port: 2, username: 'owned', password: 'secret' }
  const engine = new Engine(process.execPath, dir, process.execPath), nativeEngine = engine as any
  nativeEngine.child = {}; nativeEngine.status.phase = 'on'; nativeEngine.api = apiConfig
  nativeEngine.diagnostic = proxy; nativeEngine.run = { loaded: { profiles: ['own'] } }
  const checker = new Checker(process.execPath, dir), nativeChecker = checker as any
  nativeChecker.child = {}; nativeChecker.api = apiConfig; nativeChecker.ids = ['own']; nativeChecker.diagnostic = proxy
  const owner = checker.acquire()!
  const cases = [
    { name: 'live core', run: (signal: AbortSignal, work: (transport: DiagnosticTransport) => Promise<string>) => engine.withHttpProxy('own', signal, work), abort: () => nativeEngine.abortRequests() },
    { name: 'owned checker', run: (signal: AbortSignal, work: (transport: DiagnosticTransport) => Promise<string>) => checker.withHttpProxy(owner, 'own', signal, work), abort: () => nativeChecker.abortRequests() }
  ]
  try {
    for (const test of cases) {
      let entered = 0; now = 'direct'; accepts = false
      const work = async (transport: DiagnosticTransport) => { entered++; assert(!transport.signal.aborted); return 'selected proof' }
      await assert.rejects(test.run(new AbortController().signal, work))
      assert.equal(entered, 0, test.name + ' must not expose a default-Direct proxy after a no-op 204')
      accepts = true
      assert.equal(await test.run(new AbortController().signal, async transport => {
        entered++; assert.equal(now, 'p-own'); assert.equal(transport.password, 'secret')
        await assert.rejects(test.run(new AbortController().signal, work), /busy/)
        return 'selected proof'
      }), 'selected proof')
      assert.equal(entered, 1)
      const cancelled = new AbortController()
      onRead = () => cancelled.abort()
      await assert.rejects(test.run(cancelled.signal, work))
      assert.equal(entered, 1, test.name + ' abort between selector write and readback fences the work')
      onRead = undefined
      await assert.rejects(test.run(new AbortController().signal, async transport => {
        test.abort(); assert(transport.signal.aborted); return 'late data'
      }), /cancelled/)
    }
    assert.equal(reads, writes, 'every accepted selection requires a corresponding readback')
    console.log('diagnostic-owner: actual Engine/Checker local API, no-op PUT refused, selected path readback, exclusive owner, cancellation and stale-result fences PASS')
  } finally {
    checker.release(owner); api.closeAllConnections()
    await new Promise<void>(resolve => api.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
