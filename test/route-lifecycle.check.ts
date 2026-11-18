import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { buildRuntime, loadedOf, loadedSets, planSlots, runtimeAutoLive } from '../src/main/awg'
import { createApply } from '../src/main/apply'
import { runtimePreload } from '../src/main/runtime-pool'
import { DIAGNOSTIC_SELECTOR } from '../src/main/diagnostic-proxy'
import { confirmedRoutes } from '../src/shared/effective'
import type { OutProfile, Settings } from '../src/shared/types'

const profiles: OutProfile[] = Array.from({ length: 12 }, (_, i) => ({
  kind: 'out', id: 'node' + i, name: 'Node ' + i, version: 'Trojan', host: 'example.org', port: 443,
  addedAt: 1, source: 'personal', outbound: { type: 'trojan', server: 'example.org', server_port: 443,
    password: 'fixture-' + i, tls: { enabled: true, server_name: 'example.org' } }
}))
const initial: Settings = { rest: 'direct', routes: [
  { id: 'selected', kind: 'custom', name: 'Selected', value: 'selected.example', via: 'node0', on: true },
  { id: 'neighbor', kind: 'custom', name: 'Neighbor', value: 'neighbor.example', via: 'node1', on: true }
], groups: [{ id: 'g-own', name: 'Own', policy: 'first', members: ['node0', 'node9'] }],
  ruDirect: false, dnsAll: false, lanDirect: true, notify: false, tray: true, autoConnect: false, autostart: false }

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-route-lifecycle-'))
  try {
    const engine = new Engine(process.execPath, dir, process.execPath)
    const native = engine as any
    native.child = {}; native.api = { port: 1, secret: 'fixture' }; native.status.phase = 'on'
    native.diagnostic = { port: 2, username: 'local', password: 'fixture-auth' }
    const slots = planSlots(initial)!, autoLive = runtimeAutoLive(initial, profiles)
    const options = { api: native.api, selfExe: process.execPath, autoLive, slots, selectors: true,
      ruleDir: join(dir, 'rules'), hostV6: false, preload: runtimePreload(profiles, initial, ['node0', 'node1']),
      preloadGroups: true, diagnostic: native.diagnostic }
    const runtime = buildRuntime(profiles, initial, options)
    native.run = { ...runtime, loaded: { ...loadedOf(loadedSets(profiles, initial, options)), slots },
      autoLive, settings: initial, hostV6: false }
    native.conns = [
      { id: 'selected-connection', exe: '', host: 'selected.example', route: 'selected', rule: 'rule_set=rd0' },
      { id: 'neighbor-connection', exe: '', host: 'neighbor.example', route: 'neighbor', rule: 'rule_set=rd1' }
    ]
    const events: string[] = [], closed: string[] = []
    let guard = false
    native.writeRules = async (names: string[], files: Record<string, string>) => {
      if (names.includes('apply-guard')) {
        guard = JSON.parse(files['apply-guard']).rules.length > 0
        events.push(guard ? 'guard-on' : 'guard-off')
      } else { assert(guard, 'business files cannot precede the reject barrier'); events.push('rules') }
      return true
    }
    native.select = async (tag: string) => {
      if (tag !== DIAGNOSTIC_SELECTOR) assert(guard, 'a route selector cannot precede the reject barrier')
      events.push('select:' + tag); return true
    }
    native.drop = async (id: string) => { closed.push(id); return true }
    let saved = initial, starts = 0, stops = 0, scans = 0
    const apply = createApply({ get: () => saved, set: next => { saved = next }, save: () => {},
      phase: () => engine.status.phase, open: () => true,
      live: next => engine.applyLive(profiles, next),
      liveFailure: () => engine.liveApplyFailure,
      blocked: async () => { scans++; return false }, demandsTunnel: next => next.routes.some(r => r.on),
      start: async () => { starts++ }, stop: async () => { stops++ }, changed: () => {} })
    const switched = { ...initial, routes: initial.routes.map(r => r.id === 'selected' ? { ...r, via: 'node9' } : r) }
    // Simulate a previous saved-but-unapplied operation. Comparing next with disk
    // alone would falsely succeed and leave the old native selector untouched.
    saved = switched
    assert((await apply({ ...switched })).applied)
    assert.equal(events[0], 'guard-on'); assert.equal(events.at(-1), 'guard-off')
    assert(events.some(event => event === 'select:rt-d0'))
    assert.deepEqual(closed, ['selected-connection'], 'the neighbor stream is preserved')
    assert.deepEqual([starts, stops, scans], [0, 0, 0])
    assert.equal(native.run.settings.routes[0].via, 'node9')
    const pendingView = confirmedRoutes({ ...switched, routes: switched.routes.map(r => r.id === 'selected' ? { ...r, via: 'node0' } : r) }, profiles,
      { phase: 'on', engine: 'up', fallback: {}, health: { node0: 'ok', node1: 'ok', node9: 'ok' } }, switched)
    assert.equal(pendingView.selected.state, 'retrying', 'a saved edit cannot claim a healthy unconfirmed path')
    assert.equal(pendingView.selected.effective, 'node9'); assert.equal(pendingView.neighbor.state, 'ok')

    events.length = 0; closed.length = 0
    const manyDisabled = { ...switched, routes: [...switched.routes, ...Array.from({ length: 100 }, (_, i) => ({
      id: 'off' + i, kind: 'custom' as const, name: 'Off ' + i, value: 'off' + i + '.example', via: 'node0', on: false
    }))] }
    assert(await engine.applyLive([...profiles].reverse(), manyDisabled), 'library reorder and disabled additions do not consume live slots')
    assert.equal(events.length, 0); assert.equal(closed.length, 0)
    const unusedGroup = { ...manyDisabled, groups: [...manyDisabled.groups,
      { id: 'g-unused', name: 'Unused', policy: 'first' as const, members: ['node2', 'node3'] }] }
    assert(await engine.applyLive(profiles, unusedGroup), 'adding an unused group does not add native objects mid-run')
    assert.equal(events.length, 0)

    // The same physical native group retains its chosen member while inactive.
    native.firstSelected.set('g-own', 'node9')
    assert(await engine.applyLive(profiles, { ...unusedGroup, rest: 'g-own' }))
    assert.equal(native.firstSelected.get('g-own'), 'node9')
    assert(await engine.applyLive(profiles, { ...unusedGroup, rest: 'direct' }))
    assert.equal(native.firstSelected.get('g-own'), 'node9')

    // Removing the last active cards publishes empty rules with the same process.
    native.conns = []
    saved = unusedGroup
    assert((await apply({ ...unusedGroup, routes: [] })).applied)
    assert.deepEqual([starts, stops, scans], [0, 0, 0])
    assert.equal(engine.status.phase, 'on')

    // Fail each native transaction stage once. A confirmed rollback preserves
    // the old routing and the same process; no caller scan/start/stop is allowed.
    const acknowledged = native.run.settings
    const normalWrite = native.writeRules, normalSelect = native.select, normalDrop = native.drop
    for (const stage of ['guard', 'select', 'rules', 'release', 'drop']) {
      events.length = 0; let injected = false
      native.writeRules = async (names: string[], files: Record<string, string>) => {
        const barrier = names.includes('apply-guard')
        const enabled = barrier && JSON.parse(files['apply-guard']).rules.length > 0
        const currentStage = barrier ? enabled ? 'guard' : 'release' : 'rules'
        const result = await normalWrite(names, files)
        if (!injected && currentStage === stage) { injected = true; return false }
        return result
      }
      native.select = async (tag: string, to: string) => {
        const result = await normalSelect(tag, to)
        if (!injected && stage === 'select') { injected = true; return false }
        return result
      }
      native.conns = stage === 'drop' ? [{ id: 'selected-connection', exe: '', host: 'selected.example', route: '', rule: 'final' }] : []
      native.drop = async (id: string) => {
        if (!injected && stage === 'drop') { injected = true; return false }
        return normalDrop(id)
      }
      const next = { ...acknowledged, rest: 'node1', routes: stage === 'drop' ? initial.routes : acknowledged.routes }
      const result = await apply(next)
      assert(injected, stage + ' fault was reached')
      assert(result.saved && !result.applied && result.running, stage + ' reports saved but unapplied')
      assert.equal(native.run.settings, acknowledged)
      assert.equal(guard, false, stage + ' restores and acknowledges the old rules')
      assert(engine.liveApplyFailure)
      assert.deepEqual([starts, stops, scans], [0, 0, 0])
    }
    native.writeRules = normalWrite; native.drop = normalDrop; native.conns = []

    // An unconfirmed rollback keeps the targeted barrier. Retrying the old
    // snapshot must still reconcile the pending native state before succeeding.
    events.length = 0
    native.select = async () => { events.push('failed-select'); return false }
    assert(!(await apply({ ...acknowledged, rest: 'node1' })).applied)
    assert.deepEqual(events, ['guard-on', 'failed-select', 'guard-on', 'failed-select'])
    assert.equal(native.run.settings, acknowledged)
    assert(guard, 'partial apply remains guarded without recreating TUN')
    assert(engine.liveApplyFailure)
    native.set({ engine: 'up', error: undefined })
    assert.equal(engine.status.error, engine.liveApplyFailure, 'healthy polling cannot erase an unresolved route error')
    native.select = normalSelect
    assert((await apply(acknowledged)).applied)
    assert.equal(guard, false); assert.equal(engine.liveApplyFailure, undefined)
    assert.deepEqual([starts, stops, scans], [0, 0, 0])

    // Diagnostic selection is independent of every card and responds to OFF.
    native.select = async (tag: string, to: string) => {
      assert.equal(tag, DIAGNOSTIC_SELECTOR); assert.equal(to, 'p-node9'); return true
    }
    const result = await engine.withHttpProxy('node9', new AbortController().signal, async proxy => {
      assert.equal(proxy.host, '127.0.0.1'); assert.equal(proxy.port, 2); assert(!proxy.signal.aborted)
      await assert.rejects(engine.withHttpProxy('node0', new AbortController().signal, async () => 0), /busy/)
      return 'body verified'
    })
    assert.equal(result, 'body verified')
    await assert.rejects(engine.withHttpProxy('unloaded', new AbortController().signal, async () => 0), /not_loaded/)
    await assert.rejects(engine.withHttpProxy('node9', new AbortController().signal, async proxy => {
      native.abortRequests(); assert(proxy.signal.aborted); return 1
    }), /cancelled/)
    console.log('route-lifecycle: actual Apply + Engine guarded switches, saved-intent retry, inactive capacity, group memory, last-card, failed transaction, diagnostic isolation PASS')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
