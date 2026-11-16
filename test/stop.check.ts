// Hardening R2: verified graceful stop -> forced stop -> residue check; bounded shutdown. Offline: a fake child process,
// fake journal and fake preflight. No real core, no TUN, no signal to any real process.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { Checker } from '../src/main/checker'
import { DEFAULTS } from '../src/main/store-core'
import { RuntimeJournal, type ProcessIdentity, type ProcessOps } from '../src/main/runtime-journal'
import { existsSync, writeFileSync } from 'node:fs'
import { bounded, ctrlBreak, waitExit } from '../src/main/stop'
import type { Preflight } from '../src/main/tun'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

class FakeChild extends EventEmitter {
  exitCode: number | null = null; signalCode: string | null = null; kills = 0
  constructor(public pid: number, private onKill: 'exit' | 'ignore' = 'exit') { super() }
  kill() { this.kills++; if (this.onKill === 'exit') setTimeout(() => this.die(null, 'SIGTERM'), 5); return true }
  die(code: number | null, sig: string | null = null) { this.exitCode = code; this.signalCode = sig; this.emit('exit', code, sig) }
}

function rig(o: { owned?: 'same' | 'gone' | 'other' | 'unknown'; onBreak?: 'exit' | 'ignore' | 'unsupported'; onKill?: 'exit' | 'ignore'; residue?: Preflight[] }) {
  const e = new Engine(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-stop-')), 'C:\\W\\Waarp.exe')
  const child = new FakeChild(4242, o.onKill)
  const identity: ProcessIdentity = { path: process.execPath, started: '2026-11-16T09:00:00.1234560Z' }
  const log = { breaks: [] as number[], identities: [] as ProcessIdentity[], cleared: 0, owned: 0, preflights: 0 }
  ;(e as any).child = child
  ;(e as any).journal = { owned: async (pid: number) => { log.owned++; return pid === 4242 ? (o.owned ?? 'same') : 'unknown' }, recordedIdentity: (pid: number) => pid === 4242 ? identity : undefined, clear: () => { log.cleared++ } }
  e.breakSignal = async (pid, recorded) => { log.breaks.push(pid); log.identities.push(recorded); if (o.onBreak === 'exit') setTimeout(() => child.die(0), 5); return o.onBreak !== 'unsupported' }
  e.gracefulMs = 60; e.killMs = 60; e.preflightGap = 1
  const queue = [...(o.residue ?? [])]
  e.preflight = async () => { log.preflights++; return queue.shift() ?? { ok: true } }
  return { e, child, log, identity }
}

;(async () => {
  // graceful path
  {
    const { e, child, log, identity } = rig({ owned: 'same', onBreak: 'exit' })
    eq(await e.stop(), true, 'graceful: stop ok')
    eq([log.breaks, child.kills, child.exitCode, e.status.phase, log.cleared], [[4242], 0, 0, 'off', 1], 'graceful: CTRL_BREAK to the owned pid, no kill, exit 0, off, journal cleared')
    eq(log.identities, [identity], 'the native signal helper receives the recorded path and creation time, not just a PID')
  }
  {
    const { e, child, log } = rig({ owned: 'same', onBreak: 'exit' })
    ;(e as any).journal.recordedIdentity = () => undefined
    await e.stop()
    eq([log.breaks.length, child.kills], [0, 1], 'ownership cleared after inspection cannot authorize a PID-only console signal')
  }
  {
    const { e, child, log } = rig({ owned: 'same', onBreak: 'unsupported' })
    e.gracefulMs = 5000
    eq(await bounded(e.stop(), 200), true, 'a core without a console is stopped without spending the five-second unsent-signal grace period')
    eq([log.breaks.length, child.kills, e.status.phase], [1, 1, 'off'], 'unavailable CTRL_BREAK falls back only to the exact owned child handle')
  }
  // break ignored -> forced stop through the child handle
  {
    const { e, child, log } = rig({ owned: 'same', onBreak: 'ignore' })
    eq(await e.stop(), true, 'forced: stop ok')
    eq([log.breaks.length, child.kills, e.status.phase], [1, 1, 'off'], 'forced: break first, then one kill, then off')
  }
  // identity no longer ours -> never signalled by pid; the owned handle is still closed
  for (const who of ['other', 'unknown', 'gone'] as const) {
    const { e, child, log } = rig({ owned: who, onBreak: 'exit' })
    await e.stop()
    eq([log.breaks.length, child.kills], [0, 1], `identity ${who}: no CTRL_BREAK by pid, only the own child handle`)
  }
  // never exits -> error, journal kept, child kept, not 'off'
  {
    const { e, child, log } = rig({ owned: 'same', onBreak: 'ignore', onKill: 'ignore' })
    eq(await e.stop(), false, 'stuck: stop reports failure')
    eq([e.status.phase, log.cleared, (e as any).child === child, log.preflights], ['error', 0, true, 0], 'stuck: error, journal + child kept, no residue claim')
  }
  // already exited child -> nothing signalled
  {
    const { e, child, log } = rig({ owned: 'same' })
    child.exitCode = 1
    await e.stop()
    eq([log.breaks.length, child.kills, e.status.phase], [0, 0, 'off'], 'already exited: no signal, no kill')
  }
  // residue after exit -> not off, recovery set, next start refused by the same check
  {
    const stale: Preflight = { ok: false, kind: 'tun_stale', text: 'stale' }
    const { e, log } = rig({ owned: 'same', onBreak: 'exit', residue: [stale, stale, stale] })
    await e.stop()
    eq([e.status.phase, e.status.recovery, log.preflights], ['error', 'tun_stale', 3], 'residue: three bounded checks, error + recovery, never "off"')
  }
  {
    const stale: Preflight = { ok: false, kind: 'tun_stale', text: 'stale' }
    const { e, log } = rig({ owned: 'same', onBreak: 'exit', residue: [stale] })
    await e.stop()
    eq([e.status.phase, e.status.recovery, log.preflights], ['off', undefined, 2], 'adapter gone on the re-check -> clean off')
  }
  {
    const { e } = rig({ owned: 'same', onBreak: 'exit', residue: [{ ok: false, kind: 'tun_collision', text: 'busy' }] })
    await e.stop()
    eq(e.status.recovery, 'tun_collision', 'route residue in our subnet -> recovery')
  }

  // Cancellation does not merely queue OFF behind a full startup timeout.
  {
    const e = new Engine(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-cancel-')), 'C:\\W\\Waarp.exe')
    ;(e as any).recoveryOk = true
    let release!: (p: Preflight) => void, scans = 0
    e.preflight = () => { scans++; return new Promise(resolve => { release = resolve }) }
    const first = e.start([], DEFAULTS), queued = e.start([], DEFAULTS)
    await Promise.resolve()
    const stopped = e.stop()
    const result = await bounded(Promise.all([first, queued, stopped]), 500)
    ok(result !== 'timeout', 'OFF resolves without waiting for the pending preflight')
    eq([scans, e.status.phase, !!(e as any).child], [1, 'off', false], 'cancelled/queued starts never spawn a core')
    release({ ok: true })
    await Promise.resolve()
    eq(!!(e as any).child, false, 'late preflight success cannot resurrect a cancelled start')
  }
  {
    const { e } = rig({ onBreak: 'exit' })
    e.preflight = async () => ({ ok: false, kind: 'tun_stale', text: 'still present' })
    eq(await e.stop(), false, 'initial residue stop is not successful')
    eq(await e.stop(), false, 'repeated stop without a child still reports residue')
    eq(e.status.phase, 'error', 'no-child stop never erases the recovery error')
    e.preflight = async () => ({ ok: true })
    eq([await e.stop(), e.status.phase, e.status.recovery], [true, 'off', undefined], 'verified clean retry clears recovery')
  }
  // A late controller poll cannot repopulate a stopped session; overlapping polls are bounded.
  {
    const { e } = rig({ onBreak: 'exit' })
    let release!: (value: unknown) => void, polls = 0
    ;(e as any).req = () => { polls++; return new Promise(resolve => { release = resolve }) }
    const pending = (e as any).poll()
    await (e as any).poll()
    eq(polls, 1, 'slow controller response never stacks another poll')
    await e.stop()
    release({ downloadTotal: 500, uploadTotal: 100, connections: [{ id: 'old', metadata: { host: 'old.example' } }] })
    await pending
    eq([e.status.phase, e.conns.length, (e as any).last], ['off', 0, undefined], 'late connections and counters are discarded after stop')
  }
  {
    const { e, child } = rig({})
    let release!: () => void, probes = 0
    const pending = new Promise<void>(resolve => { release = resolve })
    ;(e as any).ids = Array.from({ length: 20 }, (_, i) => `p${i}`)
    ;(e as any).delay = async () => { probes++; await pending; return 5 }
    const ping = e.pingAll()
    eq(probes, 8, 'one health round launches only its bounded workers')
    ;(e as any).child = new FakeChild(9999)
    release()
    eq(await ping, {}, 'superseded health result cannot describe the new process')
    eq(probes, 8, 'old workers do not send remaining probes to the new core')
    ;(e as any).child = child
    await e.stop()
  }
  {
    const { e } = rig({ onBreak: 'exit' })
    e.status = { ...e.status, phase: 'on', engine: 'up' }
    ;(e as any).req = async () => undefined
    await (e as any).poll()
    eq(e.status.engine, 'up', 'one missed controller poll does not declare an outage')
    await (e as any).poll()
    eq([e.status.phase, e.status.engine, /локальные запросы/.test(e.status.error ?? '')], ['on', 'down', true], 'two failed local polls report controller outage, not remote server failure')
    ;(e as any).req = async () => ({ downloadTotal: 0, uploadTotal: 0, connections: [] })
    await (e as any).poll()
    eq([e.status.phase, e.status.engine, e.status.error], ['on', 'up', undefined], 'a successful local poll clears the controller outage without restarting')
    await e.stop()
    eq((e as any).pollFailures, 0, 'controller failure streak is scoped to one engine session')
  }
  // The measuring core uses the same cancellation/ownership guarantees, although it has no TUN.
  {
    let allowed = true
    const checker = new Checker(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-checker-')), () => allowed)
    let release!: (recovered: boolean) => void, recoveries = 0
    ;(checker as any).recover = () => { recoveries++; return new Promise(resolve => { release = resolve }) }
    const ensure = checker.ensure([], []), queued = checker.ensure([], [])
    await Promise.resolve()
    const stop = checker.stop()
    allowed = false; release(true)
    eq(await Promise.all([ensure, queued, stop]), [false, false, true], 'checker stop invalidates the active and queued ensure')
    eq([recoveries, !!(checker as any).child], [1, false], 'no cancelled checker process is spawned')
    eq(await checker.ensure([], []), false, 'main admission guard refuses a checker while TUN is wanted')
  }
  {
    const checker = new Checker(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-checker-')))
    const child = new FakeChild(4242)
    let cleared = 0
    ;(checker as any).child = child
    ;(checker as any).journal = { clear: () => { cleared++ } }
    const first = checker.stop(), second = checker.stop()
    await Promise.resolve()
    eq((checker as any).child === child, true, 'checker retains its live handle until exit')
    eq(await Promise.all([first, second]), [true, true], 'concurrent checker stops wait for the same confirmed exit')
    eq([child.kills, cleared, !!(checker as any).child], [1, 1, false], 'one checker is stopped once and its lease cleared once')
  }

  // ---- recovery proves the recorded process is gone before the lease is cleared
  const EXE = 'C:\\W\\engine\\sing-box.exe', ID0 = { path: EXE, started: '2026-10-05T06:00:00.0000000Z' }
  const jr = (seq: (('same' | 'gone' | 'other' | 'throw'))[], term = true) => {
    const d = mkdtempSync(join(tmpdir(), 'waarp-rec-'))
    writeFileSync(join(d, 'run.json.owner'), JSON.stringify({ version: 1, runId: 'a'.repeat(32), pid: 777, ...ID0 }))
    const log = { terms: 0, ids: 0 }
    const ops: ProcessOps = {
      identity: async () => { const k = seq[Math.min(log.ids++, seq.length - 1)]; if (k === 'throw') throw new Error('x'); return k === 'gone' ? null : k === 'other' ? { path: 'C:\\other.exe', started: ID0.started } : ID0 },
      terminate: async () => { log.terms++; return term },
      sleep: async () => undefined,
    }
    return { j: new RuntimeJournal(d, EXE, 'run.json', ops), file: join(d, 'run.json.owner'), log }
  }
  {
    const { j, file, log } = jr(['same', 'same', 'gone'])
    eq([await j.recover(), existsSync(file), log.terms], [true, false, 1], 'recover: terminate + exact identity gone -> cleared, true')
  }
  {
    const { j, file } = jr(['same', 'same'])
    eq([await j.recover(), existsSync(file)], [false, true], 'recover: terminate accepted but the same identity stays -> lease kept, false')
  }
  {
    const { j, file, log } = jr(['other'])
    eq([await j.recover(), existsSync(file), log.terms], [true, false, 0], 'recover: PID reused by another process -> never touched, original treated as gone')
  }
  {
    const { j, file } = jr(['throw'])
    eq([await j.recover(), existsSync(file)], [false, true], 'recover: identity unreadable -> lease kept, false')
  }
  {
    const { j, file } = jr(['same', 'same', 'throw'])
    eq([await j.recover(), existsSync(file)], [false, true], 'recover: identity unreadable after terminate -> lease kept, false')
  }
  {
    const { j, file } = jr(['same'], false)
    eq([await j.recover(), existsSync(file)], [false, true], 'recover: terminate refused -> lease kept, false')
  }

  // helpers
  eq(await bounded(new Promise(() => undefined), 30), 'timeout', 'bounded: a hanging job hits the bound')
  eq(await bounded(Promise.resolve(7), 1000), 7, 'bounded: a quick job returns')
  const c = new FakeChild(1); setTimeout(() => c.die(0), 5)
  eq(await waitExit(c, 500), true, 'waitExit sees the exit'); eq(await waitExit(new FakeChild(2), 20), false, 'waitExit times out')
  const t0 = Date.now()
  for (const bad of [0, -1, 4, 1.5, Number.NaN]) await ctrlBreak(bad, ID0)
  ok(Date.now() - t0 < 50, 'ctrlBreak refuses non-numeric / system pids without running anything')

  console.log(`stop.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
