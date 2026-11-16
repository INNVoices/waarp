// Recovery and early startup failures through the actual Engine. Only child handles/native inspection are faked.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { RuntimeJournal, type RuntimeInspection } from '../src/main/runtime-journal'
import { DEFAULTS } from '../src/main/store-core'

let checks = 0
const eq = (actual: unknown, expected: unknown, name: string) => { assert.deepEqual(actual, expected, name); checks++ }
const dirs: string[] = []
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-engine-recovery-')); dirs.push(dir)
  const e = new Engine(process.execPath, dir, process.execPath)
  e.preflight = async () => ({ ok: true }); e.preflightGap = 1; e.gracefulMs = 5; e.killMs = 20
  return e
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
class FakeChild extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter()
  exitCode: number | null = null; signalCode: string | null = null
  kills = 0
  constructor(public pid: number | undefined = 9876) { super() }
  die(code = 1) { this.exitCode = code; this.emit('exit', code) }
  kill() { this.kills++; queueMicrotask(() => this.die()); return true }
}

;(async () => {
  const originalInspect = RuntimeJournal.inspectUntracked, originalSpawn = childProcess.spawn
  let inspected = 0
  let inspection: RuntimeInspection = { ok: true }
  RuntimeJournal.inspectUntracked = async () => { inspected++; return inspection }
  try {
    {
      const e = make()
      let recovered = false
      ;(e as any).journal = { recover: async () => recovered, lastError: 'fixture: Windows could not read the process identity' }
      eq(await e.killOrphans(), false, 'failed journal recovery blocks startup')
      eq(e.recoveryReady, false, 'failed recovery is exposed to the coordinator')
      const reason = e.status.error
      await e.start([], DEFAULTS)
      eq(e.status.error, reason, 'start preserves the concrete recovery cause')
      eq(await e.stop(), true, 'OFF is successful when no process is running')
      eq([e.status.phase, e.status.error], ['error', reason], 'OFF does not erase unresolved recovery diagnosis')
      eq(inspected, 0, 'failed known lease is not bypassed by an empty untracked scan')
      recovered = true
      eq(await e.killOrphans(), true, 'later recovery can succeed in the same app process')
      eq([e.recoveryReady, e.status.phase, e.status.error], [true, 'off', undefined], 'successful retry clears the old recovery error')
      eq(e.log().some(line => line.includes('fixture: Windows')), true, 'recovery evidence is available in diagnostics')
      inspection = { ok: false, reason: 'process_running', error: 'fixture: untracked PID 54321' }
      eq(await e.killOrphans(), false, 'untracked process blocks start')
      eq(e.status.error, inspection.error, 'untracked process detail reaches the UI')
      inspection = { ok: true }
      eq(await e.killOrphans(false, 'fixture: catalog cleanup failed'), false, 'ancillary failure blocks start')
      eq(e.status.error, 'fixture: catalog cleanup failed', 'ancillary reason is retained')
    }
    {
      const e = make()
      ;(e as any).journal = { recover: async () => { throw new Error('bad lease') } }
      eq(await e.killOrphans(), false, 'unexpected recovery failure is contained')
      eq([e.status.phase, e.recoveryReady], ['error', false], 'unexpected error becomes a retryable state')
    }
    {
      const e = make(), child = new FakeChild()
      let recovered = 0
      ;(e as any).child = child
      ;(e as any).journal = { recover: async () => { recovered++; return true } }
      eq(await e.killOrphans(), false, 'late recovery cannot enter an active engine session')
      eq([recovered, child.kills], [0, 0], 'active child is not treated as an orphan')
      ;(e as any).child = undefined
    }
    {
      const e = make(), gate = deferred<boolean>()
      const order: string[] = []
      ;(e as any).journal = { recover: async () => { order.push('recover'); return gate.promise } }
      ;(e as any).startNow = async () => { order.push(e.recoveryReady ? 'start-ready' : 'start-blocked') }
      const recovery = e.killOrphans(), start = e.start([], DEFAULTS)
      await Promise.resolve()
      eq(order, ['recover'], 'start waits behind the pending engine recovery transition')
      gate.resolve(true)
      await Promise.all([recovery, start])
      eq(order, ['recover', 'start-ready'], 'queued start observes successful recovery')
    }
    {
      const e = make(), child = new FakeChild()
      ;(e as any).recoveryOk = true
      childProcess.spawn = (() => child) as unknown as typeof childProcess.spawn
      ;(e as any).journal = {
        record: async () => { child.stderr.emit('data', 'FATAL[0000] fixture invalid configuration'); child.die(); return false },
        clear: () => true
      }
      await e.start([], DEFAULTS)
      eq(e.status.error, 'fixture invalid configuration', 'early engine failure keeps its actual error')
      eq(e.recoveryReady, true, 'an already-exited startup failure does not poison recovery')
      eq(child.kills, 0, 'already-exited child is not stopped again')
      await e.stop()
    }
    {
      const e = make(), child = new FakeChild(undefined)
      child.pid = undefined
      ;(e as any).recoveryOk = true
      childProcess.spawn = (() => { queueMicrotask(() => child.emit('error', new Error('fixture ENOEXEC'))); return child }) as unknown as typeof childProcess.spawn
      let records = 0
      ;(e as any).journal = { record: async () => { records++; return false }, clear: () => true }
      await e.start([], DEFAULTS)
      eq([records, child.kills, e.recoveryReady], [0, 0, true], 'spawn failure without a PID never waits for exit or records an owner')
      eq(e.status.error?.includes('fixture ENOEXEC'), true, 'OS spawn error survives startup')
      await e.stop()
    }
    {
      const e = make(), child = new FakeChild()
      ;(e as any).recoveryOk = true
      childProcess.spawn = (() => child) as unknown as typeof childProcess.spawn
      const journal = {
        lastError: 'fixture: ownership could not be written',
        record: async () => false, owned: async () => 'unknown',
        clear: () => { journal.lastError = ''; return true }, recover: async () => true
      }
      ;(e as any).journal = journal
      await e.start([], DEFAULTS)
      eq([child.kills, e.recoveryReady, e.status.phase], [1, false, 'error'], 'unrecorded child is stopped and retry requires recovery')
      eq(e.status.error?.includes('ownership could not be written'), true, 'stop cleanup does not erase the original record failure')
      eq(await e.killOrphans(), true, 'record failure can recover without restarting the app')
      eq(e.status.error, undefined, 'recovery clears the record-failure latch')
    }
  } finally {
    RuntimeJournal.inspectUntracked = originalInspect; childProcess.spawn = originalSpawn
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
  console.log(`engine-recovery.check: ${checks} checks`)
})().catch(error => { console.error(error); process.exitCode = 1 })
