import assert from 'node:assert/strict'
import { buildRuntime, loadedOf, loadedSets, liveSwitches, planSlots, runtimeAutoLive } from '../src/main/awg'
import { runtimePreload } from '../src/main/runtime-pool'
import type { OutProfile, Settings } from '../src/shared/types'
const profiles: OutProfile[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'out', id: 'node' + i,
  name: 'Node ' + i, version: 'Trojan', host: 'example.org', port: 443, addedAt: 1, source: 'personal',
  outbound: { type: 'trojan', server: 'example.org', server_port: 443, password: 'fixture-' + i,
    tls: { enabled: true, server_name: 'example.org' } } }))
const s: Settings = { rest: 'direct', groups: [{ id: 'g-test', name: 'Group', policy: 'first', members: ['node0', 'node9'] }],
  routes: [{ id: 'app', kind: 'app', name: 'App', exe: 'C:/fixture/app.exe', via: 'node0', on: true }],
  ruDirect: false, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: false }
const autoLive = runtimeAutoLive(s, profiles)
const preload = runtimePreload(profiles, s, ['node0'])
assert(preload.includes('node9'), 'a later private profile is not excluded by the old first-eight limit')
assert(!runtimePreload([...profiles, { ...profiles[0], id: 'public', source: 'public' }], s, []).includes('public'))
assert(!runtimePreload([...profiles, { ...profiles[0], id: 'gone', revoked: true }], s, []).includes('gone'))
assert.equal(runtimePreload(Array.from({ length: 500 }, (_, i) => ({ ...profiles[0], id: 'p' + i })), s, []).length, 64)
const slots = planSlots(s)!
const options = { api: { port: 19001, secret: 'fixture' }, selectors: true, slots, ruleDir: 'rules',
  autoLive, preload, preloadGroups: true, hostV6: true }
let previous = buildRuntime(profiles, s, options), settings = s
const keep = { ...loadedOf(loadedSets(profiles, s, options)), slots }
let checks = 4
function apply(next: Settings, label: string) {
  const rt = buildRuntime(profiles, next, { ...options, keep, slots: planSlots(next, slots)! })
  assert.notEqual(liveSwitches(previous.cfg, rt.cfg), undefined, label + ' must be selector/file-only')
  previous = rt; settings = next; checks++
}
for (const via of ['node9', 'node1', 'direct', 'g-test', 'g-auto', 'node0'])
  apply({ ...settings, routes: settings.routes.map(r => ({ ...r, via })) }, 'app to ' + via)
apply({ ...settings, routes: settings.routes.map(r => ({ ...r, on: false })) }, 'card off')
apply({ ...settings, routes: [] }, 'remove last card')
for (const rest of ['node9', 'g-test', 'g-auto', 'direct', 'missing', 'node0'])
  apply({ ...settings, rest }, 'whole device to ' + rest)
apply({ ...settings, ruDirect: true }, 'RU bypass enabled')
apply({ ...settings, ruDirect: false }, 'RU bypass disabled')
assert(JSON.parse(previous.files['rest-dns-p-node0']).rules.length > 0)
assert.equal(JSON.parse(previous.files['rest-block']).rules.length, 0)
console.log('route-switch-matrix: ' + checks + ' transitions/pool checks PASS; no network claimed')
