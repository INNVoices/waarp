// W2.1: effective state per route from the plan + live evidence (pure, offline)
import { effectiveRoutes, moodOf, REST_ID } from '../src/shared/effective'
import { DEFAULTS } from '../src/main/store-core'
import type { Route, Settings, Status } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const r = (id: string, via: string, extra: Partial<Route> = {}): Route => ({ id, kind: 'custom', name: id, value: id + '.com', via, on: true, ...extra })
const S = (routes: Route[], rest = 'direct', groups: Settings['groups'] = []): Settings => ({ ...DEFAULTS, rest, routes, groups })
const P = [{ id: 'a' }, { id: 'b' }, { id: 'c', revoked: true }]
const L = (x: Partial<Status> = {}): Pick<Status, 'phase' | 'engine' | 'health' | 'fallback'> => ({ phase: 'on', engine: 'up', health: { a: 'ok', b: 'ok' }, fallback: {}, ...x })

// plain
const e1 = effectiveRoutes(S([r('x', 'a'), r('y', 'direct'), r('z', 'a', { on: false })]), P, L())
eq(e1.x, { desired: 'a', effective: 'a', state: 'ok' }, 'healthy route ok')
eq(e1.y.state, 'direct', 'direct stays direct')
eq(e1.z.state, 'off', 'disabled route off')
ok(!(REST_ID in e1), 'no rest entry in cards scope')
eq(moodOf(e1), 'ok', 'mood ok')

// missing / revoked target fails closed, never direct
const e2 = effectiveRoutes(S([r('x', 'gone'), r('w', 'c')]), P, L())
eq(e2.x, { desired: 'gone', state: 'blocked', reason: 'missing' }, 'missing target blocked')
eq(e2.w.state, 'blocked', 'revoked target blocked')
ok(e2.x.effective !== 'direct' && e2.w.effective !== 'direct', 'never effective direct')
eq(moodOf(e2), 'attention', 'blocked by config is attention, not recovering and not ok')

// off phase: waiting, not failing
eq(effectiveRoutes(S([r('x', 'a')]), P, L({ phase: 'off' })).x, { desired: 'a', state: 'idle', reason: 'waiting' }, 'off = idle')

// fallback active
const e3 = effectiveRoutes(S([r('x', 'a', { fallback: 'b' })]), P, L({ health: { a: 'down', b: 'ok' }, fallback: { x: 'b' } }))
eq(e3.x, { desired: 'a', effective: 'b', state: 'fallback', reason: 'main_down' }, 'fallback shows effective path')
eq(moodOf(e3), 'recovering', 'fallback -> recovering')

// path down without fallback
eq(effectiveRoutes(S([r('x', 'a')]), P, L({ health: { a: 'down' } })).x.reason, 'path_down', 'down path retrying')
// degraded is still ok (one failed round)
eq(effectiveRoutes(S([r('x', 'a')]), P, L({ health: { a: 'degraded' } })).x.state, 'ok', 'degraded holds')

// a sick spare does not change mood
const e4 = effectiveRoutes(S([r('x', 'a')]), P, L({ health: { a: 'ok', b: 'down' } }))
eq(moodOf(e4), 'ok', 'unused down profile ignored')

// engine down matters only for tunneled routes
const e5 = effectiveRoutes(S([r('y', 'direct')]), P, L({ engine: 'down' }))
eq(moodOf(e5), 'ok', 'engine down with only direct routes: ok')
eq(effectiveRoutes(S([r('x', 'a')]), P, L({ engine: 'down' })).x.reason, 'engine_down', 'engine down tunneled: retrying')

// busy key
eq(effectiveRoutes(S([r('x', 'a')]), P, L({ health: { a: 'busy' } })).x, { desired: 'a', state: 'blocked', reason: 'busy' }, 'busy blocked')

// groups: alive while any member works
const G = [{ id: 'g-1', name: 'G', policy: 'first' as const, members: ['a', 'b'] }]
eq(effectiveRoutes(S([r('x', 'g-1')], 'direct', G), P, L({ health: { a: 'down', b: 'ok' } })).x.state, 'ok', 'group with a live member ok')
eq(effectiveRoutes(S([r('x', 'g-1')], 'direct', G), P, L({ health: { a: 'down', b: 'down' } })).x.reason, 'path_down', 'group all down')

// whole computer exit
const e6 = effectiveRoutes(S([], 'a'), P, L({ health: { a: 'down' } }))
eq(e6[REST_ID]?.reason, 'path_down', 'rest exit tracked')
eq(moodOf(e6), 'recovering', 'rest down -> recovering')

// W2.4: a group reports the member it actually uses
const GA = [{ id: 'g-1', name: 'G', policy: 'fastest' as const, members: ['a', 'b'] }]
eq(effectiveRoutes(S([r('x', 'g-1')], 'direct', GA), P, { ...L(), picked: { 'g-1': 'b' } }).x, { desired: 'g-1', effective: 'b', state: 'ok' }, 'group effective = picked member')
// Auto synthesized in effective too
eq(effectiveRoutes(S([r('x', 'g-auto')]), P, { ...L(), picked: { 'g-auto': 'a' } }).x.effective, 'a', 'Auto effective = picked member')
eq(effectiveRoutes(S([r('x', 'g-auto')]), [{ id: 'p', source: 'public' }], L()).x.reason, 'missing', 'Auto without own connections blocked')

// W2 A: mixed cases
eq(moodOf(effectiveRoutes(S([r('x', 'a'), r('y', 'gone')]), P, L())), 'attention', 'healthy + missing -> attention')
eq(moodOf(effectiveRoutes(S([r('x', 'a'), r('y', 'b')]), P, L({ health: { a: 'ok', b: 'busy' } }))), 'attention', 'healthy + busy -> attention')
eq(moodOf(effectiveRoutes(S([r('x', 'a'), r('y', 'b')]), P, L())), 'ok', 'all healthy -> ok')
eq(moodOf(effectiveRoutes(S([r('x', 'a', { fallback: 'b' }), r('y', 'gone')]), P, L({ health: { a: 'down', b: 'ok' }, fallback: { x: 'b' } }))), 'attention', 'permanent blocked outranks self-healing recovery')
eq(moodOf(effectiveRoutes(S([r('y', 'gone', { on: false })]), P, L())), 'ok', 'a disabled broken route does not need attention')

console.log(`effective.check: ${n} checks`)
if (fails) { console.error(`${fails} failed`); process.exit(1) }
