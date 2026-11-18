import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchSubscription } from '../src/main/vless'
import { serviceTransport } from '../src/main/service-transport'
import { TransferError, type proxyRequest } from '../src/main/proxy-http'
import { fetchCatalogSources } from '../src/main/catalog'
import { Lists } from '../src/main/lists'
import { checkedPatch } from '../src/main/validate'
import { DEFAULTS, migrate } from '../src/main/store-core'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'
import { dropServer, usersOf } from '../src/shared/path-usage'

async function main() {
  const dns = require('node:dns/promises') as { lookup: (...args: any[]) => Promise<any> }
  const previousLookup = dns.lookup, previousFetch = globalThis.fetch
  let lookups = 0, direct = 0, requests = 0, doh = 0
  let answers = [{ address: '8.8.8.8', family: 4 }]
  dns.lookup = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] }
  globalThis.fetch = async () => { direct++; throw new Error('unexpected Direct socket') }
  const proxy: DiagnosticTransport = { host: '127.0.0.1', port: 1, username: 'owned', password: 'local', signal: new AbortController().signal }
  const dir = mkdtempSync(join(tmpdir(), 'waarp-service-download-'))
  const network = (http: typeof proxyRequest): typeof proxyRequest => async (actual, url, options) => {
    actual.signal.throwIfAborted()
    assert.equal(actual.port, proxy.port); assert.equal(actual.password, 'local')
    if (url.hostname === 'cloudflare-dns.com') {
      doh++; assert.equal(options?.connectAddress, '1.1.1.1'); assert.equal(options?.maxBytes, 16384)
      assert.equal(options?.headers?.Accept, 'application/dns-json')
      const type = Number(url.searchParams.get('type')), family = type === 1 ? 4 : 6
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ Status: 0, TC: false,
        Answer: answers.filter(answer => answer.family === family).map(answer => ({ type, data: answer.address })) })) }
    }
    requests++
    return http(actual, url, options)
  }
  try {
    assert(checkedPatch({ serviceVia: 'personal-1' }).ok)
    for (const value of ['g-auto', 'g-own', 'bad/path', 12, null]) assert(!checkedPatch({ serviceVia: value }).ok)
    assert.equal(migrate({ ...DEFAULTS, serviceVia: 'personal-1' }).serviceVia, 'personal-1')
    assert.equal(migrate({ ...DEFAULTS, serviceVia: 'g-own' }).serviceVia, undefined)
    assert.equal(usersOf({ ...DEFAULTS, serviceVia: 'own' }, 'own').service, true)
    assert.equal(dropServer({ ...DEFAULTS, serviceVia: 'own' }, 'own').serviceVia, 'own', 'deleted service profile stays unavailable, not Direct')
    assert.equal(dropServer({ ...DEFAULTS, serviceVia: 'own' }, 'own', 'replacement').serviceVia, 'replacement')
    const transport = serviceTransport(proxy, network(async (_actual, url, options) => {
      assert.equal(url.hostname, 'sub.example'); assert.equal(options?.connectAddress, '8.8.8.8')
      assert.equal(options?.maxBytes, 1024 * 1024); assert(options?.allowStatus)
      return { status: 200, body: Buffer.from('complete subscription'), headers: {} }
    }))
    assert.equal(await fetchSubscription('https://sub.example/key', { transport }), 'complete subscription')
    assert.equal(lookups, 0, 'selected path never consults poisoned local DNS')
    assert.equal(doh, 2, 'A and AAAA use the same selected profile with public bootstrap and verified TLS name')
    assert.equal(direct, 0)
    answers = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
    await assert.rejects(fetchSubscription('https://rebind.example/rebind', { transport }), /локальн/)
    assert.equal(requests, 1, 'one private DNS answer refuses the whole destination before proxy I/O')
    answers = [{ address: '8.8.8.8', family: 4 }]
    const redirected = serviceTransport(proxy, network(async () => ({ status: 302, body: Buffer.alloc(0), headers: { location: 'https://127.0.0.1/secret' } })))
    await assert.rejects(fetchSubscription('https://sub.example/redirect', { transport: redirected }), /локальн/)
    assert.equal(requests, 2, 'redirect target is checked before a second connection')
    const forbidden = await fetchCatalogSources(['https://raw.githubusercontent.com/example/list'], new AbortController().signal,
      serviceTransport(proxy, network(async () => ({ status: 302, body: Buffer.alloc(0), headers: { location: 'https://not-a-catalog.example/' } }))))
    assert.equal(forbidden[0].body, undefined); assert(forbidden[0].error)
    assert.equal(requests, 3, 'catalog allowlist still applies at each hop')
    answers = [{ address: '8.8.8.8', family: 4 }, { address: '8.8.4.4', family: 4 }]
    const failed = serviceTransport(proxy, network(async actual => { assert.equal(actual.port, proxy.port); throw new TransferError('network') }))
    const lists = new Lists(dir)
    const source = lists.add('Existing', 'https://sub.example/domains')
    source.domains = ['working.example']; source.updatedAt = 123
    assert.equal(await lists.refresh(source.id, { transport: failed }), false)
    assert.deepEqual(lists.data[0].domains, ['working.example']); assert.equal(lists.data[0].updatedAt, 123)
    assert.equal(requests, 5, 'alternate checked addresses use the same selected proxy')
    assert.equal(direct, 0, 'all errors preserve the cache without a Direct retry')
    assert.equal(lookups, 0, 'neither HTTP nor DNS failures fall back to the local network')
    const badDns = serviceTransport(proxy, async () => ({ status: 200, headers: {}, body: Buffer.from('{"Status":0,"TC":true,"Answer":[]}') }))
    await assert.rejects(fetchSubscription('https://truncated.example/', { transport: badDns }))
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(fetchSubscription('https://sub.example/cancel', { transport, signal: cancelled.signal }))
    assert.equal(requests, 5, 'cancelled request cannot start a proxy transfer')
    console.log('service-download: production subscription/list/catalog paths, selected-profile DoH despite poisoned local DNS, IP pinning, mixed-private/truncated DNS answers, redirect allowlists, cache preservation, deletion and cancellation PASS')
  } finally { dns.lookup = previousLookup; globalThis.fetch = previousFetch; rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
