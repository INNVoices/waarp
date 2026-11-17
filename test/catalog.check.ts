import { createHash } from 'node:crypto'
// Real Catalog lifecycle with fake HTTP and measuring-core methods. No native process, TUN or external request.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type CatalogState } from '../src/main/catalog'
import { Checker } from '../src/main/checker'
import type { Profile } from '../src/shared/types'
import { stub } from './stubs/electron'

let failures = 0, checks = 0
const ok = (value: unknown, name: string) => { checks++; if (!value) { failures++; console.error('FAIL', name) } }
const eq = (actual: unknown, expected: unknown, name: string) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const source = 'https://raw.githubusercontent.com/example/offline-fixture/main/servers.txt'
const body = 'trojan://fixture-password@server.example:443#Fixture'
const oldState = (): CatalogState => ({
  updatedAt: 123, sources: [], total: 1, checked: 1, busy: false,
  alive: [{ id: 'pub-old', name: 'Cached fixture', proto: 'Trojan', host: 'cached.example', port: 443, country: '??', ping: 25, checkedAt: 123, alive: true }]
})
const dirs: string[] = []
const make = (allowed: () => boolean = () => true) => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-catalog-test-')); dirs.push(dir)
  const updates: CatalogState[] = []
  const catalog = new Catalog(dir, join(dir, 'missing-engine.exe'), state => updates.push(state), allowed)
  catalog.state = oldState()
  return { catalog, updates }
}

const original = { fetch: globalThis.fetch, ensure: Checker.prototype.ensure, pings: Checker.prototype.pings, stop: Checker.prototype.stop, secure: stub.secure }
const profiles = new WeakMap<Checker, Profile[]>()
let fetched = 0, ensured = 0, stopped = 0
let http: (signal: AbortSignal) => Promise<Response>
let ping: (profiles: Profile[]) => Promise<Record<string, number | undefined>>
let stop: () => Promise<boolean>
const reset = () => {
  fetched = ensured = stopped = 0
  http = async () => new Response(body)
  ping = async current => Object.fromEntries(current.map(profile => [profile.id, 10]))
  stop = async () => true
}

