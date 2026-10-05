// Hardening R5: the bounded Auto live pool. Logical Auto membership stays the full own library; the core config gets
// at most AUTO_LIVE_MAX Auto-only endpoints plus whatever explicit routing already needs. Offline, pure.
import { generateKeyPairSync } from 'node:crypto'
import { buildConfig, parseConf, runtimeAutoLive, usedProfiles, withoutAuto } from '../src/main/awg'
import { DEFAULTS } from '../src/main/store-core'
import { AUTO_ID, AUTO_LIVE_MAX, autoLivePool, autoMembers, CHECK_BUDGET, checkSample } from '../src/shared/groups'
import { compilePlan } from '../src/shared/plan'
import type { Profile, Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const pub = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const key = generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
const mk = (i: number): Profile => ({ ...parseConf(`[Interface]\nPrivateKey = ${key}\nAddress = 10.${(i >> 8) & 255}.${i & 255}.2/32\n[Peer]\nPublicKey = ${pub}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 198.51.100.${(i % 250) + 1}:${40000 + i}\n`, 'P' + i), id: 'p' + i } as Profile)
const lib = (k: number) => Array.from({ length: k }, (_, i) => mk(i))
const autoRoute = (extra: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, rest: 'direct', routes: [{ id: 'r1', kind: 'custom', name: 'a', value: 'example.com', via: AUTO_ID, on: true }], ...extra })
const api = { port: 19001, secret: 's' }

// ---- the pool itself
for (const k of [0, 1, 16, 17, 1000]) {
  const ps = lib(k)
  const pool = autoLivePool(ps, [])
  eq(pool.length, Math.min(k, AUTO_LIVE_MAX), `${k} candidates -> pool ${Math.min(k, AUTO_LIVE_MAX)}`)
  eq(autoMembers(ps).length, k, `${k} candidates: logical membership unchanged`)
}
{
  const ps = lib(100)
  eq(autoLivePool(ps, []), autoLivePool(ps, []), 'stable: identical inputs give the identical pool (no random)')
  eq(autoLivePool(ps, []).slice(0, 3), ['p0', 'p1', 'p2'], 'stable library order')
  const prev = autoLivePool(ps, [], 'p77')
  eq([prev[0], prev.length, prev.includes('p77')], ['p77', 16, true], 'the previous in-process Auto pick comes first and stays')
  eq(autoLivePool(ps, [], 'p77'), prev, 'same prev (restart / resume) -> same pool, no churn')
  const req = autoLivePool(ps, ['p50', 'p60'])
  eq([req.includes('p50'), req.includes('p60'), req.length], [true, true, 18], 'explicitly live profiles join Auto at no extra cost (16 + 2)')
  const mixed = [...lib(3), { ...mk(90), id: 'pub', source: 'public' } as Profile, { ...mk(91), id: 'rev', revoked: true } as Profile]
  ok(!autoLivePool(mixed, ['pub', 'rev']).some(id => id === 'pub' || id === 'rev'), 'public / revoked never enter the pool, even when named')
  ok(!autoLivePool(ps, [], 'gone').includes('gone'), 'a stale prev that is no longer eligible is ignored')
}

// ---- config generation
for (const k of [100, 1000]) {
  const ps = lib(k)
  const s = autoRoute({ routes: [...autoRoute().routes, { id: 'r2', kind: 'custom', name: 'b', value: 'example.org', via: ps[k - 1].id, on: true }] })
  const before = JSON.stringify(s)
  const live = runtimeAutoLive(s, ps)
  const c: any = buildConfig(ps, s, { api, autoLive: live })
  ok(c.endpoints.length <= AUTO_LIVE_MAX + 1, `${k}: config endpoints bounded (${c.endpoints.length})`)
  ok(c.endpoints.some((e: any) => e.tag === 'p-' + ps[k - 1].id), `${k}: explicit route profile outside the pool is still live`)
  const auto = c.outbounds.find((o: any) => o.tag === 'grp-' + AUTO_ID || (o.type === 'selector' && o.outbounds?.length && o.tag.includes(AUTO_ID)))
  ok(auto && auto.outbounds.length <= AUTO_LIVE_MAX + 1, `${k}: Auto selector holds the live pool only`)
  eq(JSON.stringify(s), before, `${k}: settings are not rewritten`)
  eq(compilePlan(s, ps).standbyProfiles.length, k - 1, `${k}: the logical plan still lists every Auto candidate`)
  ok(compilePlan(s, ps, { autoLive: live }).standbyProfiles.length <= AUTO_LIVE_MAX, `${k}: the runtime plan lists the pool only`)
  eq(usedProfiles(s, ps).length, k, `${k}: usedProfiles without autoLive stays logical`)
  ok(usedProfiles(s, ps, { autoLive: live }).length <= AUTO_LIVE_MAX + 1, `${k}: usedProfiles with autoLive is bounded`)
}
{
  // fail closed: no eligible candidate -> the Auto route is blocked, never direct / public
  const ps = [{ ...mk(1), id: 'pub', source: 'public' } as Profile]
  const s = autoRoute()
  const c: any = buildConfig(ps, s, { api, autoLive: runtimeAutoLive(s, ps) })
  const r = c.route.rules.find((x: any) => JSON.stringify(x).includes('example.com'))
  ok(r && r.outbound !== 'direct' && !String(r.outbound).startsWith('p-'), 'no candidate: Auto route fails closed (' + JSON.stringify(r?.outbound ?? r?.action) + ')')
  eq(c.endpoints.length, 0, 'no candidate: no endpoint instantiated')
}

// ---- tunnel-closed checker: bounded per round, really rotating, required first
{
  const ps = lib(1000)
  const s = autoRoute({ routes: [...autoRoute().routes, { id: 'r2', kind: 'custom', name: 'b', value: 'example.org', via: 'p999', on: true }] })
  const required = usedProfiles(withoutAuto(s), ps).map(p => p.id)
  eq(required, ['p999'], 'Auto standby is not "in use": only the explicit route profile is required')
  const all = ps.map(p => p.id)
  const r1 = checkSample(required, all, 0), r2 = checkSample(required, all, r1.cursor)
  eq([r1.ids.length, r2.ids.length], [CHECK_BUDGET, CHECK_BUDGET], '1000 candidates -> at most 8 per round')
  eq([r1.ids[0], r2.ids[0]], ['p999', 'p999'], 'the required explicit profile stays first every round')
  ok(r1.ids.slice(1).every(id => !r2.ids.includes(id)), 'two rounds advance through different idle profiles')
  eq(checkSample(Array.from({ length: 20 }, (_, i) => 'p' + i), all, 0).ids.length, CHECK_BUDGET, 'even many required profiles stay within the budget')
  eq(checkSample([], [], 5), { ids: [], cursor: 0 }, 'empty library -> nothing')
}

console.log(`autopool.check: ${n} checks`)
if (fails) { console.error(`${fails} failed`); process.exit(1) }
