import assert from 'node:assert/strict'
import { EXITLAG_VIA } from '../src/shared/exitlag'
import { compilePlan, requiresCore } from '../src/shared/plan'
import { effectiveRoutes } from '../src/shared/effective'
import { checkedPatch } from '../src/main/validate'
import { parseExitLagSelections } from '../src/main/exitlag'
import type { Settings } from '../src/shared/types'

const app = { id: 'app:telegram', kind: 'app' as const, name: 'Telegram', exe: 'C:\\Telegram\\Telegram.exe', via: EXITLAG_VIA, on: true }
const s: Settings = { rest: 'direct', routes: [app], groups: [], ruDirect: false, dnsAll: false, lanDirect: true, tray: false, autoConnect: false, autostart: false, notify: false }
const plan = compilePlan(s, [])
assert.equal(requiresCore(s), true)
assert.deepEqual(plan.blockedTargets, [])
assert.equal(plan.routes[0]?.resolved, true)
assert.deepEqual(plan.requiredProfiles, [])
assert.equal(effectiveRoutes(s, [], { phase: 'on', engine: 'up', health: {}, fallback: {} })[app.id]?.state, 'external')

assert.equal(checkedPatch({ routes: [app] }).ok, true)
assert.equal(checkedPatch({ routes: [{ ...app, kind: 'custom', value: 'example.com' }] }).ok, false)
assert.equal(checkedPatch({ routes: [{ ...app, fallback: 'direct' }] }).ok, false)
assert.equal(checkedPatch({ rest: EXITLAG_VIA }).ok, false)
assert.equal(checkedPatch({ groups: [{ id: 'g-x', name: 'x', policy: 'first', members: [EXITLAG_VIA] }] }).ok, false)

const selections = parseExitLagSelections([
  { id: 1227, property_name: 'fs_name', property_value: 'TW Taipei' },
  { id: 1227, property_name: 'fs_alias', property_value: 'proxy.tw.taipei.1.a' },
  { id: 1227, property_name: 'enabled', property_value: '1' },
  { id: 1227, property_name: 'automatic_fs', property_value: '0' },
  { id: 1227, property_name: 'account_token', property_value: 'secret' },
  { id: 106, property_name: 'fs_name', property_value: 'DE Frankfurt' }
])
assert.equal(selections.length, 2)
assert.equal(selections[1].selectedServer, 'TW Taipei')
assert.equal(selections[1].enabled, true)
assert.equal(JSON.stringify(selections).includes('secret'), false)
console.log('[PASS] ExitLag external path and read-only selected-server projection')