;(async () => {
  stub.secure = false // encrypted cache writes are outside this lifecycle suite
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { fetched++; return http(init?.signal as AbortSignal) }) as typeof fetch
  Checker.prototype.ensure = async function (current) { ensured++; profiles.set(this, current); return true }
  Checker.prototype.pings = async function () { return ping(profiles.get(this) ?? []) }
  Checker.prototype.stop = async function () { stopped++; return stop() }
  try {
    {
      reset()
      const { catalog, updates } = make(() => false)
      const result = await catalog.refresh([source])
      eq([fetched, ensured, updates.length], [0, 0, 0], 'master-open admission prevents downloads, checker startup and fake progress')
      eq(result, oldState(), 'refused refresh keeps the cached catalog')
      eq(await catalog.pause(), true, 'pausing an idle catalog is a clean no-op')
    }
    {
      reset()
      let aborted = false
      http = signal => new Promise<Response>((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(new Error('fixture download cancelled')) }
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
      const { catalog, updates } = make()
      const first = catalog.refresh([source]), duplicate = catalog.refresh([source])
      eq(first === duplicate, true, 'duplicate refresh calls share the same pending operation')
      eq([fetched, catalog.state.busy], [1, true], 'one download publishes busy state')
      eq(await catalog.pause(), true, 'pause waits for cancelled downloads to settle')
      eq([aborted, ensured, catalog.state.busy], [true, 0, false], 'download cancellation does not reach the measuring core')
      eq(await first, oldState(), 'cancelled refresh restores the previous list and its original check time')
      eq(updates.at(-1), oldState(), 'last published state after cancellation is settled cached data')
      http = async () => new Response('no supported nodes')
      await catalog.refresh([source])
      eq([fetched, catalog.state.busy], [2, false], 'cancelled work does not leave a poisoned refresh promise')
    }
    {
      reset()
      let allowed = true
      const response = deferred<Response>()
      http = () => response.promise
      const { catalog } = make(() => allowed)
      const pending = catalog.refresh([source])
      allowed = false // master changed while a source was answering
      response.resolve(new Response(body))
      await pending
      eq([ensured, stopped], [0, 0], 'late source data cannot start a checker after admission closes')
      eq(catalog.state, oldState(), 'admission change preserves the cached catalog')
    }
    {
      reset()
      const entered = deferred<void>(), measurements = deferred<Record<string, number | undefined>>()
      let current: Profile[] = []
      ping = items => { current = items; entered.resolve(undefined); return measurements.promise }
      stop = async () => { measurements.resolve(Object.fromEntries(current.map(profile => [profile.id, 1]))); return true }
      const { catalog, updates } = make()
      const refresh = catalog.refresh([source])
      await entered.promise
      eq(ensured, 1, 'supported source reaches exactly one measuring batch')
      eq(await catalog.pause(), true, 'pause stops the measuring core and waits for refresh cleanup')
      await refresh
      ok(stopped >= 1, 'active checker receives an explicit stop')
      eq(catalog.state, oldState(), 'late successful measurement after cancellation is not published as a new catalog')
      eq(updates.at(-1)?.busy, false, 'checker cancellation leaves no perpetual busy indicator')
    }
    {
      reset()
      stop = async () => stopped > 1 // first cleanup is not confirmed; retry is confirmed
      const { catalog } = make()
      const failed = await catalog.refresh([source])
      eq([ensured, stopped, failed.busy], [1, 1, false], 'unconfirmed checker cleanup finishes with a visible failure state')
      ok(failed.sources.some(item => item.url === 'local checker' && !item.ok), 'failed checker stop is reported in the source result')
      eq(failed.alive, oldState().alive, 'unconfirmed cleanup never replaces the last usable list')
      eq(await catalog.pause(), true, 'later pause can retry and confirm the retained checker stop')
      eq(stopped, 2, 'pause retries the exact checker instead of forgetting it')
      eq(await catalog.pause(), true, 'confirmed cleanup remains clean on repeated pause')
      eq(stopped, 2, 'a confirmed and released checker is not signalled again')
    }
    {
      reset()
      stop = async () => false
      const { catalog } = make()
      await catalog.refresh([source])
      eq(await catalog.pause(), false, 'a persistently unconfirmed checker stop prevents successful pause')
      eq(stopped, 2, 'failed cleanup is retried rather than treated as already stopped')
      stop = async () => true
      eq(await catalog.pause(), true, 'cleanup can recover on the next explicit attempt')
      eq(stopped, 3, 'recovered cleanup used one more bounded checker stop')
    }
    {
      reset()
      const a = 'trojan://same-pass@node.example:443?sni=a.example#A', b = 'trojan://same-pass@node.example:443?sni=b.example#B'
      http = async () => new Response([a, b, a].join(String.fromCharCode(10)))
      const { catalog } = make()
      const r = await catalog.refresh([source])
      eq(r.alive.length, 2, 'same endpoint and password with a different SNI stay two catalog entries; an exact duplicate merges')
      const legacy = 'pub-' + createHash('sha256').update('trojan|node.example|443|same-pass').digest('hex').slice(0, 20)
      eq(r.alive.some(n => n.id === legacy), true, 'the first config keeps its historical id, so imported nodes and cards stay bound')
    }
  } finally {
    globalThis.fetch = original.fetch
    Checker.prototype.ensure = original.ensure
    Checker.prototype.pings = original.pings
    Checker.prototype.stop = original.stop
    stub.secure = original.secure
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
  console.log(`catalog.check: ${checks} checks`)
  if (failures) { console.error(`${failures} failed`); process.exit(1) }
})().catch(error => { console.error(error); process.exit(1) })
