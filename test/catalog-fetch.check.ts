import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { CATALOG_FETCH_LIMITS, fetchCatalogSources } from '../src/main/catalog-fetch'
import { DEFAULT_SOURCES, PUBLIC_SOURCES, publicSourceForUrl } from '../src/shared/public-sources'
import type { PinnedHttpGet, PublicResolver } from '../src/main/vless'

// This suite replaces HTTP and DNS. It never dials a source, a relay, or a local
// listener, and never starts a measuring engine or changes network settings.
const fixture = 'trojan://synthetic-fixture-password@relay.example:443#Fixture'
const source = 'https://raw.githubusercontent.com/example/offline-fixture/main/list.txt'
const igareck = PUBLIC_SOURCES.find(item => item.id === 'igareck-vless')!
const controller = () => new AbortController()
const publicAnswers: Awaited<ReturnType<PublicResolver>> = [{ address: '8.8.8.8', family: 4 }]
const mock = (handler: PinnedHttpGet, resolver: PublicResolver = async () => publicAnswers): PinnedHttpGet => {
  const get: PinnedHttpGet = async (...args) => handler(...args)
  get.resolve = resolver
  return get
}

async function main() {
  const previousFetch = globalThis.fetch
  const dns = require('node:dns/promises') as { lookup: (...args: any[]) => Promise<any> }
  const https = require('node:https') as { request: (...args: any[]) => any }
  const previousLookup = dns.lookup, previousRequest = https.request
  let directFetch = 0, systemDns = 0, sockets = 0
  globalThis.fetch = async () => { directFetch++; throw new Error('unexpected global fetch') }
  dns.lookup = async () => { systemDns++; throw new Error('unexpected system DNS') }
  https.request = () => { sockets++; throw new Error('unexpected socket') }
  try {
    assert.equal(new Set(PUBLIC_SOURCES.map(item => item.id)).size, PUBLIC_SOURCES.length)
    assert.deepEqual(DEFAULT_SOURCES, PUBLIC_SOURCES.map(item => item.url))
    assert(DEFAULT_SOURCES.some(url => url.includes('barry-far')))
    assert(DEFAULT_SOURCES.some(url => url.endsWith('/Eternity.txt')))
    assert(!DEFAULT_SOURCES.some(url => /Epodonios|EternityAir|mehrtat|nodesradar/i.test(url)))
    for (const item of PUBLIC_SOURCES) {
      assert(item.provenance.license && item.provenance.licenseUrl && item.provenance.homepage)
      assert(item.mirrors.length <= CATALOG_FETCH_LIMITS.maxMirrors)
      for (const endpoint of [item.url, ...item.mirrors]) {
        const parsed = new URL(endpoint)
        assert.equal(parsed.protocol, 'https:')
        assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash)
        assert.equal(publicSourceForUrl(endpoint)?.id, item.id)
      }
    }

    let calls: string[] = []
    const valid = mock(async (url, addresses, signal, maxBytes) => {
      signal.throwIfAborted(); assert.deepEqual(addresses, publicAnswers)
      assert.equal(maxBytes, CATALOG_FETCH_LIMITS.maxBytes)
      calls.push(url.href)
      return new Response('# publisher comment\n\n' + fixture)
    })
    const primary = await fetchCatalogSources([igareck.url, igareck.mirrors[0], igareck.url], controller().signal, valid)
    assert.equal(primary.length, 1, 'primary and its mirror are one logical source')
    assert.equal(primary[0].url, igareck.url)
    assert.equal(primary[0].body, fixture)
    assert.equal(primary[0].sourceId, igareck.id)
    assert.equal(primary[0].selectedUrl, igareck.url)
    assert.deepEqual(calls, [igareck.url], 'a valid primary needs no mirror request')

    calls = []
    const fallback = await fetchCatalogSources([igareck.url], controller().signal, mock(async url => {
      calls.push(url.href)
      if (url.href === igareck.url) return new Response('<html><body>' + fixture + '</body></html>')
      if (url.href === igareck.mirrors[0]) return new Response('vless://invalid-credential@relay.example:443')
      return new Response(Buffer.from(fixture).toString('base64'))
    }))
    assert.equal(fallback[0].body, fixture)
    assert.equal(fallback[0].selectedUrl, igareck.mirrors[1])
    assert.equal(fallback[0].url, igareck.url, 'mirror selection preserves canonical source identity')
    assert.deepEqual(fallback[0].attempts?.map(item => item.outcome), ['invalid-format', 'invalid-format', 'ok'])
    assert.equal(calls.length, 3, 'HTTP 200 HTML and broken configs must not hide the next mirror')

    for (const bad of ['', '   ', '{"outbounds":[],"link":"' + fixture + '"}',
      'proxies:\n  - link: ' + fixture, 'invalid base64 body', Buffer.from('<html>' + fixture + '</html>').toString('base64')]) {
      let attempts = 0
      const result = await fetchCatalogSources([igareck.url], controller().signal, mock(async () => new Response(attempts++ === 0 ? bad : fixture)))
      assert.equal(result[0].body, fixture)
      assert.equal(result[0].selectedUrl, igareck.mirrors[0])
      assert.equal(attempts, 2, 'empty/foreign-format documents fall through to a documented mirror')
    }

    let dialed = 0, resolved = 0
    const noPrivate = mock(async () => { dialed++; return new Response(fixture) }, async () => {
      resolved++; return [...publicAnswers, { address: '127.0.0.1', family: 4 }]
    })
    const privateAnswer = await fetchCatalogSources([source], controller().signal, noPrivate)
    assert(privateAnswer[0].error && !privateAnswer[0].body)
    assert.equal(resolved, 1); assert.equal(dialed, 0, 'mixed public/private DNS is rejected before any HTTP')

    for (const destination of ['https://127.0.0.1/private', 'https://[::ffff:127.0.0.1]/private',
      'https://unregistered.example/list', 'http://raw.githubusercontent.com/example/list',
      'https://raw.githubusercontent.com:8443/example/list', 'https://user:synthetic@raw.githubusercontent.com/example/list']) {
      dialed = 0; resolved = 0
      const redirected = mock(async () => {
        dialed++; return new Response(null, { status: 302, headers: { location: destination } })
      }, async () => { resolved++; return publicAnswers })
      const denied = await fetchCatalogSources([source], controller().signal, redirected)
      assert(denied[0].error && !denied[0].body)
      assert.equal(dialed, 1, 'redirect target must be checked before a second HTTP request')
      // The reused subscription downloader resolves a known host before the
      // catalog transport rejects a nonstandard port. No HTTP reaches that port.
      assert.equal(resolved, new URL(destination).port === '8443' ? 2 : 1,
        'unregistered redirect hosts must not cause another DNS query')
    }
    const invalidUrls = ['http://raw.githubusercontent.com/example/list', 'https://127.0.0.1/list',
      'https://unregistered.example/list', 'https://user:synthetic@raw.githubusercontent.com/example/list',
      'https://raw.githubusercontent.com:8443/example/list', 'not a URL']
    dialed = 0
    const invalid = await fetchCatalogSources(invalidUrls, controller().signal, mock(async () => { dialed++; return new Response(fixture) }))
    assert(invalid.every(item => item.error && !item.body)); assert.equal(dialed, 0)

    dialed = 0
    const loop = await fetchCatalogSources([source], controller().signal, mock(async () => {
      dialed++; return new Response(null, { status: 302, headers: { location: source } })
    }))
    assert(loop[0].error)
    assert.equal(dialed, CATALOG_FETCH_LIMITS.maxRedirects + 1, 'redirect count is bounded')

    let cancelledBody = false
    const oversized = await fetchCatalogSources([source], controller().signal, mock(async () => new Response(
      new ReadableStream({ cancel() { cancelledBody = true } }),
      { headers: { 'content-length': String(CATALOG_FETCH_LIMITS.maxBytes + 1) } }
    )))
    assert(oversized[0].error && !oversized[0].body); assert(cancelledBody, 'oversized Content-Length cancels the stream')
    cancelledBody = false
    let chunks = 0
    const streamed = await fetchCatalogSources([source], controller().signal, mock(async () => new Response(new ReadableStream({
      pull(stream) { chunks++; stream.enqueue(new Uint8Array(CATALOG_FETCH_LIMITS.maxBytes / 2 + 1)) },
      cancel() { cancelledBody = true }
    }))))
    assert(streamed[0].error && !streamed[0].body); assert(cancelledBody)
    assert(chunks <= 4, 'a stream cannot bypass the byte cap by omitting Content-Length')

    const stop = controller()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    dialed = 0
    const hanging = fetchCatalogSources([igareck.url], stop.signal, mock(async () => {
      dialed++; entered(); return new Promise<Response>(() => undefined)
    }))
    await started; stop.abort()
    const cancelled = await hanging
    assert(cancelled[0].error && !cancelled[0].body)
    assert.equal(dialed, 1, 'cancellation settles an uncooperative request without starting a mirror')
    dialed = 0
    await fetchCatalogSources([igareck.url], stop.signal, mock(async () => { dialed++; return new Response(fixture) }))
    assert.equal(dialed, 0, 'an already aborted download has no HTTP side effects')

    const previousTimeout = globalThis.setTimeout
    try {
      globalThis.setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => previousTimeout(handler,
        ms === CATALOG_FETCH_LIMITS.sourceTimeoutMs ? 10 : ms === CATALOG_FETCH_LIMITS.attemptTimeoutMs ? 100 : ms, ...args)) as typeof setTimeout
      dialed = 0
      const expired = await fetchCatalogSources([igareck.url], controller().signal, mock(async () => {
        dialed++; return new Promise<Response>(() => undefined)
      }))
      assert(expired[0].error && !expired[0].body)
      assert.equal(dialed, 1, 'the source-wide deadline also prevents later mirror attempts')
    } finally { globalThis.setTimeout = previousTimeout }

    let inFlight = 0, peak = 0
    const many = Array.from({ length: 15 }, (_, index) => source + '?fixture=' + index)
    const bounded = await fetchCatalogSources(many, controller().signal, mock(async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise<void>(resolve => setImmediate(resolve))
      inFlight--; return new Response(fixture)
    }))
    assert.equal(bounded.length, CATALOG_FETCH_LIMITS.maxSources)
    assert(peak <= CATALOG_FETCH_LIMITS.concurrency)
    assert.deepEqual(bounded.map(item => item.url), many.slice(0, CATALOG_FETCH_LIMITS.maxSources), 'completion order does not reorder source results')

    const header = '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64'
    const ovpn = 'client\ndev tun\nremote relay.example 1194\nremote-cert-tls server\npeer-fingerprint ' + '1'.repeat(64)
    const row = ['Fixture', '192.0.2.1', '0', '0', '0', 'Test', 'ZZ', '0', '0', '0', '0', '0', 'Fixture', '', Buffer.from(ovpn).toString('base64')].join(',')
    const gate = PUBLIC_SOURCES.find(item => item.id === 'vpngate')!
    const csv = '*vpn_servers\n' + header + '\n' + row + '\n*'
    const gateResult = await fetchCatalogSources([gate.url], controller().signal, mock(async () => new Response(csv)))
    assert.equal(gateResult[0].body, csv); assert.equal(gateResult[0].format, 'vpngate-csv')
    for (const invalidCsv of [header + '\n*', header + '\ninvalid,row', '<html>' + csv + '</html>']) {
      const result = await fetchCatalogSources([gate.url], controller().signal, mock(async () => new Response(invalidCsv)))
      assert(result[0].error && !result[0].body, 'VPN Gate needs a real supported embedded OpenVPN profile')
    }

    assert.equal(directFetch, 0); assert.equal(systemDns, 0); assert.equal(sockets, 0,
      'injected selected-path requests have no fallback to the system network')
    // Exercise the production Direct adapter too: checked DNS answers must be
    // handed to the pinned lookup while SNI/hostname verification keep the host.
    dns.lookup = async () => { systemDns++; return publicAnswers }
    https.request = (options, respond) => {
      sockets++
      assert.equal(options.servername, 'raw.githubusercontent.com')
      assert.equal(options.hostname, 'raw.githubusercontent.com')
      assert.equal(options.protocol, 'https:'); assert.equal(options.port, 443)
      assert.notEqual(options.rejectUnauthorized, false)
      options.lookup(options.hostname, { all: true }, (error: unknown, addresses: unknown) => {
        assert.ifError(error); assert.deepEqual(addresses, publicAnswers)
      })
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => respond(Object.assign(Readable.from([Buffer.from(fixture)]), { statusCode: 200, headers: {} }))
      return req
    }
    const direct = await fetchCatalogSources([source], controller().signal)
    assert.equal(direct[0].body, fixture)
    assert.equal(systemDns, 1); assert.equal(sockets, 1); assert.equal(directFetch, 0)
    dns.lookup = async () => [...publicAnswers, { address: '10.0.0.1', family: 4 }]
    const blockedDirect = await fetchCatalogSources([source], controller().signal)
    assert(blockedDirect[0].error); assert.equal(sockets, 1, 'production Direct refuses mixed private DNS before opening TLS')

    console.log('catalog-fetch: registry provenance, canonical mirror identity, real format fallback, public DNS/IP pinning, redirect allowlists, source deadlines, cancellation, byte/concurrency caps and VPN Gate validation PASS')
  } finally {
    globalThis.fetch = previousFetch; dns.lookup = previousLookup; https.request = previousRequest
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
