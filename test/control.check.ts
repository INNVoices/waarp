// Owner-intent races against real FIFO scheduling. Fake engine hooks only: no processes or network changes.
import { ConnectionControl } from '../src/main/connection-control'
import { SerialGate } from '../src/main/serial'
import type { Prepared } from '../src/main/connect'
import type { Phase } from '../src/shared/types'

let failures = 0, checks = 0
const ok = (value: unknown, name: string) => { checks++; if (!value) { failures++; console.error('FAIL', name) } }
const eq = (actual: unknown, expected: unknown, name: string) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function rig() {
  const gate = new SerialGate()
  const state = { phase: 'off' as Phase, error: undefined as string | undefined, needed: true, prepares: 0, starts: 0, stops: 0, changes: 0 }
  const hooks: { prepare?: () => Promise<Prepared>; start?: () => Promise<void>; stop?: () => Promise<boolean> } = {}
  const control = new ConnectionControl({
    phase: () => state.phase,
    error: () => state.error,
    demandsTunnel: () => state.needed,
    prepare: async () => { state.prepares++; return hooks.prepare ? hooks.prepare() : { ok: true } },
    start: async () => { state.starts++; if (hooks.start) await hooks.start(); else { state.phase = 'on'; state.error = undefined } },
    stop: async () => { state.stops++; if (hooks.stop) return hooks.stop(); state.phase = 'off'; return true },
    serial: job => gate.run(job),
    changed: () => { state.changes++ }
  })
  return { control, state, hooks, gate }
}

