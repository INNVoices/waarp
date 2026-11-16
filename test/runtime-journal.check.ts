// Recovery regressions are isolated in temporary directories, with fake process identities only.
// No real process is signalled, no adapter or network state is changed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeJournal, type ProcessOps, type RuntimeInspection } from '../src/main/runtime-journal'

let checks = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  checks++
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}
const EXE = 'C:\\Portable\\build-new\\resources\\engine\\sing-box.exe'
const OLD = 'C:\\Portable\\build-old\\resources\\engine\\sing-box.exe'
const START = '2026-11-16T09:00:00.1234560Z'
const lease = (path = EXE) => ({ version: 1, runId: 'a'.repeat(32), pid: 777, path, started: START })
const directories: string[] = []
function rig(raw: unknown, ids: Array<{ path: string; started: string } | null | Error> = [null], scan: RuntimeInspection | Error = { ok: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-journal-'))
  directories.push(dir)
  const owner = join(dir, 'run.json.owner'), config = join(dir, 'run.json')
  if (raw !== undefined) writeFileSync(owner, typeof raw === 'string' ? raw : JSON.stringify(raw))
  writeFileSync(config, '{"fixture":true}')
  const log = { ids: 0, terms: [] as unknown[], scans: [] as unknown[] }
  const ops: ProcessOps = {
    identity: async () => {
      const result = ids[Math.min(log.ids++, ids.length - 1)]
      if (result instanceof Error) throw result
      return result
    },
    terminate: async (pid, identity) => { log.terms.push([pid, identity]); return true },
    sleep: async () => undefined,
    inspect: async (exe, allPaths) => { log.scans.push([exe, allPaths]); if (scan instanceof Error) throw scan; return scan },
  }
  return { j: new RuntimeJournal(dir, EXE, 'run.json', ops), owner, config, dir, log, ops }
}

;(async () => {
  try {
    for (const path of [EXE, OLD]) {
      const r = rig(lease(path))
      eq(await r.j.recover(), true, 'dead PID is recoverable before checking current extraction path')
      eq([existsSync(r.owner), existsSync(r.config), r.log.terms.length], [false, false, 0], 'dead old owner and own temporary config are removed without signalling')
    }
    {
      const r = rig(lease(OLD), [{ path: EXE, started: '2026-11-16T10:00:00.0000000Z' }])
      eq(await r.j.recover(), true, 'PID reused by the newer engine is not an orphan to kill')
      eq(r.log.terms.length, 0, 'reused PID never receives terminate')
    }
    {
      const original = { path: OLD, started: START }
      const r = rig(lease(OLD), [original, original, null])
      eq(await r.j.recover(), true, 'exact old portable process can be recovered after an upgrade')
      eq(r.log.terms, [[777, original]], 'terminate receives the recorded OLD path and creation time, never current exe')
      eq(existsSync(r.owner), false, 'old portable lease clears only after original identity is gone')
    }
    {
      const same = { path: OLD, started: START }
      const r = rig(lease(OLD), [same])
      eq(await r.j.recover(), false, 'accepted terminate with still-alive old identity blocks another start')
      eq([existsSync(r.owner), r.log.terms.length, !!r.j.lastError], [true, 1, true], 'stuck process keeps ownership and supplies a diagnostic')
    }
    {
      const other = 'C:\\Other\\other.exe'
      const r = rig(lease(other), [{ path: other, started: START }])
      eq(await r.j.recover(), false, 'a foreign executable named by the journal is not terminated')
      eq([r.log.terms.length, existsSync(r.owner)], [0, true], 'unrelated executable remains untouched with evidence preserved')
    }
    for (const invalid of ['{broken', 'null', '[]', 'false', '{}', { ...lease(), version: 2 }, { ...lease(), pid: 4 }, { ...lease(), started: '' }]) {
      const r = rig(invalid)
      eq(await r.j.recover(), true, 'malformed journal does not permanently block after proven absence')
      eq([r.log.ids, r.log.terms.length, r.log.scans], [0, 0, [[EXE, true]]], 'invalid lease never authorizes PID operations; absence covers every extraction path')
      eq([existsSync(r.owner), existsSync(r.config)], [false, false], 'invalid owner/config clear only after proven process absence')
    }
    for (const reason of ['process_running', 'process_unknown', 'inspection_failed'] as const) {
      const r = rig('null', [], { ok: false, reason, error: 'fixture reason' })
      eq(await r.j.recover(), false, `corrupt lease remains blocked when scan says ${reason}`)
      eq([existsSync(r.owner), r.log.terms.length, r.j.lastError?.includes('fixture reason')], [true, 0, true], 'failed scan preserves owner and useful failure reason')
    }
    {
      const r = rig('{broken', [], new Error('PowerShell unavailable'))
      eq(await r.j.recover(), false, 'scan exception produces a recovery failure instead of rejecting startup')
      eq([existsSync(r.owner), r.log.terms.length, !!r.j.lastError], [true, 0, true], 'scan exception retains evidence and provides a diagnostic')
    }
    for (const result of [new Error('Access denied'), { path: '', started: START }, { path: OLD, started: '' }]) {
      const r = rig(lease(OLD), [result])
      eq(await r.j.recover(), false, 'missing identity fields and query failures are unknown, never PID reuse')
      eq([existsSync(r.owner), r.log.terms.length, !!r.j.lastError], [true, 0, true], 'unknown identity never deletes its lease or signals a process')
    }
    {
      const r = rig(lease(), [new Error('temporarily unavailable'), null])
      eq(await r.j.recover(), false, 'first failed identity read is a recoverable error')
      eq(await r.j.recover(), true, 'next explicit recovery can recheck a transient failure')
      eq(r.j.lastError, undefined, 'successful retry clears the previous diagnostic')
    }
    {
      const r = rig(lease(OLD), [{ path: OLD, started: START }])
      let release!: (value: null) => void
      r.ops.identity = () => new Promise(resolve => { release = resolve })
      const first = r.j.recover(), second = r.j.recover()
      eq(first === second, true, 'concurrent recovery callers share one operation')
      release(null)
      eq(await Promise.all([first, second]), [true, true], 'shared recovery resolves both callers without duplicate termination')
      eq(r.log.terms.length, 0, 'concurrent gone-PID recovery never signals')
    }
    {
      const r = rig(lease())
      rmSync(r.config)
      mkdirSync(r.config)
      writeFileSync(join(r.config, 'untouched.txt'), 'keep')
      eq(await r.j.recover(), false, 'cleanup failure is not reported as recovered')
      eq(existsSync(r.owner), true, 'cleanup failure retains ownership until the temporary config is removed')
      eq(readFileSync(join(r.config, 'untouched.txt'), 'utf8'), 'keep', 'cleanup never recursively deletes a directory in place of config')
      eq(!!r.j.lastError, true, 'cleanup failure supplies a retryable reason')
      rmSync(r.config, { recursive: true })
      eq(await r.j.recover(), true, 'later recovery retries retained ownership after the file obstruction is removed')
    }
    {
      const r = rig(undefined)
      rmSync(r.config)
      eq(await r.j.recover(), true, 'no owner needs no orphan identity query')
      eq([r.log.ids, r.log.terms.length, r.log.scans.length], [0, 0, 0], 'empty journal path never signals or runs a duplicate scan')
    }
    {
      const r = rig(undefined)
      eq(await r.j.recover(), true, 'a config left before journal recording is cleaned after absence is proved')
      eq(r.log.scans, [[EXE, true]], 'missing owner still checks all extraction paths before removing its config')
      eq(existsSync(r.config), false, 'unowned stale config is removed')
    }
    {
      const r = rig(undefined, [], { ok: false, reason: 'process_running', error: 'fixture process remains' })
      eq(await r.j.recover(), false, 'missing owner cannot authorize deletion while any same-name process is alive')
      eq(existsSync(r.config), true, 'unowned live-process config stays untouched')
    }
    {
      const r = rig(undefined)
      rmSync(r.config); mkdirSync(r.config)
      eq(await r.j.recover(), false, 'an undeletable config cannot turn into success merely because owner is absent')
      eq(await r.j.recover(), false, 'repeated missing-owner recovery continues to report cleanup failure')
      eq(r.log.scans.length, 2, 'each missing-owner retry independently proves process absence')
    }
    {
      const r = rig(undefined, [{ path: EXE, started: START }, { path: '', started: START }, null])
      eq(await r.j.record(777), true, 'valid process can establish ownership')
      eq(await r.j.owned(777), 'unknown', 'missing path is not treated as a different owner')
      eq(await r.j.owned(777), 'gone', 'confirmed absent PID remains distinct from unknown')
      eq(await r.j.record(4), false, 'system PID never authorizes process ownership')
    }
    console.log(`runtime-journal.check: ${checks} checks`)
  } finally { for (const dir of directories) rmSync(dir, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
