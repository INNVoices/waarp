import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutProfile, Profile } from '../src/shared/types'
import { LiveOutbounds, LIVE_OUTBOUND_SLOTS } from '../src/main/live-outbound'
import { Engine } from '../src/main/engine'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const profile = (id: string): OutProfile => ({ kind: 'out', id, name: id, host: 'example.invalid', port: 443,
  version: 'Trojan', source: 'personal', addedAt: 1,
  outbound: { type: 'trojan', server: 'example.invalid', server_port: 443, password: 'synthetic-' + id } })

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-relay-races-'))
  try {
    {
      let port = 26000, starts = 0
      const pool = new LiveOutbounds('unused', dir, () => ({ ensure: async () => { starts++; return true },
        pings: async () => ({}), stop: async () => true, stopSync: () => {}, recover: async () => true }))
      assert(await pool.reserve(() => true, async () => ++port, [26001, 26002]))
      assert.equal(pool.graph.slots.length, LIVE_OUTBOUND_SLOTS)
      assert(pool.graph.slots.every(slot => slot.port !== 26001 && slot.port !== 26002), 'relay slots cannot collide with the main API or diagnostic port')
      assert.equal(starts, 0)
      await pool.stop()
    }
    {
      const port = deferred<number | undefined>()
      const pool = new LiveOutbounds('unused', dir)
      const reserving = pool.reserve(() => true, () => port.promise)
      await pool.stop()
      port.resolve(26100)
      assert.equal(await reserving, false, 'OFF invalidates a pending port discovery')
      assert.equal(pool.graph.slots.length, 0, 'late reserve result cannot recreate an OFF generation')
    }
    {
      let port = 26200, stops = 0, finishStop: Promise<boolean> | undefined
      const native: { profiles: Profile[][] } = { profiles: [] }
      const pool = new LiveOutbounds('unused', dir, () => ({
        ensure: async profiles => { native.profiles.push(structuredClone(profiles)); return true },
        pings: async () => ({}), stop: async () => { stops++; return finishStop ?? true }, stopSync: () => {}, recover: async () => true
      }))
      await pool.reserve(() => true, async () => ++port)
      const original = profile('active')
      assert(await pool.ensure([original], new Set(), () => true))
      const binding = pool.tag(original.id)
      const changed = { ...original, outbound: { ...original.outbound, password: 'different-secret' } }
      assert.equal(await pool.ensure([changed], new Set([original.id]), () => true), false,
        'an active same-ID credential rotation cannot restart its worker before a route transaction')
      assert.equal(native.profiles.length, 1); assert.equal(stops, 0); assert.equal(pool.tag(original.id), binding)
      assert(await pool.ensure([{ ...original, name: 'Renamed', addedAt: 999 }], new Set([original.id]), () => true))
      assert.equal(native.profiles.at(-1)![0].name, original.name, 'display metadata cannot change an active worker definition')
      const gate = deferred<boolean>(); finishStop = gate.promise
      const stopping = pool.stop()
      let reserved = false
      const successor = pool.reserve(() => true, async () => ++port).then(value => { reserved = true; return value })
      await flush()
      assert.equal(reserved, false, 'a successor reservation waits for exact predecessor cleanup')
      gate.resolve(true)
      assert(await stopping); assert(await successor)
      assert.equal(pool.graph.slots.length, LIVE_OUTBOUND_SLOTS, 'old stop completion cannot erase the successor graph')
      assert.equal(pool.tag(original.id), undefined, 'new generation does not retain a stopped worker binding')
      finishStop = undefined
      await pool.stop()
    }
    {
      let port = 26400, clean = false, recovered = false
      const pool = new LiveOutbounds('unused', dir, () => ({ ensure: async () => true, pings: async () => ({}),
        stop: async () => clean, stopSync: () => {}, recover: async () => recovered }))
      await pool.reserve(() => true, async () => ++port)
      await pool.ensure([profile('unclean')], new Set(), () => true)
      assert.equal(await pool.stop(), false)
      assert.equal(await pool.reserve(() => true, async () => ++port), false, 'uncertain cleanup cannot admit another generation')
      assert(pool.tag('unclean'), 'failed cleanup retains the exact owned worker for recovery')
      assert.equal(await pool.recover(), false)
      recovered = true
      assert(await pool.recover(), 'verified journal recovery can resolve the cleanup latch')
      assert(await pool.reserve(() => true, async () => ++port), 'successful recovery admits a new generation')
      assert.equal(pool.tag('unclean'), undefined, 'recovery removes obsolete in-memory handles after ownership is reconciled')
      clean = true; await pool.stop()
    }
    {
      const engine = new Engine(process.execPath, dir, process.execPath), native = engine as any
      native.recoveryOk = true
      native.relays = { stop: async () => false, lastError: 'synthetic worker still alive' }
      assert.equal(await engine.stop(), false)
      assert.equal(engine.status.phase, 'error', 'no main process does not imply OFF while a forwarding worker is unconfirmed')
      assert.equal(engine.status.error, 'synthetic worker still alive')
    }
    console.log('live-outbound-races: excluded ports, OFF during reserve, active credential identity, pending cleanup/new generation, recovery latch and truthful failed-stop status PASS')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
