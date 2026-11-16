// Native boundary regressions: unknown Windows state must not become a clean snapshot.
// Inject complete/partial OS responses; no PowerShell, socket, adapter, or route mutations.
import { adapters, adapterInspectionNotice, conflicts, hasFullDefaultRoute, parseAdapterSnapshot } from '../src/main/guard'
import { defaultRoutes, parseDefaultRoutes, parseTunSnapshot, tunPreflight, tunSnapshot } from '../src/main/tun'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

;(async () => {
  eq(await adapters(async () => ({ ok: 1, adapters: [] })), [], 'a complete empty adapter snapshot remains distinguishable from failure')
  for (const raw of [undefined, [], { ok: 1 }, { ok: 0, adapters: [] }, { ok: 1, adapters: [{ name: 'WireGuard', desc: '', ipv4: [], fullRoute: false }] }]) {
    eq(parseAdapterSnapshot(raw), undefined, 'partial adapter snapshot is unknown')
    let refused = false
    try { await adapters(async () => raw) } catch { refused = true }
    ok(refused, 'unknown adapter evidence rejects instead of admitting an empty list')
  }
  let failedRead = false
  try { await adapters(async () => { throw new Error('native read failed') }) } catch { failedRead = true }
  ok(failedRead, 'a failed Windows command cannot become a conflict-free machine')
  eq([adapterInspectionNotice(false).level, adapterInspectionNotice(true).level], ['block', 'warn'], 'inspection failure blocks a new start while preserving an already running session')

  eq(hasFullDefaultRoute(['0.0.0.0/1']), false, 'one IPv4 half is not full machine routing')
  eq(hasFullDefaultRoute(['128.0.0.0/1']), false, 'the other IPv4 half alone is not full machine routing')
  eq(hasFullDefaultRoute(['0.0.0.0/1', '128.0.0.0/1']), true, 'a complementary IPv4 pair covers the family')
  eq(hasFullDefaultRoute(['::/1']), false, 'one IPv6 half is not a full default')
  eq(hasFullDefaultRoute(['::/1', '8000::/1']), true, 'IPv6 split defaults cover the family')
  const v6 = parseAdapterSnapshot({ ok: 1, adapters: [{ name: 'WireGuard', desc: 'Intel WireGuard VPN', ipv4: [], prefixes: ['::/0'] }] })
  ok(v6?.[0].fullRoute, 'IPv6-only full routing survives inspection without IPv4 addresses or vendor-name exceptions')
  eq(conflicts([], v6 ?? []).map(x => x.level), ['block'], 'an IPv6-only VPN participates in whole-machine conflict policy')
  const split = parseAdapterSnapshot({ ok: 1, adapters: [
    { name: 'WireGuard A', desc: '', ipv4: [], prefixes: ['0.0.0.0/1'] },
    { name: 'WireGuard B', desc: '', ipv4: [], prefixes: ['128.0.0.0/1'] }
  ] })
  eq(conflicts([], split ?? []).map(x => x.level), ['info', 'info'], 'halves on different interfaces are not combined into false full-route evidence')
  eq(parseAdapterSnapshot({ ok: 1, adapters: [{ name: 'Wi-Fi', desc: '', ipv4: ['999.0.0.1'], prefixes: [] }] }), undefined, 'invalid address evidence is rejected')

  const clean = { ok: 1, adapters: [], addrs: [], routes: [] }
  eq(parseTunSnapshot(clean), { adapters: [], addrs: [], routes: [] }, 'complete empty TUN snapshot is clean')
  for (const raw of [undefined, { ok: 1 }, { ...clean, addrs: undefined }, { ...clean, adapters: [null] }, { ...clean, addrs: [{ ip: 'garbage' }] }, { ...clean, routes: [{ prefix: '172.19.77.0/33' }] }]) {
    eq(tunPreflight(await tunSnapshot(async () => raw)).ok, false, 'partial or malformed TUN evidence refuses the new tunnel')
  }
  eq(await tunSnapshot(async () => { throw new Error('native read failed') }), undefined, 'failed TUN inspection remains unknown')
  const stale = parseTunSnapshot({ ...clean, adapters: [{ name: 'waarp', status: 'Disconnected' }] })
  const decision = tunPreflight(stale)
  ok(!decision.ok && decision.kind === 'tun_stale', 'Windows casing variation still detects the leftover owned adapter')

  const routes = [{ alias: 'Wi-Fi', nextHop: 'fe80::1%12', up: true }, { alias: 'Ethernet', nextHop: '192.168.1.1', up: false }]
  eq(await defaultRoutes(async () => ({ ok: 1, routes })), routes, 'IPv4 and scoped IPv6 route evidence is preserved')
  eq(await defaultRoutes(async () => ({ ok: 1, routes: [] })), [], 'complete no-route result differs from failed inspection')
  for (const raw of [undefined, [], { ok: 1 }, { ok: 1, routes: [{ ...routes[0], up: 'true' }] }, { ok: 1, routes: [{ ...routes[0], nextHop: 'bad' }] }]) {
    eq(parseDefaultRoutes(raw), undefined, 'partial or mistyped default-route evidence remains unknown')
  }
  eq(await defaultRoutes(async () => { throw new Error('native read failed') }), undefined, 'failed default-route query remains unknown')

  console.log(`network-inspection.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
