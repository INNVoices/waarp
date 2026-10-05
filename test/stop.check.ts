// Hardening R2: verified graceful stop -> forced stop -> residue check; bounded shutdown. Offline: a fake child process,
// fake journal and fake preflight. No real core, no TUN, no signal to any real process.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/main/engine'
import { RuntimeJournal, type ProcessOps } from '../src/main/runtime-journal'
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

function rig(o: { owned?: 'same' | 'gone' | 'other' | 'unknown'; onBreak?: 'exit' | 'ignore'; onKill?: 'exit' | 'ignore'; residue?: Preflight[] }) {
  const e = new Engine(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-stop-')), 'C:\\W\\Waarp.exe')
  const child = new FakeChild(4242, o.onKill)
  const log = { breaks: [] as number[], cleared: 0, owned: 0, preflights: 0 }
  ;(e as any).child = child
  ;(e as any).journal = { owned: async (pid: number) => { log.owned++; return pid === 4242 ? (o.owned ?? 'same') : 'unknown' }, clear: () => { log.cleared++ } }
  e.breakSignal = async pid => { log.breaks.push(pid); if (o.onBreak === 'exit') setTimeout(() => child.die(0), 5) }
  e.gracefulMs = 60; e.killMs = 60; e.preflightGap = 1
  const queue = [...(o.residue ?? [])]
  e.preflight = async () => { log.preflights++; return queue.shift() ?? { ok: true } }
  return { e, child, log }
}

;(async () => {
  // graceful path
  {
    const { e, child, log } = rig({ owned: 'same', onBreak: 'exit' })
    eq(await e.stop(), true, 'graceful: stop ok')
    eq([log.breaks, child.kills, child.exitCode, e.status.phase, log.cleared], [[4242], 0, 0, 'off', 1], 'graceful: CTRL_BREAK to the owned pid, no kill, exit 0, off, journal cleared')
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

  // ---- recovery proves the recorded process is gone before the lease is cleared
  const EXE = 'C:\W\engine\sing-box.exe', ID0 = { path: EXE, started: '2026-10-05T06:00:00.0000000Z' }
  const jr = (seq: (('same' | 'gone' | 'other' | 'throw'))[], term = true) => {
    const d = mkdtempSync(join(tmpdir(), 'waarp-rec-'))
    writeFileSync(join(d, 'run.json.owner'), JSON.stringify({ version: 1, runId: 'a'.repeat(32), pid: 777, ...ID0 }))
    const log = { terms: 0, ids: 0 }
    const ops: ProcessOps = {
      identity: async () => { const k = seq[Math.min(log.ids++, seq.length - 1)]; if (k === 'throw') throw new Error('x'); return k === 'gone' ? null : k === 'other' ? { path: 'C:\other.exe', started: ID0.started } : ID0 },
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
  for (const bad of [0, -1, 4, 1.5, Number.NaN]) await ctrlBreak(bad)
  ok(Date.now() - t0 < 50, 'ctrlBreak refuses non-numeric / system pids without running anything')

  console.log(`stop.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
