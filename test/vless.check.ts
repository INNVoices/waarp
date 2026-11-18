import { ConfError } from '../src/main/conf-error'
import { createConnection, createServer } from 'node:net'
import { configOf, techOf } from '../src/main/techview'
import { activeTune, applyTune, profileSig, provenTune, pruneTunes, tuned, variants, TUNE_MAX_VARIANTS, TUNE_TTL_MS, TUNE_RESULT_TTL_MS } from '../src/main/tune'
import { parseAny } from '../src/main/links'
import { parseConf } from '../src/main/awg'
import { fetchSubscription, isSubscriptionUrl, looksLikeVless, parseSubscription, parseVless, pinnedAddressLookup, redactVless, vlessKey, vlessOutbound, vlessSecrets } from '../src/main/vless'

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
  eq([min.vless.server, min.vless.network, min.vless.fp, min.vless.sid, min.vless.flow], ['2001:db8::1', 'tcp', 'ios', '', undefined], 'minimal: defaults, no guessed flow')
  eq(min.name, 'Сервер', 'fallback name')
  const plain = parseVless(`vless://${UUID}@h.com:80`)
  eq(plain.vless.security, 'none', 'plain security')
  eq(parseVless(`VLESS://${UUID}@h.com:80`).vless.server, 'h.com', 'URI scheme is case insensitive')
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
  for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:c0a8:105]', '[fc00::1]', '[fe80::1]', '[ff02::1]', '100.64.0.1', 'localhost.']) {
    const before = seen.length
    await rejects(() => fetchSubscription(`https://${host}/x`, { fetchImpl: fakeOk }), 'non-public mapped/local address refused: ' + host, /локальную/)
    ok(seen.length === before, 'private destination is refused before the transport is called: ' + host)
  }
  await rejects(() => fetchSubscription('https://user:pass@sub.example.org/x', { fetchImpl: fakeOk }), 'URL credentials cannot be silently omitted')
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
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: hang, timeoutMs: 50 }), 'timeout', /вовремя/)
  const ignoresSignal = (async () => new Promise<Response>(() => undefined)) as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: ignoresSignal, timeoutMs: 20 }), 'deadline still settles if the transport does not acknowledge abort', /вовремя/)
  let canceledRedirect = false
  let redirectCall = 0
  const redirectBody = (async () => redirectCall++ === 0
    ? new Response(new ReadableStream({ cancel: () => { canceledRedirect = true } }), { status: 302, headers: { location: '/final' } })
    : mk(200, body)) as typeof fetch
  await fetchSubscription('https://sub.example.org/x', { fetchImpl: redirectBody })
  ok(canceledRedirect, 'redirect response body is canceled before the next request')
  let canceledHang = false
  const bodyHang = (async () => new Response(new ReadableStream({ cancel: () => { canceledHang = true } }))) as typeof fetch
  await rejects(() => fetchSubscription('https://sub.example.org/x', { fetchImpl: bodyHang, timeoutMs: 20 }), 'body read obeys the same deadline', /вовремя/)
  ok(canceledHang, 'timed-out response reader is canceled')
  // Exercise Node's real autoSelectFamily connector against a loopback-only fixture. No external DNS/network.
  const local = createServer(socket => socket.end())
  await new Promise<void>((resolve, reject) => { local.once('error', reject); local.listen(0, '127.0.0.1', resolve) })
  try {
    const address = local.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind')
    let allRequested = false
    const fixed = pinnedAddressLookup([{ address: '127.0.0.1', family: 4 }])
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: 'no-dns-needed.example.test', port: address.port, autoSelectFamily: true,
        lookup: (hostname, options, callback) => { allRequested = options.all === true; fixed(hostname, options, callback) } })
      socket.setTimeout(1000, () => socket.destroy(new Error('local connector timeout')))
      socket.once('error', reject)
      socket.once('connect', () => { socket.destroy(); resolve() })
    })
    ok(allRequested, 'pinned lookup supports Node dual-stack all:true without ERR_INVALID_IP_ADDRESS')
  } finally { await new Promise<void>(resolve => local.close(() => resolve())) }
  try { await fetchSubscription('https://sub.example.org/secret-token', { fetchImpl: (async () => mk(500, '')) as unknown as typeof fetch }) } catch (e) { ok(!String((e as Error).message).includes('secret-token'), 'error text has no url') }

  const base = parseVless(FULL)
  const view = { ...base, vless: { ...base.vless, encryption: 'mlkem768x25519plus.native.secret-material' } }
  const tech = techOf(view).tech
  ok(tech.some(([k, v]) => k === 'fp' && v === 'firefox') && tech.some(([k, v]) => k === 'sni' && v === 'www.apple.com'), 'technical view shows fingerprint and SNI')
  ok(!JSON.stringify(tech).includes(UUID) && !JSON.stringify(tech).includes('secret-material'), 'technical view has no UUID or encryption key')
  const cfg = JSON.stringify(configOf(view))
  ok(!cfg.includes(UUID) && !cfg.includes('secret-material') && cfg.includes('example.org'), 'developer config hides secrets, keeps endpoint')
  ok(cfg.includes(PBK), 'REALITY public key stays visible: it is not a secret')

  // ---- network-scoped tune (E3)
  const vs = variants(base)
  ok(vs.length > 0 && vs.length <= TUNE_MAX_VARIANTS, 'a bounded set of variants')
  ok(vs.every(v => !v.patch.fp || ['ios', 'edge', 'firefox', 'chrome', 'safari'].includes(v.patch.fp)) && !vs.some(v => v.patch.fp === base.vless.fp), 'only supported fingerprints, never the current one again')
  const tunedOut = vlessOutbound(applyTune(base, { fp: 'safari', recordFragment: true }) as typeof base, 'p') as any
  ok(tunedOut.tls.utls.fingerprint === 'safari' && tunedOut.tls.record_fragment === true && tunedOut.tls.reality.public_key === base.vless.pbk, 'tune changes only client TLS knobs, REALITY stays')
  eq(base.vless.fp, 'firefox', 'the stored profile is never modified')
  const entry = { net: 'netA', sig: profileSig(base), label: 'fp safari', patch: { fp: 'safari' }, at: 1000 }
  eq((tuned([base], { [base.id]: entry }, 'netA', 2000)[0] as typeof base).vless.fp, 'safari', 'tune applies on its network')
  eq((tuned([base], { [base.id]: entry }, 'netB', 2000)[0] as typeof base).vless.fp, 'firefox', 'another network uses the profile as is')
  eq((tuned([base], { [base.id]: entry }, undefined, 2000)[0] as typeof base).vless.fp, 'firefox', 'unknown network: no tune')
  eq((tuned([base], { [base.id]: entry }, 'netA', 1000 + TUNE_TTL_MS + 1)[0] as typeof base).vless.fp, 'firefox', 'an old tune expires')
  const changed = { ...base, vless: { ...base.vless, sni: 'other.example' } }
  eq((tuned([changed], { [base.id]: entry }, 'netA', 2000)[0] as typeof base).vless.fp, 'firefox', 'a changed profile (subscription update) drops the tune')
  eq(Object.keys(pruneTunes({ [base.id]: entry }, [changed], 2000)), [], 'stale tunes are pruned')
  eq(pruneTunes(null, [base], 2000), {}, 'malformed disk cache cannot crash startup')
  eq(pruneTunes({ [base.id]: null }, [base], 2000), {}, 'null tune entry is ignored')
  eq(activeTune(base, { ...entry, patch: { fp: 'edge' } }, 'netA', 2000), undefined, 'cache cannot inject a variant that was never offered')
  eq(activeTune(base, { ...entry, at: 3000 }, 'netA', 2000), undefined, 'future timestamp is not fresh evidence')
  const proof = { id: base.id, net: 'netA', sig: profileSig(base), at: 1000, results: [{ label: '', ms: null }, { label: 'fp safari', ms: 0 }] }
  eq(provenTune(proof, base, 'netA', 'fp safari', 2000)?.patch, { fp: 'safari' }, 'only measured successful variant can be applied; zero latency is valid')
  eq(provenTune(undefined, base, 'netA', 'fp safari', 2000), undefined, 'a known variant label alone is not permission to apply')
  eq(provenTune(proof, base, 'netB', 'fp safari', 2000), undefined, 'a result cannot be rebound to the network present at apply time')
  eq(provenTune(proof, changed, 'netA', 'fp safari', 2000), undefined, 'profile edit invalidates a measured result before apply')
  eq(provenTune(proof, base, 'netA', 'fp safari', 1000 + TUNE_RESULT_TTL_MS), undefined, 'expired measurement must be repeated')
  eq(provenTune({ ...proof, results: [{ label: '', ms: 25 }, { label: 'fp safari', ms: 10 }] }, base, 'netA', 'fp safari', 2000), undefined, 'working original is not replaced by tuning')
  eq(provenTune({ ...proof, results: [{ label: '', ms: null }, { label: 'fp safari', ms: null }] }, base, 'netA', 'fp safari', 2000), undefined, 'failed variant cannot be applied')
  for (const link of [`hysteria2://fixture@example.org:443`, `tuic://${UUID}:fixture@example.org:443`]) {
    const quic = parseAny(link).items[0]
    ok(!!quic, 'QUIC tuning fixture imports')
    eq(variants(quic), [], 'QUIC profiles never receive incompatible uTLS/TCP fragmentation variants')
    eq(applyTune(quic, { fp: 'safari', recordFragment: true }), quic, 'even a stale QUIC tuning patch is a no-op')
  }
  const awg = parseConf(`[Interface]
PrivateKey = gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U=
Address = 10.8.0.7/32
Jc = 4
Jmin = 10
Jmax = 50
S1 = 20
S2 = 30
H1 = 1
H2 = 2
H3 = 3
H4 = 4

[Peer]
PublicKey = q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM=
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.10:51820
`, 'A')
  const av = variants(awg)
  ok(av.length > 0 && av.every(v => Object.keys(v.patch).every(k => ['jc', 'jmin', 'jmax', 'mtu'].includes(k))), 'AWG variants touch only client-side junk and MTU')
  const ta = applyTune(awg, av[0].patch) as typeof awg
  ok(ta.awg.s1 === 20 && ta.awg.h1 === awg.awg.h1 && ta.privateKey === awg.privateKey, 'server-matched S/H fields and keys never change')

  console.log(fails ? `${fails}/${n} FAILED` : `all ${n} vless checks passed`)
  process.exit(fails ? 1 : 0)
})()
