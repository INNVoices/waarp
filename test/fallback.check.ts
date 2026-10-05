import { buildConfig, fallbackGroups, parseConf, selTag, tagOf, usedProfiles } from '../src/main/awg'
import { FbTracker } from '../src/main/fallback'
import { DEFAULTS, dropServer, migrate, normalizeProfile, readDisk } from '../src/main/store-core'
import { parseVless } from '../src/main/vless'
import type { Route, Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const conf = (key: string, host: string) => `[Interface]
PrivateKey = ${key}
Address = 10.8.0.7/32
DNS = 1.1.1.1
Jc = 4
[Peer]
PublicKey = q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM=
AllowedIPs = 0.0.0.0/0
Endpoint = ${host}:51820
`
const A = parseConf(conf('gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U=', '203.0.113.15'), 'A')
const B = parseConf(conf('q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM=', '198.51.100.3'), 'B')
const V = parseVless('vless://11111111-2222-3333-4444-555555555555@9.9.9.9:443?type=xhttp&security=reality&pbk=q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3-5cwBM&sid=0123abcd&sni=www.apple.com#V')
const route = (id: string, extra: Partial<Route>): Route => ({ id, kind: 'custom', name: id, value: id + '.com', via: A.id, on: true, ...extra })
const base = (routes: Route[], rest = 'direct'): Settings => ({ ...DEFAULTS, rest, routes, notify: false })
const O = { api: { port: 1, secret: 's' } }

;(async () => {
  const sel = selTag(A.id, B.id)
  const c1: any = buildConfig([A, B], base([route('d', { fallback: B.id }), route('e', {})]), O)
  eq(c1.endpoints.map((x: any) => x.tag).sort(), [tagOf(A.id), tagOf(B.id)].sort(), 'both servers built')
  const s1 = c1.outbounds.find((x: any) => x.tag === sel)
  eq(s1, { type: 'selector', tag: sel, outbounds: [tagOf(A.id), tagOf(B.id)], default: tagOf(A.id), interrupt_exist_connections: true }, 'selector main first, drops stuck connections')
  ok(c1.route.rules.some((x: any) => x.domain_suffix?.includes('d.com') && x.outbound === sel), 'route with fallback goes to selector')
  ok(c1.route.rules.some((x: any) => x.domain_suffix?.includes('e.com') && x.outbound === tagOf(A.id)), 'route without fallback stays on its server')
  ok(c1.dns.servers.some((x: any) => x.tag === 'dns-' + sel && x.detour === sel), 'dns of the group follows the selector')
  ok(c1.dns.rules.some((x: any) => x.domain_suffix?.includes('d.com') && x.server === 'dns-' + sel), 'dns rule uses the group dns')
  ok(!JSON.stringify(c1.route.rules).includes('"outbound":"direct","domain'), 'nothing falls to direct')

  const none: any = buildConfig([A, B], base([route('d', {})]), O)
  eq([none.endpoints.length, none.outbounds.length], [1, 1], 'no fallback: only used server, no selector')
  const only: any = buildConfig([A, B], base([route('d', { fallback: B.id })]), O)
  eq(only.endpoints.length, 2, 'fallback server is built even if no route uses it as main')
  eq(usedProfiles(base([route('d', { fallback: B.id })]), [A, B]).map(p => p.id), [A.id, B.id], 'usedProfiles includes fallback')

  for (const [label, r] of [
    ['direct fallback', route('d', { fallback: 'direct' })],
    ['same server', route('d', { fallback: A.id })],
    ['main direct', route('d', { via: 'direct', fallback: B.id })],
    ['unknown server', route('d', { fallback: 'gone' })]
  ] as [string, Route][]) {
    const cx: any = buildConfig([A, B], base([r]), O)
    ok(!cx.outbounds.some((x: any) => x.type === 'selector'), `${label}: no selector`)
    eq(fallbackGroups([A, B], base([r])), [], `${label}: no group`)
  }
  ok(!JSON.stringify((buildConfig([A, B], base([route('d', { fallback: 'direct' })]), O) as any).route.rules).includes('"outbound":"direct","domain_suffix":["d.com"'), 'direct fallback never routes d.com to direct')

  const off: any = buildConfig([A, B], base([route('d', { fallback: B.id, on: false })]), O)
  eq(off.outbounds.length, 1, 'disabled route makes no group')

  const app: any = buildConfig([A, B], base([{ id: 'app:x', kind: 'app', name: 'X', exe: 'C:\\X\\x.exe', matchDir: 'C:\\X', wholeDir: true, via: A.id, fallback: B.id, on: true }]), O)
  ok(app.route.rules.some((x: any) => x.process_path_regex && x.outbound === sel), 'app route uses selector')

  const mix: any = buildConfig([A, V], base([route('d', { fallback: V.id }), route('e', { via: V.id, fallback: A.id })]), O)
  eq(mix.outbounds.map((x: any) => x.tag).sort(), ['direct', tagOf(V.id), selTag(A.id, V.id), selTag(V.id, A.id)].sort(), 'awg and vless in both directions')
  eq(fallbackGroups([A, V], base([route('d', { fallback: V.id }), route('d2', { fallback: V.id })])).length, 1, 'same pair shares one group')

  const T = new FbTracker(fallbackGroups([A, B], base([route('d', { fallback: B.id })])), 3)
  const calls: string[] = []
  const apply = (okv = true) => async (g: { tag: string }, toFb: boolean) => { calls.push(`${g.tag}:${toFb ? 'fb' : 'main'}`); return okv }
  const up = { [A.id]: 40, [B.id]: 50 }, downA = { [A.id]: undefined, [B.id]: 50 }, downAll = { [A.id]: undefined, [B.id]: undefined }
  eq(await T.step(downA, apply()), [], '1 fail: stay')
  eq(await T.step(downA, apply()), [], '2 fails: stay')
  eq(await T.step(up, apply()), [], 'main back: counter resets')
  await T.step(downA, apply()); await T.step(downA, apply())
  eq(calls, [], 'no switch before 3 in a row')
  const sw = await T.step(downA, apply())
  eq([sw.length, sw[0]?.toFb, calls], [1, true, [`${sel}:fb`]], '3 in a row: switch to fallback')
  eq(T.active().length, 1, 'tracker on fallback')
  eq(await T.step(downA, apply()), [], 'still down: stay on fallback')
  await T.step(up, apply()); await T.step(up, apply())
  eq(T.active().length, 1, '2 ok: stay on fallback')
  await T.step(downA, apply())
  await T.step(up, apply()); await T.step(up, apply())
  eq(T.active().length, 1, 'flap resets the return counter')
  const back = await T.step(up, apply())
  eq([back.length, back[0]?.toFb, T.active().length], [1, false, 0], '3 ok in a row: back to main')

  const T2 = new FbTracker(fallbackGroups([A, B], base([route('d', { fallback: B.id })])), 3)
  for (let i = 0; i < 5; i++) await T2.step(downAll, apply())
  eq(T2.active().length, 0, 'both servers down: no switch, nothing leaks')
  const T3 = new FbTracker(fallbackGroups([A, B], base([route('d', { fallback: B.id })])), 3)
  for (let i = 0; i < 4; i++) await T3.step(downA, apply(false))
  eq(T3.active().length, 0, 'failed switch is not recorded')
  eq((await T3.step(downA, apply(true))).length, 1, 'failed switch is retried on the next ping')

  const prof = (x: any) => JSON.stringify(x)
  const legacy = { ...A } as any
  delete legacy.kind
  eq(normalizeProfile(legacy).kind, 'awg', 'profile without kind becomes awg')
  eq(normalizeProfile(V).kind, 'vless', 'vless kept')
  eq(normalizeProfile(A), A, 'awg untouched')
  const open = (sealed: string) => sealed.slice(2)
  const disk = prof({ settings: { rest: 'direct', routes: [route('d', { fallback: B.id })], ruDirect: true, dnsAll: false, tray: true, autoConnect: false, autostart: false, notify: true }, profiles: ['p:' + prof(legacy), 'p:' + prof(V)], bounds: { x: 1, y: 2, width: 3, height: 4 } })
  const rd = readDisk(disk, open)
  eq(rd.profiles.map(p => p.kind), ['awg', 'vless'], 'readDisk: migrates kind, keeps vless')
  eq([rd.settings.routes[0].fallback, rd.bounds?.width], [B.id, 3], 'readDisk: fallback and bounds kept')
  const old = readDisk(prof({ settings: { mode: 'only', profileId: 'x', apps: [{ id: 'd', name: 'D', exe: 'C:\\d.exe' }], presets: ['telegram'], custom: ['a.com'] }, profiles: [] }), open)
  eq([old.settings.routes.length, old.settings.routes[0].via], [3, 'x'], 'readDisk: pre-routes settings are migrated')
  eq(migrate({}, undefined).routes, [], 'migrate empty')
  const dirty = migrate({
    rest: 'bad value with spaces',
    routes: [
      { id: 'bad-app', kind: 'app', name: 'bad', exe: 'relative.exe', via: 'direct', on: true },
      { id: 'bad-preset', kind: 'preset', name: 'bad', preset: 'invented', via: 'direct', on: true },
      { id: 'bad-custom', kind: 'custom', name: 'bad', value: '999.999.1.1', via: 'direct', on: true },
      { id: 'good-app', kind: 'app', name: 'good', exe: 'C:\\Apps\\good.exe', via: A.id, on: true }
    ],
    groups: [
      { id: 'not-a-group', name: 'bad', policy: 'first', members: [A.id] },
      { id: 'g-good', name: 'good', policy: 'first', members: [A.id, A.id] }
    ]
  })
  eq([dirty.rest, dirty.routes.map(r => r.id), dirty.groups.map(g => [g.id, g.members])], ['direct', ['good-app'], [['g-good', [A.id]]]], 'persisted settings get the same semantic limits as IPC patches')
  let bad = false
  try { readDisk('{broken', open) } catch { bad = true }
  ok(bad, 'readDisk throws on broken file (Store keeps defaults)')

  const dr = dropServer(base([route('d', { fallback: B.id }), route('e', { via: B.id, fallback: A.id }), route('f', {})], B.id), B.id)
  // C03: without a replacement the cards keep pointing at the removed id (compiled to BLOCK), never direct
  eq([dr.rest, dr.routes[0].fallback, dr.routes[1].via, dr.routes[1].on, dr.routes[2].fallback], [B.id, undefined, B.id, true, undefined], 'C03: dropServer without replacement keeps cards on the gone id (blocked), clears fallback')
  const rr = dropServer(base([route('e', { via: B.id })], B.id), B.id, A.id)
  eq([rr.rest, rr.routes[0].via], [A.id, A.id], 'C03: dropServer with replacement moves rest and cards')
  eq(dropServer(base([route('d', { fallback: B.id })]), 'zzz').routes[0].fallback, B.id, 'dropServer leaves unrelated fallback')

  console.log(fails ? `${fails}/${n} FAILED` : `all ${n} fallback checks passed`)
  process.exit(fails ? 1 : 0)
})()

// C08: tunnel health rounds
import { Health } from '../src/main/health'
{
  const h = new Health()
  eq(h.step({ a: 50 }, ['a']).a, 'ok', 'C08: answered round = ok')
  eq(h.step({}, ['a']).a, 'degraded', 'C08: one failed round = degraded, not down')
  eq(h.step({}, ['a']).a, 'down', 'C08: two failed rounds in a row = down')
  eq(h.step({ a: 9 }, ['a']).a, 'ok', 'C08: recovers on the next answer')
  eq(h.step({}, ['b'], new Set(['b'])).b, 'busy', 'C08: busy key is not checked')
}