;(async () => {
  // An open master without a tunnel-demanding card is a supported idle state.
  {
    const { control, state } = rig()
    state.needed = false
    eq(await control.connect(), { ok: true }, 'empty routing can open idle')
    eq([control.open, state.phase, state.prepares, state.starts], [true, 'off', 0, 0], 'idle OPEN performs no native preparation or start')
    eq(await control.toggle(), { ok: true }, 'idle OPEN can be closed with the same switch')
    eq(control.open, false, 'idle close changes owner intent')
  }

  // Two sources can request ON before the first native preparation completes.
  {
    const { control, state } = rig()
    state.phase = 'on'; state.needed = false; control.set(true)
    eq(await control.reconnect(control.revision, { restart: true, retainCore: true, preserveIntent: true }), { ok: true }, 'route reconciliation can retain a Direct-only core')
    eq([control.open, state.phase, state.prepares, state.starts, state.stops], [true, 'on', 1, 1, 0], 'last-card edit does not become an idle cleanup or user OFF')
    await control.disconnect()
    eq([control.open, state.phase, state.stops], [false, 'off', 1], 'explicit OFF still releases a retained Direct-only core')
  }

  // Two sources can request ON before the first native preparation completes.
  {
    const { control, state, hooks } = rig()
    const preparation = deferred<Prepared>()
    hooks.prepare = () => preparation.promise
    const first = control.connect(), second = control.connect()
    await flush()
    eq([state.prepares, state.starts, control.revision], [1, 0, 1], 'duplicate ON shares one owner revision and one active preparation')
    preparation.resolve({ ok: true })
    eq(await Promise.all([first, second]), [{ ok: true }, { ok: true }], 'both ON callers receive the established connection')
    eq([state.prepares, state.starts, state.phase], [1, 1, 'on'], 'duplicate ON never starts a second core')
  }

  {
    const { control, state, hooks } = rig()
    const preparation = deferred<Prepared>()
    hooks.prepare = () => preparation.promise
    const connecting = control.connect()
    await flush()
    eq(await control.disconnect(), { ok: true }, 'OFF does not wait behind the pending preparation')
    preparation.resolve({ ok: true })
    const result = await connecting
    eq([result.ok, result.error, state.starts, control.open], [false, 'Подключение отменено', 0, false], 'late successful preparation cannot override OFF')
  }

  // The result of the old operation must not close the newer ON, even if its preparation failed.
  for (const oldReady of [{ ok: true }, { ok: false, error: 'old block' }] as Prepared[]) {
    const { control, state, hooks } = rig()
    const preparation = deferred<Prepared>()
    hooks.prepare = () => state.prepares === 1 ? preparation.promise : Promise.resolve({ ok: true })
    const old = control.connect()
    await flush()
    await control.disconnect()
    const current = control.connect()
    preparation.resolve(oldReady)
    const [oldResult, newResult] = await Promise.all([old, current])
    eq([oldResult.ok, oldResult.error, newResult.ok], [false, 'Подключение отменено', true], `ON/OFF/ON discards old prepare result (${oldReady.ok})`)
    eq([control.open, control.revision, state.starts, state.stops, state.phase], [true, 3, 1, 1, 'on'], 'only the new intent starts, with no late stop or close')
  }

  // A forced reconnect can be requested while the old TUN is still running (for example after sleep).
  {
    const { control, state, hooks } = rig()
    state.phase = 'on'; control.set(true)
    hooks.prepare = async () => ({ ok: false, error: 'another VPN owns the default route' })
    const result = await control.reconnect(control.revision, { restart: true })
    eq(result, { ok: false, error: 'another VPN owns the default route' }, 'blocked restart keeps the actual blocker reason')
    eq([control.open, state.phase, state.stops, state.starts], [false, 'off', 1, 0], 'a blocker stops the running core before reporting a closed master')
  }

  // A replacement may fail, after which its caller restores the old credentials and reconnects the same intent.
  {
    const { control, state, hooks } = rig()
    control.set(true)
    const revision = control.revision
    hooks.start = async () => { state.phase = 'error'; state.error = 'replacement rejected' }
    eq(await control.reconnect(revision, { preserveIntent: true }), { ok: false, error: 'replacement rejected' }, 'replacement failure is reported')
    eq([control.open, control.revision], [true, revision], 'preserved failure keeps the owner revision for rollback')
    hooks.start = undefined
    eq(await control.reconnect(revision), { ok: true }, 'restored credentials can reconnect the same owner intent')
    eq([state.starts, state.phase], [2, 'on'], 'replacement and restored profile each get one start')
  }
  {
    const { control, state, hooks } = rig()
    control.set(true)
    const revision = control.revision
    hooks.start = async () => { state.phase = 'error'; state.error = 'replacement rejected' }
    await control.reconnect(revision, { preserveIntent: true })
    await control.disconnect()
    hooks.start = undefined
    const rollback = await control.reconnect(revision)
    eq([rollback.ok, rollback.error, control.open, state.phase, state.starts], [false, 'Подключение отменено', false, 'off', 1], 'explicit OFF wins over a later replacement rollback')
  }

  // Import/profile writes share the same actual gate. A queued connect must read their committed result.
  {
    const { control, state, hooks, gate } = rig()
    const write = deferred<void>()
    let selected = 'old-profile', startedWith: string | undefined
    const mutation = gate.run(async () => { await write.promise; selected = 'new-profile' })
    hooks.start = async () => { startedWith = selected; state.phase = 'on' }
    const connecting = control.connect()
    await flush()
    eq([state.prepares, state.starts], [0, 0], 'connect cannot run through a pending profile write')
    write.resolve(undefined)
    await mutation
    eq(await connecting, { ok: true }, 'connect runs when the profile write finishes')
    eq(startedWith, 'new-profile', 'queued connect uses the committed profile, not its earlier snapshot')
  }
  {
    const { control, state, gate } = rig()
    const write = deferred<void>()
    const mutation = gate.run(() => write.promise)
    const connecting = control.connect()
    await control.disconnect()
    write.resolve(undefined)
    await mutation
    eq((await connecting).ok, false, 'OFF cancels an ON still waiting behind a profile write')
    eq([state.prepares, state.starts, control.open], [0, 0, false], 'cancelled queued ON performs no preparation or start')
  }

  // Exceptions must settle the public result and leave the queue usable for the next explicit attempt.
  for (const broken of ['prepare', 'start'] as const) {
    const { control, state, hooks } = rig()
    if (broken === 'prepare') hooks.prepare = async () => { throw new Error('read failed') }
    else hooks.start = async () => { state.phase = 'on'; throw new Error('start failed after process creation') }
    const result = await control.connect()
    ok(!result.ok && typeof result.error === 'string' && result.error.length > 0, `${broken} exception returns a user-facing failure`)
    eq([control.open, state.phase, state.stops], [false, 'off', 1], `${broken} exception leaves neither open intent nor a running fake core`)
    hooks.prepare = undefined; hooks.start = undefined
    eq(await control.connect(), { ok: true }, `${broken} exception does not poison the mutation gate`)
  }
  {
    const { control, state, hooks } = rig()
    control.set(true)
    const revision = control.revision
    hooks.start = async () => { state.phase = 'on'; throw new Error('replacement start failed') }
    const failed = await control.reconnect(revision, { preserveIntent: true })
    eq([failed.ok, control.current(revision), state.phase, state.stops], [false, true, 'off', 1], 'thrown replacement failure cleans the process while preserving rollback intent')
    hooks.start = undefined
    eq(await control.reconnect(revision), { ok: true }, 'rollback is also available after a thrown replacement failure')
  }
  {
    const { control, state, hooks } = rig()
    await control.connect()
    hooks.stop = async () => { state.phase = 'error'; state.error = 'process did not stop'; return false }
    eq(await control.disconnect(), { ok: false, error: 'process did not stop' }, 'unconfirmed stop is never reported as a success')
    eq(control.open, false, 'failed cleanup does not silently restore the closed owner intent')
  }
  {
    const { control, state, hooks } = rig()
    const preparation = deferred<Prepared>()
    hooks.prepare = () => preparation.promise
    const connecting = control.connect()
    await flush()
    state.needed = false
    preparation.resolve({ ok: true })
    eq(await connecting, { ok: true }, 'routing that becomes idle during preparation settles successfully')
    eq([control.open, state.phase, state.starts], [true, 'off', 0], 'no-longer-needed TUN is not spawned')
  }

  // Becoming idle must reconcile a core left active, stopping, or in error by an earlier operation.
  for (const phase of ['on', 'error', 'stopping'] as Phase[]) {
    const { control, state } = rig()
    state.phase = phase; state.needed = false; control.set(true)
    eq(await control.reconnect(control.revision), { ok: true }, `${phase} to idle confirms cleanup`)
    eq([control.open, state.phase, state.stops, state.starts, state.prepares], [true, 'off', 1, 0, 0], `${phase} to idle stops the core while keeping the idle master open`)
  }
  {
    const { control, state, hooks } = rig()
    state.phase = 'on'; control.set(true)
    const preparation = deferred<Prepared>()
    hooks.prepare = () => preparation.promise
    const reconnecting = control.reconnect(control.revision, { restart: true })
    state.needed = false; preparation.resolve({ ok: true })
    eq(await reconnecting, { ok: true }, 'demand disappearing after preparation also enters verified idle')
    eq([control.open, state.phase, state.stops, state.starts], [true, 'off', 1, 0], 'post-prepare idle does not leave the previous core running')
  }
  for (const preserveIntent of [false, true]) {
    const { control, state, hooks } = rig()
    state.phase = 'error'; state.error = 'idle cleanup unconfirmed'; state.needed = false; control.set(true)
    const revision = control.revision
    hooks.stop = async () => false
    eq(await control.reconnect(revision, { preserveIntent }), { ok: false, error: 'idle cleanup unconfirmed' }, 'failed idle cleanup preserves the concrete error')
    eq([control.open, state.stops, state.starts], [preserveIntent, 1, 0], `failed idle cleanup honors preserveIntent=${preserveIntent} without retrying`)
  }
  {
    const { control, state, hooks } = rig()
    state.phase = 'on'; state.needed = false; control.set(true)
    hooks.stop = async () => { throw new Error('idle cleanup failed') }
    const result = await control.reconnect(control.revision)
    ok(!result.ok && !!result.error, 'thrown idle cleanup is a settled failure')
    eq([control.open, state.stops, state.starts], [false, 1, 0], 'thrown idle cleanup closes intent with one stop attempt')
  }
  for (const oldStopSucceeded of [false, true]) {
    const { control, state, hooks } = rig()
    state.phase = 'on'; state.needed = false; control.set(true)
    const stopping = deferred<boolean>()
    hooks.stop = async () => {
      if (state.stops === 1) { const result = await stopping.promise; if (result) state.phase = 'off'; return result }
      state.phase = 'off'; return true
    }
    const oldIdle = control.connect()
    await flush()
    eq(state.stops, 1, 'idle reconciliation is waiting for the previous core to stop')
    await control.disconnect()
    state.needed = true
    const nextOn = control.connect()
    stopping.resolve(oldStopSucceeded)
    const [oldResult, currentResult] = await Promise.all([oldIdle, nextOn])
    eq([oldResult.ok, oldResult.error, currentResult.ok], [false, 'Подключение отменено', true], `OFF/ON fences the old idle stop completion (${oldStopSucceeded})`)
    eq([control.open, control.revision, state.phase, state.starts, state.stops], [true, 3, 'on', 1, 2], 'old idle completion cannot close, stop, or consume the new ON')
  }

  console.log(`control.check: ${checks} checks`)
  if (failures) { console.error(`${failures} failed`); process.exit(1) }
})().catch(error => { console.error(error); process.exit(1) })
