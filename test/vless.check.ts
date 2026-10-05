import { ConfError } from '../src/main/conf-error'
import { fetchSubscription, isSubscriptionUrl, looksLikeVless, parseSubscription, parseVless, redactVless, vlessKey, vlessOutbound, vlessSecrets } from '../src/main/vless'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
const throws = (f: () => unknown, msg: string) => { try { f(); ok(false, msg) } catch (e) { ok(e instanceof ConfError, msg + ' (ConfError)') } }
const rejects = async (f: () => Promise<unknown>, msg: string, re?: RegExp) => {
  try { await f(); ok(false, msg) } catch (e) { ok(e instanceof ConfError && (!re || re.test(e.message)), `${msg} (${e instanceof Error ? e.message : e})`) }
}

export const UUID = '11111111-2222-3333-4444-555555555555'
export const PBK = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3-5cwBM'
export const FULL = `vless://${UUID}@example.org:443?type=xhttp&security=reality&pbk=${PBK}&sid=0123abcd&fp=firefox&sni=www.apple.com&path=%2Fxh&host=cdn.example.org&mode=stream-one&spx=%2Fa#My%20server`
export const TCP = `vless://${UUID}@1.2.3.4:8443?type=tcp&security=reality&pbk=${PBK}&sid=&fp=chrome&sni=www.apple.com&flow=xtls-rprx-vision&encryption=none#tcp`

