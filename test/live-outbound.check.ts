import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveOutbounds, LIVE_OUTBOUND_SLOTS } from '../src/main/live-outbound'
import { Engine } from '../src/main/engine'
import { buildRuntime, checkConfig, loadedOf, loadedSets, liveSwitches, planSlots, runtimeAutoLive } from '../src/main/awg'
import { createApply } from '../src/main/apply'
import { DEFAULTS } from '../src/main/store-core'
import { RELAY_DNS_IP } from '../src/main/relay-config'
import type { OutProfile, AwgProfile, Settings } from '../src/shared/types'

const profile = (id: string): OutProfile => ({ kind: 'out', id, name: id, host: 'example.org', port: 443,
  version: 'Trojan', source: 'public', addedAt: 1,
  outbound: { type: 'trojan', server: 'example.org', server_port: 443, password: 'fixture-' + id } })

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-late-server-'))
  try {
    let port = 22000, allow = true, starts = 0, stops = 0, reachable = true
    const observed: string[][] = []
    const pool = new LiveOutbounds('unused', dir, (_dir, current) => ({
      ensure: async profiles => { assert(current()); starts++; observed.push(profiles.map(p => p.id)); return true },
      pings: async () => reachable ? Object.fromEntries(observed.at(-1)!.map(id => [id, 1])) : {},
      stop: async () => { stops++; return true }, stopSync: () => { stops++ }, recover: async () => true
    }), async profile => structuredClone(profile))
    assert(await pool.reserve(() => true, async () => ++port))
    assert.equal(starts, 0, 'reserving inert destinations cannot contact any public server')
    assert.equal(pool.graph.slots.length, LIVE_OUTBOUND_SLOTS)
    assert(pool.graph.slots.every(slot => slot.username && slot.password))
    const own = { ...profile('own'), source: 'personal' as const }, late = profile('late'), neighbor = profile('neighbor')
    const settings: Settings = { ...DEFAULTS, routes: [
      { id: 'selected', kind: 'app', exe: 'C:\\fixture\\selected.exe', name: 'Selected', on: true, via: own.id },
      { id: 'neighbor', kind: 'app', exe: 'C:\\fixture\\neighbor.exe', name: 'Neighbor', on: true, via: own.id }
    ] }
    const slots = planSlots(settings)!, autoLive = runtimeAutoLive(settings, [own])
    const options = { api: { port: 20000, secret: 'fixture' }, selfExe: process.execPath, autoLive, slots,
      selectors: true, ruleDir: join(dir, 'rules'), hostV6: false, relays: pool.graph }
    const before = buildRuntime([own], settings, options)
    const loaded = { ...loadedOf(loadedSets([own], settings, options)), slots }
    const engine = new Engine(process.execPath, dir, process.execPath), native = engine as any
    const child = {}; native.child = child; native.api = options.api; native.status.phase = 'on'; native.relays = pool
    native.run = { ...before, loaded, autoLive, settings, hostV6: false, nativeProfiles: loaded.profiles }
    native.writeRules = async () => true
    const switches: [string, string][] = [], dropped: string[] = []
    native.select = async (tag: string, to: string) => { switches.push([tag, to]); return true }
    native.conns = [{ id: 'selected-connection', exe: 'C:\\fixture\\selected.exe', host: '', route: 'selected' },
      { id: 'neighbor-connection', exe: 'C:\\fixture\\neighbor.exe', host: '', route: 'neighbor' }]
    native.drop = async (id: string) => { dropped.push(id); return true }
    let saved = settings, restarted = 0, prompts = 0
    const all = [own, late, neighbor]
    const apply = createApply({ get: () => saved, set: next => { saved = next }, save: () => {}, phase: () => 'on',
      open: () => allow, session: () => child, blocked: async () => false, demandsTunnel: () => true,
      live: next => engine.applyLive(all, next), liveFailure: () => engine.liveApplyFailure,
      start: async () => { restarted++ }, stop: async () => { restarted++ }, confirmRestart: async () => { prompts++; return true }, changed: () => {} })
    const next = { ...settings, routes: settings.routes.map(r => r.id === 'selected' ? { ...r, via: late.id } : r) }
    assert((await apply(next)).applied, engine.liveApplyFailure ?? 'live apply failed')
    assert.equal(native.child, child, 'main native process stays identical')
    assert.deepEqual([restarted, prompts], [0, 0])
    assert.deepEqual(observed, [['late']], 'only the selected exact public profile is activated')
    assert.deepEqual(dropped, ['selected-connection'], 'an unrelated app connection is preserved')
    assert(switches.some(([tag, to]) => tag === 'rt-a0' && to === pool.tag(late.id)))
    assert(engine.loadedProfileIds.includes(late.id))
    assert.equal(native.profileTag(late.id), pool.tag(late.id), 'health and diagnostic probes use the selected physical transport')
    assert(liveSwitches(before.cfg, native.run.cfg), 'public activation changes selector defaults/files only')
    const newCard = { id: 'new', kind: 'custom' as const, name: 'New', value: 'new.example', via: neighbor.id, on: true }
    assert((await apply({ ...next, routes: [...next.routes, newCard] })).applied, engine.liveApplyFailure ?? 'live apply failed')
    assert.equal(native.child, child)
    assert.deepEqual(native.run.cfg.inbounds, before.cfg.inbounds, 'new card/server never redefines TUN')
    assert.equal(pool.graph.slots.length, LIVE_OUTBOUND_SLOTS)

    // Rotate more choices than reserved slots. Old inactive aliases must not become
    // unexpected native outbounds when their slot is recycled.
    let rotating = { ...next, routes: [...next.routes, newCard] }
    for (let index = 0; index < LIVE_OUTBOUND_SLOTS + 2; index++) {
      const candidate = profile('rotate' + index); all.push(candidate)
      rotating = { ...rotating, routes: rotating.routes.map(route => route.id === 'selected' ? { ...route, via: candidate.id } : route) }
      assert((await apply(rotating)).applied, engine.liveApplyFailure ?? 'rotation failed')
      assert.equal(native.child, child)
      assert(liveSwitches(before.cfg, native.run.cfg), 'slot recycling keeps the exact native object graph')
    }

    const acknowledged = native.run.settings, oldSwitches = switches.length
    const unavailable = profile('unreachable'); all.push(unavailable); reachable = false
    const rejected = await apply({ ...rotating, routes: rotating.routes.map(route => route.id === 'selected' ? { ...route, via: unavailable.id } : route) })
    assert(!rejected.applied && rejected.running, 'unreachable public server cannot become the active path')
    assert.equal(native.run.settings, acknowledged)
    assert.equal(switches.length, oldSwitches, 'failed preparation never touches active selectors')
    assert.deepEqual([restarted, prompts], [0, 0]); assert.equal(native.child, child)
    reachable = true

    const slot = pool.graph.slots[0]
    const forwarded = checkConfig([late], { port: 21000, secret: 'fixture' }, undefined, { proxy: slot, profileId: late.id })
    assert.equal(forwarded.inbounds?.[0].type, 'socks')
    assert.equal(forwarded.inbounds?.[0].listen, '127.0.0.1')
    assert.equal(forwarded.route.final, 'p-late')
    assert.equal(forwarded.route.auto_detect_interface, true)
    assert.equal(forwarded.inbounds?.some(inbound => inbound.type === 'tun'), false)
    assert('rules' in forwarded.route && forwarded.route.rules?.some(rule => 'ip_cidr' in rule && rule.ip_cidr?.includes(RELAY_DNS_IP + '/32')))
    const awg: AwgProfile = { kind: 'awg', id: 'private', name: 'Private', version: 'WireGuard', address: ['10.9.0.2/32'],
      privateKey: 'a'.repeat(43) + '=', dns: ['10.9.0.1'], awg: {}, addedAt: 1,
      peer: { publicKey: 'b'.repeat(43) + '=', host: '192.0.2.1', port: 51820 } }
    const privateWorker = checkConfig([awg], { port: 21000, secret: 'fixture' }, undefined, { proxy: slot, profileId: awg.id })
    const resolver = privateWorker.dns.servers.find(server => server.tag === 'forward-dns') as Record<string, unknown>
    assert.deepEqual([resolver.server, resolver.detour], ['10.9.0.1', 'p-private'], 'private imported DNS stays inside its chosen worker')
    assert(privateWorker.endpoints.every(endpoint => endpoint.system === false), 'workers never acquire a system adapter')
    assert.throws(() => checkConfig([late], { port: 1, secret: '' }, undefined, { proxy: slot, profileId: 'missing' }))

    // Capacity reuse is allowed only for paths no current or proposed route needs.
    assert(await pool.stop())
    assert(await pool.reserve(() => true, async () => ++port))
    const busy = new Set(['late', 'neighbor'])
    assert(await pool.ensure([late, neighbor], busy, () => true))
    for (let i = 2; i < LIVE_OUTBOUND_SLOTS; i++) {
      const p = profile('fill' + i); busy.add(p.id); assert(await pool.ensure([p], busy, () => true))
    }
    const beforeFull = starts
    assert(!(await pool.ensure([profile('overflow')], busy, () => true)))
    assert.equal(starts, beforeFull, 'exhaustion cannot replace an active path')
    const old = pool.tag('fill2'); busy.delete('fill2')
    assert(await pool.ensure([profile('replacement')], busy, () => true))
    assert.equal(pool.tag('replacement'), old)
    assert.equal(pool.tag('fill2'), undefined)
    assert(stops > 0)
    let finish!: (ok: boolean) => void, started!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    let cancelled = 0
    const cancelling = new LiveOutbounds('unused', join(dir, 'cancel'), () => ({
      ensure: () => { started(); return new Promise<boolean>(resolve => { finish = resolve }) },
      pings: async () => ({ delayed: 1 }), stop: async () => { cancelled++; return true }, stopSync: () => {}, recover: async () => true
    }), async profile => structuredClone(profile))
    assert(await cancelling.reserve(() => true, async () => ++port))
    const pending = cancelling.ensure([profile('delayed')], new Set(), () => true)
    await begun; assert(await cancelling.stop()); finish(true)
    assert.equal(await pending, false, 'OFF invalidates a pending worker startup generation')
    assert(cancelled > 0); assert.equal(cancelling.graph.slots.length, 0)
    allow = false
    assert(await pool.stop())
    assert.equal(pool.graph.slots.length, 0)
    console.log('live-outbound: explicit new public server, same core/TUN graph, unrelated connection, new card, private DNS, bounded workers, capacity reuse, no restart prompt PASS')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
