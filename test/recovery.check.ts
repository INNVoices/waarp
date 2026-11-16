import { RuntimeRecovery } from '../src/main/runtime-recovery'
import { ConnectionControl } from '../src/main/connection-control'
import { SerialGate } from '../src/main/serial'
import { Checker } from '../src/main/checker'
import type { Phase } from '../src/shared/types'

let checks = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function rig() {
  const serial = new SerialGate()
  const state = { ready: false, phase: 'off' as Phase, calls: 0, starts: 0, stops: 0, changes: [] as string[] }
  const hooks: { recover: () => Promise<boolean> } = { recover: async () => true }
  const recovery = new RuntimeRecovery({
    ready: () => state.ready,
    recover: async () => { state.calls++; state.ready = await hooks.recover(); return state.ready },
    changed: () => { state.changes.push(recovery.state) }
  })
  const control = new ConnectionControl({
    phase: () => state.phase,
    error: () => undefined,
    demandsTunnel: () => true,
    prepare: async () => await recovery.ensure() ? { ok: true } : { ok: false, error: 'ownership check failed' },
    start: async () => {
      if (!recovery.ready) throw new Error('spawn before recovery')
      state.starts++; state.phase = 'on'
    },
    stop: async () => { state.stops++; state.phase = 'off'; return true },
    serial: work => serial.run(work),
    changed: () => undefined
  })
  return { serial, state, hooks, recovery, control }
}

;(async () => {
  // First paint can accept ON immediately, while the same native pass is still reconciling old journals.
  {
    const { serial, state, hooks, recovery, control } = rig()
    const native = deferred<boolean>()
    hooks.recover = () => native.promise
    eq([recovery.state, recovery.ready], ['recovering', false], 'initial measurements are gated')
    const bootstrap = serial.run(() => recovery.ensure())
    const opening = control.connect()
    await flush()
    eq([state.calls, state.starts, control.open], [1, 0, true], 'first-paint ON waits behind bootstrap while preserving user intent')
    const joined = recovery.ensure()
    eq(recovery.state, 'recovering', 'joining does not declare failure')
    native.resolve(true)
    eq(await Promise.all([bootstrap, joined]), [true, true], 'bootstrap and explicit recovery share the native result')
    eq(await opening, { ok: true }, 'first-paint ON starts after recovery')
    eq([state.calls, state.starts, recovery.ready, recovery.state], [1, 1, true, 'ready'], 'one recovery and one spawn, no delayed orphan scan')
    eq(state.changes, ['recovering', 'ready'], 'progress has a bounded clear transition')
    await recovery.ensure()
    eq(state.calls, 1, 'healthy active core does not trigger another recovery scan')
  }

  // OFF intent is deliberately outside the intent FIFO. Native cleanup can still take time in Engine.stop;
  // this fixture isolates the control layer and proves that it does not wait for bootstrap before cancelling ON.
  {
    const { serial, state, hooks, recovery, control } = rig()
    const native = deferred<boolean>()
    hooks.recover = () => native.promise
    const bootstrap = serial.run(() => recovery.ensure())
    const opening = control.connect()
    await flush()
    eq(await control.disconnect(), { ok: true }, 'control-layer OFF is not queued behind initial recovery')
    eq([control.open, state.starts], [false, 0], 'OFF clears intent immediately')
    native.resolve(true)
    await bootstrap
    eq((await opening).ok, false, 'cancelled first-paint ON does not reopen later')
    eq(state.starts, 0, 'completed recovery cannot resurrect cancelled startup')
  }

  {
    const { serial, state, hooks, recovery, control } = rig()
    const native = deferred<boolean>()
    hooks.recover = () => native.promise
    const bootstrap = serial.run(() => recovery.ensure())
    const old = control.connect()
    await flush()
    await control.disconnect()
    const current = control.connect()
    native.resolve(true)
    await bootstrap
    eq([(await old).ok, (await current).ok, state.calls, state.starts, control.open], [false, true, 1, 1, true], 'ON/OFF/ON during boot starts only the latest intent')
  }

  // A transient native/lease failure must not become a permanent application-session latch.
  for (const throwing of [false, true]) {
    const { state, hooks, recovery, control } = rig()
    hooks.recover = async () => { if (throwing) throw new Error('temporary native failure'); return false }
    eq(await recovery.ensure(), false, `failed bootstrap settles (${throwing})`)
    eq([recovery.state, recovery.ready], ['failed', false], 'failed bootstrap keeps measurements gated')
    hooks.recover = async () => true
    eq(await control.connect(), { ok: true }, 'explicit ON retries failed bootstrap')
    eq([state.calls, state.starts, recovery.state], [2, 1, 'ready'], 'retry restores readiness without app restart')
  }

  {
    const { state, recovery } = rig()
    await recovery.ensure()
    state.ready = false // a later spawn could not record ownership
    eq([recovery.ready, recovery.state], [false, 'failed'], 'engine invalidation defeats cached startup success')
    eq(await recovery.ensure(), true, 'later ownership failure can be recovered')
    eq(state.calls, 2, 'engine invalidation performs a new native check')
  }

  {
    const { state, hooks, recovery } = rig()
    await recovery.ensure()
    const native = deferred<boolean>()
    hooks.recover = () => native.promise
    const reset = recovery.ensure(true)
    const same = recovery.ensure(true)
    const shutdown = recovery.settled()
    await flush()
    eq([state.calls, recovery.ready, recovery.state], [2, false, 'recovering'], 'forced reset immediately pauses measurements')
    eq(reset === same, true, 'overlapping recovery actions share one pass')
    native.resolve(false)
    eq(await Promise.all([reset, same, shutdown]), [false, false, false], 'reset failure and shutdown join the same completion')
    eq(recovery.state, 'failed', 'failed reset cannot reuse old ready result')
    await recovery.settled()
    eq(state.calls, 2, 'shutdown does not start another recovery attempt')
    hooks.recover = async () => true
    eq(await recovery.ensure(), true, 'failed reset remains retryable')
  }

  // A failed OS spawn has no PID and never emits exit. Stop must release it without a kill or four-second wait.
  {
    const checker = new Checker('engine.exe', 'unused')
    let kills = 0, clears = 0
    Object.assign(checker, {
      child: { pid: undefined, exitCode: null, signalCode: null, kill: () => { kills++ } },
      journal: { clear: () => { clears++; return true } }
    })
    eq(await checker.stop(), true, 'failed checker spawn has nothing to stop')
    eq([kills, clears], [0, 1], 'failed spawn releases its temporary journal without signalling a PID')
  }

  // A dead process is insufficient if Windows still refuses to remove its credential-bearing files.
  {
    const checker = new Checker('engine.exe', 'unused')
    Object.assign(checker, {
      child: { pid: 42, exitCode: 0, signalCode: null },
      journal: { clear: () => false, recover: async () => true, lastError: 'file is locked' }
    })
    eq(await checker.stop(), false, 'failed checker cleanup blocks admission')
    eq(await checker.stop(), false, 'second stop cannot hide a prior cleanup failure')
    eq(checker.recoveryError, 'file is locked', 'checker exposes the actionable cleanup reason')
    eq(await checker.recover(), true, 'verified recovery can clear the cleanup latch')
    eq(await checker.stop(), true, 'successful recovery admits a later start')
  }

  console.log(`recovery.check: ${checks} checks`)
})().catch(error => { console.error(error); process.exitCode = 1 })
