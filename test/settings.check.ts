// Concurrent renderer/companion edits and repair of unavailable routes. Pure, no native IPC.
import { settingsPatchCurrent } from '../src/main/validate'
import { companionPatchSafe } from '../src/shared/companion'
import { DEFAULTS } from '../src/main/store-core'
import type { Settings, Route } from '../src/shared/types'

let n = 0, failed = 0
const ok = (v: unknown, msg: string) => { n++; if (!v) { failed++; console.error('FAIL', msg) } }
const route: Route = { id: 'ext:test:app', kind: 'custom', name: 'App', value: 'app.example.com', owner: 'companion', via: 'missing', on: true }
const initial: Settings = { ...DEFAULTS, groups: [], routes: [route] }
const added = { ...route, id: 'ext:test:other', name: 'Other', value: 'other.example.com', via: 'own' }
const concurrent = { ...initial, routes: [...initial.routes, added] }
ok(!settingsPatchCurrent({ routes: [] }, initial, concurrent), 'stale full routes cannot remove a concurrently added route')
ok(!settingsPatchCurrent({ routes: [] }, initial, { ...initial, routes: [{ ...route, on: false }] }), 'stale routes cannot undo an edited rule')
ok(settingsPatchCurrent({ tray: false }, initial, concurrent), 'an unrelated concurrent route write does not block tray preference')
ok(settingsPatchCurrent({ routes: [added] }, concurrent, concurrent), 'explicit deletion from a fresh view remains possible')
ok(!settingsPatchCurrent({ routes: [] }, undefined, concurrent), 'a missing base cannot bypass concurrency validation')
ok(!settingsPatchCurrent({ routes: [] }, [], concurrent), 'an array is not a settings base')
ok(!settingsPatchCurrent({ routes: [], groups: [] }, initial, { ...initial, groups: [{ id: 'g-own', name: 'Own', policy: 'first', members: ['own'] }] }), 'multi-field write is rejected if any touched field changed')

const profiles = [{ id: 'own' }, { id: 'pub', source: 'public' }, { id: 'revoked', revoked: true }]
const changed = (change: Partial<Route>): Settings => ({ ...initial, routes: [{ ...route, ...change }] })
ok(companionPatchSafe({ ...initial, groups: [{ id: 'g-other', name: 'Other', policy: 'first', members: ['own'] }] }, initial, profiles), 'unavailable unchanged route does not freeze unrelated settings')
ok(companionPatchSafe(changed({ on: false }), initial, profiles), 'an unavailable companion route can be disabled')
ok(companionPatchSafe({ ...initial, routes: [] }, initial, profiles), 'an unavailable companion route can be deleted')
ok(companionPatchSafe(changed({ via: 'own' }), initial, profiles), 'an unavailable path can be repaired with a personal connection')
ok(!companionPatchSafe(initial, changed({ on: false }), profiles), 'an unavailable disabled path cannot be enabled')
ok(!companionPatchSafe(changed({ via: 'pub' }), initial, profiles), 'a public replacement is rejected')
ok(!companionPatchSafe(changed({ via: 'another-missing' }), initial, profiles), 'a new missing path is rejected')
ok(!companionPatchSafe(changed({ via: 'pub' }), changed({ via: 'pub' }), profiles), 'unchanged public path cannot exploit unavailable-path exception')
ok(companionPatchSafe(changed({ via: 'revoked' }), changed({ via: 'revoked' }), profiles), 'a revoked path can remain blocked')
ok(!companionPatchSafe(changed({ fallback: 'direct' }), initial, profiles), 'Direct is never accepted as companion fallback')
const grouped = { ...changed({ via: 'g-own' }), groups: [{ id: 'g-own', name: 'Own', policy: 'first' as const, members: ['own', 'missing'] }] }
ok(companionPatchSafe({ ...grouped, groups: [{ ...grouped.groups[0], name: 'Renamed' }] }, grouped, profiles), 'an existing unavailable group may be renamed')
ok(!companionPatchSafe({ ...grouped, groups: [{ ...grouped.groups[0], members: ['own', 'pub'] }] }, grouped, profiles), 'adding a public group member stays forbidden')
ok(!companionPatchSafe({ ...grouped, groups: [{ ...grouped.groups[0], members: ['own', 'another-missing'] }] }, grouped, profiles), 'an unavailable group cannot acquire another missing member')
ok(companionPatchSafe({ ...grouped, groups: [] }, grouped, profiles), 'deleting the unavailable group keeps its route blocked')
console.log(`settings.check: ${n} checks`)
if (failed) process.exitCode = 1