;(async () => {
  const f = parseVless(FULL)
  eq(f.kind, 'vless', 'kind')
  eq(f.name, 'My server', 'name decoded')
  eq([f.vless.server, f.vless.port, f.vless.uuid], ['example.org', 443, UUID], 'basics')
  eq([f.vless.security, f.vless.network, f.vless.fp, f.vless.mode], ['reality', 'xhttp', 'firefox', 'stream-one'], 'transport fields')
  eq([f.vless.path, f.vless.host, f.vless.sid, f.vless.pbk, f.vless.sni], ['/xh', 'cdn.example.org', '0123abcd', PBK, 'www.apple.com'], 'path/host/keys')
  eq(f.vless.notApplied, ['spx'], 'spx noted, not applied')
  eq(f.version, 'VLESS · REALITY · XHTTP', 'version label')

  const min = parseVless(`vless://${UUID}@[2001:db8::1]:443?security=reality&pbk=${PBK}&sni=a.com`)
  eq([min.vless.server, min.vless.network, min.vless.fp, min.vless.sid, min.vless.flow], ['2001:db8::1', 'tcp', 'firefox', '', undefined], 'minimal: defaults, no guessed flow')
  eq(min.name, 'Сервер', 'fallback name')
  const plain = parseVless(`vless://${UUID}@h.com:80`)
  eq(plain.vless.security, 'none', 'plain security')
  eq(vlessOutbound(plain, 't').tls, undefined, 'plain outbound has no tls')

  throws(() => parseVless('vless://nouser@h.com:443?security=reality'), 'bad uuid')
  throws(() => parseVless(`vless://@h.com:443?security=reality&pbk=${PBK}&sni=a`), 'missing uuid')
  throws(() => parseVless(`vless://${UUID}@h.com:443?security=reality&sni=a`), 'missing pbk')
  throws(() => parseVless(`vless://${UUID}@h.com:443?security=reality&pbk=short&sni=a`), 'bad pbk')
  throws(() => parseVless(`vless://${UUID}@h.com:443?security=reality&pbk=${PBK}`), 'reality without sni')
  throws(() => parseVless(`vless://${UUID}@h.com:443?security=reality&pbk=${PBK}&sni=a&sid=xyz`), 'bad sid')
  throws(() => parseVless(`vless://${UUID}@h.com:99999`), 'bad port')
  throws(() => parseVless(`vless://${UUID}@h.com:443?type=kcp`), 'unsupported transport')
  throws(() => parseVless(`vless://${UUID}@h.com:443?type=xhttp&mode=weird`), 'bad xhttp mode')
  throws(() => parseVless(`vless://${UUID}@h.com:443?fp=netscape`), 'bad fp')
  throws(() => parseVless('ss://abc'), 'not vless')

  const ws = parseVless(`vless://${UUID}@h.com:443?type=ws&security=tls&sni=h.com&path=/w&host=front.com&allowInsecure=1&headerType=http&foo=1`)
  eq(ws.vless.notApplied, ['allowInsecure', 'headerType', 'foo'], 'not applied names')
  eq(vlessOutbound(ws, 'p-1').transport, { type: 'ws', path: '/w', headers: { Host: 'front.com' } }, 'ws transport')
  const grpc = parseVless(`vless://${UUID}@h.com:443?type=grpc&security=tls&serviceName=svc`)
  eq(vlessOutbound(grpc, 'p-1').transport, { type: 'grpc', service_name: 'svc' }, 'grpc transport')
  eq(parseVless(`vless://${UUID}@h.com:443?type=splithttp`).vless.network, 'xhttp', 'splithttp alias')

  const ox = vlessOutbound(f, 'p-abc') as any
  eq(ox.type, 'vless', 'outbound type')
  eq(ox.tag, 'p-abc', 'outbound tag')
  eq([ox.server, ox.server_port, ox.uuid], ['example.org', 443, UUID], 'outbound server')
  eq(ox.tls, { enabled: true, server_name: 'www.apple.com', utls: { enabled: true, fingerprint: 'firefox' }, reality: { enabled: true, public_key: PBK, short_id: '0123abcd' } }, 'reality tls block')
  eq(ox.transport, { type: 'xhttp', mode: 'stream-one', host: 'cdn.example.org', path: '/xh' }, 'xhttp transport')
  eq(ox.flow, undefined, 'no flow invented')
  eq(ox.encryption, undefined, 'no encryption field')

  const ot = vlessOutbound(parseVless(TCP), 'p-t') as any
  eq(ot.transport, undefined, 'tcp: no transport block')
  eq([ot.flow, ot.tls.utls.fingerprint, ot.tls.reality.short_id, ot.encryption], ['xtls-rprx-vision', 'chrome', '', undefined], 'reality+tcp')

  const enc = parseVless(`vless://${UUID}@h.com:443?encryption=mlkem768x25519plus.native.0rtt.KEY`)
  eq((vlessOutbound(enc, 't') as any).encryption, 'mlkem768x25519plus.native.0rtt.KEY', 'pq encryption passed through')

  const extra = encodeURIComponent(JSON.stringify({
    xPaddingBytes: '100-1000',
    headers: { 'X-A': 'b' },
    xmux: { maxConcurrency: '16-32', maxConnections: 0, hMaxRequestTimes: '600-900', hKeepAlivePeriod: 30, bogus: 1 },
    scMaxEachPostBytes: 1000
  }))
  const xe = parseVless(`vless://${UUID}@h.com:443?type=xhttp&security=tls&sni=h.com&extra=${extra}`)
  eq(xe.vless.notApplied, ['xmux.bogus', 'scMaxEachPostBytes'], 'extra: unknown fields named')
  eq((vlessOutbound(xe, 't') as any).transport, {
    type: 'xhttp',
    headers: { 'X-A': 'b' },
    x_padding_bytes: '100-1000',
    xmux: { max_concurrency: '16-32', h_max_request_times: '600-900', h_keep_alive_period: 30 }
  }, 'extra mapped to transport')
  const both = parseVless(`vless://${UUID}@h.com:443?type=xhttp&security=tls&extra=${encodeURIComponent(JSON.stringify({ xmux: { maxConcurrency: 4, maxConnections: 2 } }))}`)
  eq([(vlessOutbound(both, 't') as any).transport.xmux, both.vless.notApplied], [{ max_concurrency: '4' }, ['xmux.maxConnections']], 'xmux exclusive fields')
  eq(parseVless(`vless://${UUID}@h.com:443?type=xhttp&extra=%7Bbroken`).vless.notApplied, ['extra'], 'broken extra noted')

  const list = [FULL, TCP, 'vmess://abc', 'trojan://x@y:1', `vless://${UUID}@h.com:443?security=reality&sni=a`, '# comment', ''].join('\n')
  const s1 = parseSubscription(list)
  eq([s1.items.length, s1.skipped, s1.errors.length], [2, 3, 1], 'subscription mix')
  ok(/pbk/.test(s1.errors[0]), 'bad line reason names pbk')
  const s2 = parseSubscription(Buffer.from(list).toString('base64'))
  eq([s2.items.length, s2.skipped], [2, 3], 'base64 subscription')
  const s3 = parseSubscription(Buffer.from(list).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  eq(s3.items.length, 2, 'base64url unpadded subscription')
  eq(parseSubscription('hello world').items.length, 0, 'garbage gives nothing')
  ok(vlessKey(s1.items[0]) === `${UUID}|example.org|443`, 'dedupe key')

  ok(looksLikeVless(FULL), 'detect link')
  ok(looksLikeVless(Buffer.from(list).toString('base64')), 'detect base64 list')
  ok(looksLikeVless('https://sub.example.org/api/abc'), 'detect sub url')
  ok(!looksLikeVless('[Interface]\nPrivateKey = x'), 'awg conf not vless')
  ok(!looksLikeVless('vpn://AAAAAAAAAAAAAAAAAAAAAAAA'), 'vpn:// not vless')
  ok(isSubscriptionUrl(' https://a.b/c '), 'sub url test')
  ok(!isSubscriptionUrl('http://a.b/c'), 'http is not accepted')

  const sec = { ...f, sub: 'https://sub.example.org/api/TOKEN123' }
  const known = vlessSecrets(sec)
  const logLine = `dial ${UUID} pbk ${PBK} sid 0123abcd via https://sub.example.org/api/TOKEN123?x=1 link ${FULL}`
  const red = redactVless(logLine, known)
  ok(!red.includes(UUID) && !red.includes(PBK) && !red.includes('0123abcd') && !red.includes('TOKEN123') && !red.includes('11111111'), 'redact hides uuid/pbk/sid/url token: ' + red)
  ok(!redactVless(`id ${UUID}`).includes('2222'), 'redact uuid without known list')
  ok(!redactVless(`k ${PBK}`).includes('OKgy'), 'redact base64url key without known list')
  eq(redactVless('route rule ok'), 'route rule ok', 'redact leaves plain text')

  const body = Buffer.from(FULL).toString('base64')
  const mk = (status: number, text: string, headers: Record<string, string> = {}) => new Response(text, { status, headers })
  const seen: string[] = []
  const fakeOk = (async (u: string) => { seen.push(u); return mk(200, body) }) as unknown as typeof fetch
  eq(parseSubscription(await fetchSubscription('https://sub.example.org/x', { fetchImpl: fakeOk })).items.length, 1, 'fetch ok')
  await rejects(() => fetchSubscription('http://sub.example.org/x', { fetchImpl: fakeOk }), 'http refused', /https/)
  await rejects(() => fetchSubscription('https://127.0.0.1/x', { fetchImpl: fakeOk }), 'loopback refused')
  await rejects(() => fetchSubscription('https://192.168.1.5/x', { fetchImpl: fakeOk }), 'lan refused')
  await rejects(() => fetchSubscription('not a url', { fetchImpl: fakeOk }), 'garbage url')
  const redirHttp = (async () => mk(302, '', { location: 'http://evil.example/x' })) as unknown as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: redirHttp }), 'redirect to http refused', /https/)
  const redirLoop = (async () => mk(302, '', { location: 'https://sub.example.org/y' })) as unknown as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: redirLoop }), 'redirect loop stops', /перенаправл/)
  let hop = 0
  const redirOk = (async () => (hop++ === 0 ? mk(301, '', { location: '/final' }) : mk(200, body))) as unknown as typeof fetch
  eq(parseSubscription(await fetchSubscription('https://sub.example.org/x', { fetchImpl: redirOk })).items.length, 1, 'https redirect followed')
  const big = (async () => mk(200, 'a'.repeat(2000))) as unknown as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: big, maxBytes: 1000 }), 'size cap', /большая/)
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: (async () => mk(403, 'no')) as unknown as typeof fetch }), 'http error', /403/)
  const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: hang, timeoutMs: 50 }), 'timeout', /10 секунд/)
  try { await fetchSubscription('https://sub.example.org/secret-token', { fetchImpl: (async () => mk(500, '')) as unknown as typeof fetch }) } catch (e) { ok(!String((e as Error).message).includes('secret-token'), 'error text has no url') }

  console.log(fails ? `${fails}/${n} FAILED` : `all ${n} vless checks passed`)
  process.exit(fails ? 1 : 0)
})()
