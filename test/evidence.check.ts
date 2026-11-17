// W3.1: layered Direct evidence + cautious classifier (offline: network is a fake)
import { classify, failingLayer, provenPath, type DirectObs } from '../src/shared/evidence'
import { parseProbe, probeLayers, type Net } from '../src/main/layered'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
const err = (code: string) => Object.assign(new Error(code), { code })
const never = <T>() => new Promise<T>(() => {})

const net = (o: Partial<Net>): Net => ({
  dnsSystem: async () => ['1.2.3.4'], dnsDoh: async () => ['1.2.3.4'], tcp: async () => {}, tls: async () => {}, http: async () => ({ status: 200 }), ...o,
})

;(async () => {
  // ---- prober
  const allOk = await probeLayers('https://Example.org/path', net({}), 50)
  eq([allOk.dnsSystem.result, allOk.dnsDoh.result, allOk.tcp.result, allOk.tls.result, allOk.http.result], ['ok', 'ok', 'ok', 'ok', 'ok'], 'all layers ok')
  let seenHost = ''
  await probeLayers('https://Example.org/a?b', net({ tls: async (_ip, h) => { seenHost = h } }), 50)
  eq(seenHost, 'example.org', 'SNI = bare lower-case host')

  const sysNx = await probeLayers('x.org', net({ dnsSystem: async () => { throw err('ENOTFOUND') } }), 50)
  eq([sysNx.dnsSystem, sysNx.dnsDoh.result, sysNx.tcp.result], [{ result: 'fail', code: 'nxdomain' }, 'ok', 'ok'], 'system NX, DoH answers, TCP continues on the DoH address')

  const rst = await probeLayers('x.org', net({ tls: async () => { throw err('ECONNRESET') } }), 50)
  eq([rst.tcp.result, rst.tls, rst.http.result], ['ok', { result: 'fail', code: 'reset' }, 'skipped'], 'TLS reset stops before HTTP')

  const slow = await probeLayers('x.org', net({ tcp: () => never<void>() }), 30)
  eq([slow.tcp.result, slow.tls.result], ['timeout', 'skipped'], 'a hanging layer becomes timeout, later layers skipped')

  const both = await probeLayers('x.org', net({ dnsSystem: async () => [], dnsDoh: async () => [] }), 50)
  eq([both.dnsSystem.code, both.tcp.result], ['empty', 'skipped'], 'no address anywhere: nothing else is tried')

  // ---- one target: scheme, port, path, IPv6
  const seen: string[] = []
  const rec = net({ tcp: async (ip, port) => { seen.push(`tcp ${ip}:${port}`) }, tls: async (_ip, h, port) => { seen.push(`tls ${h}:${port}`) }, http: async (url, m) => { seen.push(`${m} ${url}`); return { status: 200 } } })
  const plain = await probeLayers('http://Example.org:8080/a?b=1', rec, 50)
  eq([plain.tls.result, seen], ['na', ['tcp 1.2.3.4:8080', 'HEAD http://example.org:8080/a?b=1']], 'http://…:8080/a stays HTTP, port 8080, path kept, TLS not applicable')
  seen.length = 0
  await probeLayers('https://example.org:8443/x', rec, 50)
  eq(seen, ['tcp 1.2.3.4:8443', 'tls example.org:8443', 'HEAD https://example.org:8443/x'], 'https on 8443 uses that port and the host as SNI')
  seen.length = 0
  const v6 = await probeLayers('https://[2001:db8::1]/', rec, 50)
  eq([v6.dnsSystem.result, seen[0], seen[1]], ['na', 'tcp 2001:db8::1:443', 'tls :443'], 'IPv6 literal: no DNS, default port, no SNI')
  eq(parseProbe('https://u:p@example.org/a?token=1#x')?.shown, 'https://example.org/a', 'shown target drops credentials, query and fragment')

  // ---- HTTP answers are not all "open"
  const st = async (codes: number[], location?: string) => { let i = 0; return probeLayers('x.org', net({ http: async () => ({ status: codes[Math.min(i++, codes.length - 1)], ...(location ? { location } : {}) }) }), 50) }
  eq((await st([403])).http, { result: 'fail', status: 403 }, '403 is an answer, not access')
  eq((await st([451])).http, { result: 'fail', status: 451 }, '451 is shown as is')
  eq((await st([503])).http, { result: 'fail', status: 503 }, '5xx is not access')
  eq((await st([405, 200])).http, { result: 'ok', status: 200 }, 'HEAD 405 retries once with GET')
  eq((await st([405, 405])).http, { result: 'fail', status: 405, code: 'method' }, 'GET also refused: check method not supported')
  eq((await st([301], 'https://block.example/stub')).http, { result: 'ok', status: 301, to: 'block.example' }, 'redirect shows where it goes')
  eq(failingLayer({ ...(await st([405, 405])) }), undefined, 'unsupported check method is never a restriction')
  const diff = await probeLayers('x.org', net({ dnsSystem: async () => ['10.0.0.1'], dnsDoh: async () => ['20.0.0.2'] }), 50)
  eq([diff.dnsDiffer, classify(diff, { a: 50 }).kind], [true, 'direct_ok'], 'different valid DNS answers are a note; the site still opens')
  const certFail = await probeLayers('x.org', net({ tls: async () => { throw err('CERT_HAS_EXPIRED') } }), 50)
  eq(certFail.tls, { result: 'fail', code: 'cert' }, 'certificate error is its own result')

  // ---- the button offers the path that was proven, never untested Auto
  eq(provenPath({ kind: 'restricted_direct', layer: 'tls', via: ['a', 'b'] }, [{ id: 'a', revoked: true }, { id: 'b' }]), 'b', 'the fastest proven own path that still exists')
  eq(provenPath({ kind: 'path_only', via: ['gone'] }, [{ id: 'b' }]), undefined, 'a deleted profile is never offered')
  eq(provenPath({ kind: 'site_down' }, [{ id: 'b' }]), undefined, 'no path when nothing answered')
  eq(provenPath({ kind: 'direct_ok' }, [{ id: 'b' }]), undefined, 'no path when Direct already works')

  // ---- classifier
  const P = { a: 50, b: null }
  eq(classify(allOk, P), { kind: 'direct_ok' }, 'direct works')
  eq(classify(rst, P), { kind: 'restricted_direct', layer: 'tls', via: ['a'] }, 'TLS reset + a path works -> restricted at tls')
  eq(classify(sysNx, { a: 80, b: 40 }), { kind: 'restricted_direct', layer: 'dns', via: ['b', 'a'] }, 'system DNS missing while DoH answers -> dns, fastest path first')
  eq(classify(rst, { a: null, b: null }), { kind: 'site_down' }, 'fails everywhere with a hard failure -> site down')
  eq(classify(slow, { a: null }), { kind: 'unclear', why: 'timeouts' }, 'only timeouts everywhere -> unclear, not site down')
  eq(classify(slow, { a: 60 }), { kind: 'path_only', via: ['a'] }, 'Direct timeout + path works -> contrast only, no layer named')
  eq(classify(rst, {}), { kind: 'unclear', why: 'no_paths' }, 'no eligible paths -> unclear')
  eq(failingLayer(both), undefined, 'both resolvers empty is not a restriction')

  const refused: DirectObs = { ...allOk, tcp: { result: 'fail', code: 'refused' }, tls: { result: 'skipped' }, http: { result: 'skipped' } }
  eq(classify(refused, P), { kind: 'restricted_direct', layer: 'tcp', via: ['a'] }, 'TCP refused + path works -> tcp')
  const unreach: DirectObs = { ...refused, tcp: { result: 'fail', code: 'unreachable' } }
  eq(classify(unreach, P), { kind: 'path_only', via: ['a'] }, 'unreachable is not named as a restriction')
  const cert: DirectObs = { ...allOk, tls: { result: 'fail', code: 'cert' }, http: { result: 'skipped' } }
  eq(classify(cert, P), { kind: 'path_only', via: ['a'] }, 'a certificate problem is not called a block')

  // W3.3b: DoH is independent evidence; its absence never becomes a DNS restriction
  const sysDown = await probeLayers('x.org', net({ dnsSystem: async () => { throw err('ECONNREFUSED') }, dnsDoh: async () => ['5.6.7.8'] }), 50)
  eq(classify(sysDown, { a: 70 }), { kind: 'restricted_direct', layer: 'dns', via: ['a'] }, 'system DNS unavailable while DoH answers: DNS contrast observed')
  const dohDown = await probeLayers('x.org', net({ dnsSystem: async () => [], dnsDoh: async () => { throw new AggregateError([err('ECONNREFUSED'), err('ECONNREFUSED')]) } }), 50)
  ok(classify(dohDown, { a: 70 }).kind === 'path_only', 'DoH unreachable never becomes restricted_direct/dns')
  const dohSlow = await probeLayers('x.org', net({ dnsSystem: async () => { throw err('ENOTFOUND') }, dnsDoh: () => never<string[]>() }), 30)
  eq([dohSlow.dnsDoh.result, failingLayer(dohSlow)], ['timeout', undefined], 'DoH timeout is no evidence')

  console.log(`evidence.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
