import assert from 'node:assert/strict'
import type { OutProfile, Status } from '../src/shared/types'
import type { DiagnosticTransport } from '../src/main/diagnostic-proxy'
import { PublicPathCleanupError, withPublicServicePath } from '../src/main/public-service-path'
import { recoverPublicSources, type PublicServicePath } from '../src/main/public-recovery'

type Environment = Parameters<typeof withPublicServicePath>[1]
type OwnedChecker = NonNullable<Environment['checker']>
const fixture: OutProfile = {
  kind: 'out', id: 'personal-fixture', name: 'Fixture', host: 'relay.example', port: 443,
  version: 'Trojan', addedAt: 1, outbound: { type: 'trojan', server: 'relay.example', server_port: 443, password: 'synthetic-fixture' }
}
const path: PublicServicePath = { id: fixture.id, profile: fixture }
const sourceA = 'https://raw.githubusercontent.com/example/offline-fixture/main/a.txt'
const sourceB = 'https://raw.githubusercontent.com/example/offline-fixture/main/b.txt'
const body = 'trojan://synthetic-fixture@relay.example:443#Fixture'
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const onAbort = (signal: AbortSignal) => signal.aborted ? Promise.resolve()
  : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))

function environment(initial: Status['phase'] = 'off') {
  const stats = { acquire: 0, release: 0, ensure: 0, stop: 0, checkerProxy: 0, liveProxy: 0, adapters: 0, profile: 0 }
  const control = {
    phase: initial, open: initial === 'on', current: true, busy: false,
    loaded: new Set(['direct', fixture.id]),
    stop: async () => true,
    ensure: async () => true
  }
  let owner: symbol | undefined, cancelOwner: (() => void) | undefined
  const proxy = (signal: AbortSignal): DiagnosticTransport => ({ host: '127.0.0.1', port: 1, username: 'synthetic-local', password: 'synthetic-local', signal })
  const measured: OwnedChecker = {
    acquire(cancel) {
      stats.acquire++
      if (owner || control.busy) return undefined
      cancelOwner = cancel; return owner = Symbol('fixture checker lease')
    },
    owns(lease) { return lease === owner },
    release(lease) { stats.release++; if (lease === owner) { owner = undefined; cancelOwner = undefined } },
    async ensure(profiles, adapters) {
      stats.ensure++; assert.equal(profiles.length, 1); assert.deepEqual(adapters, [])
      return control.ensure()
    },
    stop() {
      stats.stop++
      // Faithful to Checker.stop: invalidate ownership before calling the
      // cancellation hook, then return a promise for actual process cleanup.
      const cancel = cancelOwner; owner = undefined; cancelOwner = undefined; cancel?.()
      return control.stop()
    },
    async withHttpProxy(lease, id, signal, work) {
      stats.checkerProxy++; assert.equal(lease, owner); assert.equal(id, fixture.id)
      signal.throwIfAborted()
      const result = await work(proxy(signal))
      if (signal.aborted || lease !== owner) throw new Error('cancelled')
      return result
    }
  }
  const live: Environment['live'] = {
    async withHttpProxy(id, signal, work) {
      stats.liveProxy++
      if (!control.loaded.has(id)) throw new Error('not_loaded')
      signal.throwIfAborted()
      const result = await work(proxy(signal))
      signal.throwIfAborted()
      return result
    }
  }
  const env: Environment = {
    phase: () => control.phase, open: () => control.open, current: () => control.current,
    // This environment exposes no main TUN lifecycle capability at all.
    live: new Proxy(live, { get(target, property, receiver) {
      assert.equal(property, 'withHttpProxy', 'public recovery must not access main TUN lifecycle methods')
      return Reflect.get(target, property, receiver)
    } }),
    checker: measured,
    adapters: async () => { stats.adapters++; return [] },
    profile: async candidate => { stats.profile++; return candidate.profile }
  }
  return { env, control, stats }
}

