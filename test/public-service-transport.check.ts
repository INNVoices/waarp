import assert from 'node:assert/strict'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'
import { publicServiceTransport } from '../src/main/public-service-transport'
import { serviceTransport } from '../src/main/service-transport'
import { TransferError, type proxyRequest } from '../src/main/proxy-http'
import { fetchCatalogSources } from '../src/main/catalog-fetch'

const source = 'https://raw.githubusercontent.com/example/offline-fixture/main/public.txt'
const fixture = 'trojan://synthetic-fixture-password@relay.example:443#Fixture'
const proxyController = new AbortController()
const proxy: DiagnosticTransport = { host: '127.0.0.1', port: 1, username: 'synthetic-local', password: 'synthetic-local', signal: proxyController.signal }
const answer = (type: number, values: string[]) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({
  Status: 0, TC: false, Answer: values.map(data => ({ type, data }))
})) })

async function main() {
  const dns = require('node:dns/promises') as { lookup: (...args: any[]) => Promise<any> }
  const https = require('node:https') as { request: (...args: any[]) => any }
  const previousLookup = dns.lookup, previousRequest = https.request, previousFetch = globalThis.fetch
  let direct = 0
  dns.lookup = async () => { direct++; throw new Error('unexpected system DNS') }
  https.request = () => { direct++; throw new Error('unexpected system socket') }
  globalThis.fetch = async () => { direct++; throw new Error('unexpected global fetch') }
  try {
    const seen: string[] = []
    let content = 0
    const request: typeof proxyRequest = async (selected, url, options) => {
      selected.signal.throwIfAborted()
      assert.equal(selected.host, proxy.host); assert.equal(selected.port, proxy.port)
      assert.equal(selected.username, proxy.username); assert.equal(selected.password, proxy.password)
      if (url.hostname === 'cloudflare-dns.com') {
        seen.push('cloudflare'); assert.equal(options?.connectAddress, '1.1.1.1')
        assert.equal(options?.maxBytes, 16384); throw new TransferError('network')
      }
      if (url.hostname === 'dns.google') {
        seen.push('google'); assert.equal(url.protocol, 'https:'); assert.equal(url.pathname, '/resolve')
        assert.equal(options?.connectAddress, '8.8.8.8'); assert.equal(options?.maxBytes, 16384)
        assert.equal(url.searchParams.get('name'), 'raw.githubusercontent.com')
        assert.equal(url.searchParams.get('edns_client_subnet'), '0.0.0.0/0')
        const type = Number(url.searchParams.get('type'))
        return answer(type, type === 1 ? ['8.8.4.4'] : [])
      }
      content++; assert.equal(url.hostname, 'raw.githubusercontent.com')
      assert.equal(options?.connectAddress, '8.8.4.4'); assert(options?.allowStatus)
      return { status: 200, headers: {}, body: Buffer.from(fixture) }
    }
    const transport = publicServiceTransport(proxy, request)
    const result = await fetchCatalogSources([source], new AbortController().signal, transport)
    assert.equal(result[0].body, fixture)
    assert.deepEqual(seen, ['cloudflare', 'cloudflare', 'google', 'google'])
    assert.equal(content, 1)
    await fetchCatalogSources([source], new AbortController().signal, transport)
    assert.equal(seen.length, 4, 'successful DNS answers are cached only within this transport instance')
    assert.equal(content, 2)

    const primaryOnly: string[] = []
    const primary = publicServiceTransport(proxy, async (_selected, url) => {
      primaryOnly.push(url.hostname)
      const type = Number(url.searchParams.get('type'))
      return answer(type, type === 1 ? ['8.8.4.4'] : ['2001:4860:4860::8844'])
    })
    assert.equal((await primary.resolve!('public.example', new AbortController().signal)).length, 2)
    assert.deepEqual(primaryOnly, ['cloudflare-dns.com', 'cloudflare-dns.com'], 'a valid primary resolver does not query the secondary')

    for (const invalid of ['truncated', 'private', 'empty', 'malformed', 'oversized', 'redirect'] as const) {
      let google = 0
      const guarded = publicServiceTransport(proxy, async (_selected, url) => {
        const type = Number(url.searchParams.get('type'))
        if (url.hostname === 'dns.google') { google++; return answer(type, type === 1 ? ['8.8.4.4'] : []) }
        if (invalid === 'truncated') return { status: 200, headers: {}, body: Buffer.from('{"Status":0,"TC":true,"Answer":[]}') }
        if (invalid === 'malformed') return { status: 200, headers: {}, body: Buffer.from('<html>blocked</html>') }
        if (invalid === 'oversized') return { status: 200, headers: {}, body: Buffer.alloc(16385) }
        if (invalid === 'redirect') return { status: 302, headers: { location: 'https://127.0.0.1/private' }, body: Buffer.alloc(0) }
        return answer(type, type === 1 ? (invalid === 'private' ? ['8.8.4.4', '10.0.0.1'] : []) : [])
      })
      assert.deepEqual(await guarded.resolve!('public.example', new AbortController().signal), [{ address: '8.8.4.4', family: 4 }])
      assert.equal(google, 2, invalid + ' primary is discarded before trying the second provider on the same proxy')
    }

    let privateAttempts = 0
    const bothPrivate = publicServiceTransport(proxy, async (_selected, url) => {
      privateAttempts++
      const type = Number(url.searchParams.get('type'))
      return answer(type, type === 1 ? ['127.0.0.1'] : [])
    })
    await assert.rejects(bothPrivate.resolve!('public.example', new AbortController().signal))
    assert.equal(privateAttempts, 4)

    const cancel = new AbortController()
    let googleAfterCancel = 0
    const cancelled = publicServiceTransport(proxy, async (_selected, url) => {
      if (url.hostname === 'cloudflare-dns.com') { cancel.abort(new Error('synthetic cancellation')); throw new TransferError('cancelled') }
      googleAfterCancel++; return answer(1, ['8.8.4.4'])
    })
    await assert.rejects(cancelled.resolve!('public.example', cancel.signal), /synthetic cancellation/)
    assert.equal(googleAfterCancel, 0, 'external cancellation prevents resolver failover')

    const privateSeen: string[] = []
    const unchangedPrivate = serviceTransport(proxy, async (_selected, url) => {
      privateSeen.push(url.hostname); throw new TransferError('network')
    })
    await assert.rejects(unchangedPrivate.resolve!('private-subscription.example', new AbortController().signal))
    assert(privateSeen.every(host => host === 'cloudflare-dns.com'), 'private serviceTransport keeps its existing single-resolver policy')

    assert.equal(direct, 0, 'neither resolver failure nor content transfer uses local DNS or a Direct socket')
    console.log('public-service-transport: same-proxy Cloudflare/Google DNS failover, fixed bootstrap IPs and TLS hostnames, checked answers, bounded JSON, cancellation, session cache and unchanged private resolver PASS')
  } finally { dns.lookup = previousLookup; https.request = previousRequest; globalThis.fetch = previousFetch }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
