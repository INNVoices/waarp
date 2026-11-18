import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/main/store-core'
import { sameEffectiveRouting } from '../src/shared/routing-edit'
import { createApply } from '../src/main/apply'
import type { Settings } from '../src/shared/types'

const base: Settings = { ...DEFAULTS, rest: 'personal', routes: [
  { id: 'a', kind: 'custom', name: 'A', value: 'example.org', via: 'personal', on: true },
  { id: 'unused', kind: 'custom', name: 'Unused', value: 'example.net', via: 'other', on: false }
] }
const removed = { ...base, routes: base.routes.slice(0, 1) }
assert(sameEffectiveRouting(base, removed), 'delete disabled route is inert')
assert(sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => ({ ...r, name: 'renamed' })) }))
assert(!sameEffectiveRouting(base, { ...base, routes: [] }), 'deleting active route is effective')
assert(!sameEffectiveRouting(base, { ...base, rest: 'other' }))
assert(!sameEffectiveRouting(base, { ...base, dnsAll: !base.dnsAll }))
assert(!sameEffectiveRouting(base, { ...base, lanDirect: !base.lanDirect }))
assert(!sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => ({ ...r, on: true })) }))
assert(!sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => r.on ? { ...r, dpi: true } : r) }))
const two = { ...base, routes: [...base.routes, { ...base.routes[0], id: 'b', via: 'other' }] }
assert(!sameEffectiveRouting(two, { ...two, routes: [...two.routes].reverse() }), 'active rule precedence retained')

async function main() {
  for (const open of [true, false]) {
    let settings = base, saves = 0, touches = 0
    const apply = createApply({
      get: () => settings, set: s => { settings = s }, save: () => { saves++ },
      phase: () => 'on', open: () => open, revision: () => 1,
      blocked: async () => { throw new Error('a confirmed inert apply needs no scan') },
      demandsTunnel: () => true,
      live: async () => { touches++; return true },
      start: async () => { touches++ }, stop: async () => { touches++ }, changed: () => {}
    })
    const result = await apply(removed)
    assert.equal(result.saved, true)
    assert.equal(result.applied, open)
    assert.equal(saves, 1)
    assert.equal(touches, open ? 1 : 0, 'inert deletion is confirmed by runtime without scans, restart or stop')
  }
  {
    let settings = { ...base, rest: 'direct', routes: [base.routes[0]] }
    let calls: string[] = []
    const apply = createApply({
      get: () => settings, set: s => { settings = s }, save: () => {},
      phase: () => 'on', open: () => true, revision: () => 1,
      blocked: async () => { calls.push('scan'); return false },
      demandsTunnel: s => s.routes.some(r => r.on),
      live: async () => { calls.push('live'); return true },
      start: async () => { calls.push('start') }, stop: async () => { calls.push('stop') }, changed: () => {}
    })
    assert.equal((await apply({ ...settings, routes: [] })).applied, true)
    assert.deepEqual(calls, ['live'], 'the last active deletion can empty rules without closing TUN')
  }
  console.log('routing-edit.check: policy and behavioral deletion cases PASS')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