async function main() {
  {
    const { env, control, stats } = environment('off')
    control.open = true
    assert.equal(await withPublicServicePath({ id: 'direct' }, env, new AbortController().signal, 1000, async proxy => {
      assert.equal(proxy, undefined); return 'open-idle list'
    }), 'open-idle list', 'an open master without a core still permits explicitly selected Direct list I/O')
    assert.deepEqual(stats, { acquire: 0, release: 0, ensure: 0, stop: 0, checkerProxy: 0, liveProxy: 0, adapters: 0, profile: 0 })
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => 'unreachable'), /engine/)
    assert.equal(stats.acquire, 0, 'open-idle cannot create a headless checker for a profile')
  }
  {
    const { env, stats } = environment('on')
    const task = new AbortController()
    assert.equal(await withPublicServicePath(path, env, task.signal, 1000, async (proxy, signal) => {
      assert(proxy); assert.equal(proxy.host, '127.0.0.1'); assert(!signal.aborted); return 'loaded result'
    }), 'loaded result')
    assert.deepEqual(stats, { acquire: 0, release: 0, ensure: 0, stop: 0, checkerProxy: 0, liveProxy: 1, adapters: 0, profile: 0 })
    await assert.rejects(withPublicServicePath({ ...path, id: 'unloaded-fixture' }, env, task.signal, 1000,
      async () => { throw new Error('must not start transfer') }), /not_loaded/)
    assert.equal(stats.acquire, 0); assert.equal(stats.ensure, 0); assert.equal(stats.stop, 0)
    await withPublicServicePath({ id: 'direct' }, env, task.signal, 1000, async proxy => {
      assert(proxy, 'ON Direct borrows the diagnostic selector instead of opening a system-network path')
    })
    assert.equal(stats.liveProxy, 3)
  }
  {
    const { env, stats } = environment()
    await withPublicServicePath({ id: 'direct' }, env, new AbortController().signal, 1000, async proxy => {
      assert.equal(proxy, undefined)
    })
    assert.deepEqual(stats, { acquire: 0, release: 0, ensure: 0, stop: 0, checkerProxy: 0, liveProxy: 0, adapters: 0, profile: 0 })
    await assert.rejects(withPublicServicePath({ id: 'missing-profile' }, env, new AbortController().signal, 1000, async () => undefined), /not_loaded/)
    assert.equal(stats.acquire, 0)
  }
  {
    const { env, stats } = environment()
    const task = new AbortController()
    const first = await withPublicServicePath(path, env, task.signal, 1000, async () => 'first')
    assert.equal(first, 'first'); assert.equal(stats.stop, 1); assert.equal(stats.release, 1)
    assert.equal(task.signal.aborted, false, 'normal checker.stop cancels only its local owner, never the whole recovery batch')
    assert.equal(await withPublicServicePath(path, env, task.signal, 1000, async () => 'second'), 'second')
    assert.equal(stats.acquire, 2); assert.equal(stats.ensure, 2); assert.equal(stats.stop, 2)
  }
  {
    const { env, stats } = environment()
    const task = new AbortController()
    let attempts = 0
    const recovered = await recoverPublicSources([sourceA], [path, { ...path, id: 'next-path' }], async (_candidate, sources, signal, budget) => {
      attempts++
      return withPublicServicePath(path, env, signal, budget, async () => {
        if (attempts === 1) throw new Error('synthetic download failure')
        return sources.map(url => ({ url, body }))
      })
    }, task.signal)
    assert.equal(recovered[0].body, body); assert.equal(attempts, 2); assert.equal(stats.stop, 2)
    assert.equal(task.signal.aborted, false, 'an ordinary cleaned-up failure permits the next path')
  }
  {
    const { env, control, stats } = environment()
    control.stop = async () => false
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => 'must not return'), PublicPathCleanupError)
    assert.equal(stats.release, 1)
    const task = new AbortController()
    let attempts = 0
    await assert.rejects(recoverPublicSources([sourceA], [path, { ...path, id: 'never-next' }], async (_candidate, _sources, signal, budget) => {
      attempts++
      try { return await withPublicServicePath(path, env, signal, budget, async () => [{ url: sourceA, body }]) }
      catch (error) { if (error instanceof PublicPathCleanupError) task.abort(error); throw error }
    }, task.signal), PublicPathCleanupError)
    assert.equal(attempts, 1, 'a terminal cleanup failure aborts the batch before another checker/path starts')
  }
  {
    const { env, control, stats } = environment()
    const task = new AbortController(), entered = deferred<void>(), stopped = deferred<boolean>()
    control.stop = () => stopped.promise
    let settled = false
    const waiting = withPublicServicePath(path, env, task.signal, 1000, async (_proxy, signal) => {
      entered.resolve(); await onAbort(signal); return 'late partial result'
    })
    void waiting.then(() => { settled = true }, () => { settled = true })
    await entered.promise; task.abort(); await tick()
    assert.equal(stats.stop, 1); assert.equal(settled, false, 'global cancellation waits for the owned checker to actually stop')
    stopped.resolve(true)
    await assert.rejects(waiting)
    assert.equal(stats.stop, 1, 'abort listener and finally share one cleanup operation')
    assert.equal(stats.release, 1)
  }
  {
    const { env, stats } = environment()
    const task = new AbortController()
    env.profile = async () => new Promise(() => undefined)
    await assert.rejects(withPublicServicePath(path, env, task.signal, 5, async () => 'must not transfer'))
    assert.equal(stats.acquire, 1); assert.equal(stats.ensure, 0); assert.equal(stats.stop, 1)
    assert.equal(task.signal.aborted, false, 'a preparation deadline stays local to its attempt')
  }
  for (const phase of ['off', 'on'] as const) {
    const { env, stats } = environment(phase)
    const task = new AbortController()
    const result = await withPublicServicePath(path, env, task.signal, 5, async (proxy, signal) => {
      assert(proxy)
      await onAbort(signal)
      assert.equal(proxy.signal.aborted, false, 'transfer deadline does not invalidate diagnostic proxy ownership')
      return [{ url: sourceA, body }, { url: sourceB, error: 'synthetic per-path timeout' }]
    })
    assert.equal(result[0].body, body); assert.equal(result[1].error, 'synthetic per-path timeout')
    assert.equal(task.signal.aborted, false)
    assert.equal(stats.stop, phase === 'off' ? 1 : 0)
  }
  {
    const { env, control, stats } = environment()
    control.busy = true
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => undefined), /busy/)
    assert.equal(stats.stop, 0, 'failed acquisition never stops another owner\'s checker')
    control.busy = false; control.ensure = async () => false
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => undefined), /engine/)
    assert.equal(stats.stop, 1, 'failed startup still verifies cleanup before returning')
  }
  for (const phase of ['starting', 'stopping', 'error'] as const) {
    const { env, stats } = environment(phase)
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => undefined), /engine/)
    assert.equal(stats.acquire, 0); assert.equal(stats.liveProxy, 0)
  }
  {
    const { env, control, stats } = environment()
    control.open = true
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => undefined), /engine/)
    assert.equal(stats.acquire, 0)
    control.open = false; control.current = false
    await assert.rejects(withPublicServicePath(path, env, new AbortController().signal, 1000, async () => undefined), /cancelled/)
    assert.equal(stats.acquire, 0)
  }
  console.log('public-service-path: loaded live proxy only, no main TUN lifecycle, OFF Direct without checker, owned cleanup, local deadlines, partial transfer results, global cancellation and terminal cleanup failure PASS')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
