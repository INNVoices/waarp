// C12: only a process recorded by this Waarp run may be recovered. The journal has no credentials.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, win32 } from 'node:path'
import { ps } from './ps'

export interface ProcessIdentity { path: string; started: string }
type Identity = ProcessIdentity
interface Lease extends Identity { version: 1; runId: string; pid: number }
export type RuntimeInspection = { ok: true } | {
  ok: false; reason: 'process_running' | 'process_unknown' | 'inspection_failed'; error: string
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
const samePath = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const validIdentity = (v: unknown): v is Identity => {
  if (!v || typeof v !== 'object') return false
  const i = v as Identity
  return typeof i.path === 'string' && !!i.path.trim() && (isAbsolute(i.path) || win32.isAbsolute(i.path)) &&
    typeof i.started === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)$/.test(i.started) && Number.isFinite(Date.parse(i.started))
}
const validLease = (v: unknown): v is Lease => validIdentity(v) && (v as Lease).version === 1 &&
  typeof (v as Lease).runId === 'string' && /^[0-9a-f]{32}$/.test((v as Lease).runId) && Number.isSafeInteger((v as Lease).pid) && (v as Lease).pid > 4

async function identity(pid: number): Promise<Identity | null> {
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){'null'}else{[pscustomobject]@{path=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`
  const value = await ps<Identity | null>(script, 5000)
  if (value === null) return null
  if (!validIdentity(value)) throw new Error('Process identity unavailable')
  return value
}

/** read-only process identity + a terminate that re-checks the identity first; injectable for offline tests */
export interface ProcessOps {
  identity: (pid: number) => Promise<Identity | null>
  terminate: (pid: number, id: Identity) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  inspect?: (exe: string, allPaths: boolean) => Promise<RuntimeInspection>
}
const realOps: ProcessOps = {
  identity,
  terminate: async (pid, id) => {
    // Process.Handle caches a long-lived native handle in Windows PowerShell's .NET Framework.
    // Open it BEFORE the CIM identity check: Kill then reuses that exact handle instead of looking
    // up a possibly recycled PID between the identity read and Invoke-CimMethod/Terminate.
    const script = `$ErrorActionPreference='Stop';try{$owned=[Diagnostics.Process]::GetProcessById(${pid})}catch{if($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]){'true';exit 0};throw};try{$null=$owned.Handle;$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -ne $p -and $p.ExecutablePath -ieq ${quote(id.path)} -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq ${quote(id.started)}){$owned.Kill()};'true'}catch{if($owned.HasExited){'true'}else{throw}}finally{$owned.Dispose()}`
    return (await ps<boolean>(script, 5000)) === true
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

export class RuntimeJournal {
  private journal: string
  private runtimeFile: string
  private runId = randomBytes(16).toString('hex')
  private lease?: Lease
  private recovering?: Promise<boolean>
  /** A useful, credential-free reason survives until the next successful recovery/record. */
  lastError?: string

  constructor(private dir: string, private exe: string, configName: 'run.json' | 'check.json', private ops: ProcessOps = realOps) {
    this.journal = join(dir, configName + '.owner')
    this.runtimeFile = join(dir, configName)
  }

  private fail(error: string): false { this.lastError = error; return false }

  async record(pid: number | undefined): Promise<boolean> {
    this.lastError = undefined
    if (!pid || !Number.isSafeInteger(pid) || pid <= 4) return this.fail('Движок не сообщил допустимый номер процесса')
    let found: Identity | null
    try { found = await this.ops.identity(pid) }
    catch { return this.fail('Windows не дала прочитать владельца запущенного движка. Повтори запуск с правами администратора') }
    if (!validIdentity(found) || !samePath(found.path, this.exe)) return this.fail('Windows не подтвердила владельца запущенного движка')
    const temp = this.journal + '.tmp'
    try {
      const lease: Lease = { version: 1, runId: this.runId, pid, path: found.path, started: found.started }
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temp, JSON.stringify(lease), { mode: 0o600 })
      renameSync(temp, this.journal)
      this.lease = lease
      return true
    } catch { try { rmSync(temp, { force: true }) } catch {}; return this.fail('Не удалось сохранить журнал процесса движка. Проверь доступ к папке данных Waarp и свободное место') }
  }

  /** R2: is this PID still exactly the process recorded by this run (path + creation time)? Read-only. */
  async owned(pid: number): Promise<'same' | 'gone' | 'other' | 'unknown'> {
    const l = this.lease
    if (!l || l.pid !== pid) return 'unknown'
    try {
      const found = await this.ops.identity(pid)
      if (found === null) return 'gone'
      if (!validIdentity(found)) return 'unknown'
      return samePath(found.path, l.path) && found.started === l.started ? 'same' : 'other'
    } catch { return 'unknown' }
  }

  /** Recorded evidence only; the signal helper must recheck it while holding the native process handle. */
  recordedIdentity(pid: number): ProcessIdentity | undefined {
    const lease = this.lease
    return lease?.pid === pid ? { path: lease.path, started: lease.started } : undefined
  }

  clear(): boolean {
    this.lease = undefined
    // Keep the ownership evidence until its potentially secret config has been removed too.
    try { rmSync(this.runtimeFile, { force: true }); rmSync(this.journal, { force: true }) }
    catch { return this.fail('Процесс закрыт, но Windows не дала удалить его временные файлы. Повтори восстановление') }
    this.lastError = undefined
    return true
  }

  /** No WMI dependency for the common empty scan. Never signals anything; inaccessible identities remain blockers. */
  static async inspectUntracked(exe: string, allPaths = false): Promise<RuntimeInspection> {
    try {
      const name = quote(win32.basename(exe).replace(/\.exe$/i, ''))
      // A lost/corrupt journal has no trustworthy old extraction path: absence must cover every same-name process.
      const checkPath = allPaths ? '$blocked += $p.Id' : `$path=$p.MainModule.FileName;if([string]::IsNullOrWhiteSpace($path)){$unknown += $p.Id}elseif($path -ieq ${quote(exe)}){$blocked += $p.Id}`
      const script = `$ErrorActionPreference='Stop';$blocked=@();$unknown=@();$processes=@([Diagnostics.Process]::GetProcessesByName(${name}));foreach($p in $processes){try{if($p.HasExited){continue};${checkPath}}catch{try{if(-not $p.HasExited){$unknown += $p.Id}}catch{$unknown += $p.Id}}finally{$p.Dispose()}};[pscustomobject]@{blocked=@($blocked);unknown=@($unknown)}|ConvertTo-Json -Compress`
      const result = await ps<{ blocked: number[]; unknown: number[] }>(script, 8000)
      const pids = (v: unknown): v is number[] => Array.isArray(v) && v.every(p => Number.isSafeInteger(p) && p > 0)
      if (!result || !pids(result.blocked) || !pids(result.unknown)) throw new Error('Process list unavailable')
      if (result.unknown.length) return { ok: false, reason: 'process_unknown', error: 'Windows не дала проверить оставшийся процесс движка. Повтори запуск Waarp с правами администратора' }
      if (result.blocked.length) return { ok: false, reason: 'process_running', error: `Остался процесс движка без подтверждённого владельца (PID ${result.blocked.slice(0, 4).join(', ')}). Закрой другую копию Waarp и повтори восстановление` }
      return { ok: true }
    } catch { return { ok: false, reason: 'inspection_failed', error: 'Не удалось проверить процессы Windows через PowerShell. Повтори восстановление' } }
  }

  /** Missing/corrupt ownership requires absence of every same-name core, even in an old portable directory. */
  private async recoverUnowned(problem: string): Promise<boolean> {
    try {
      const result = await (this.ops.inspect?.(this.exe, true) ?? RuntimeJournal.inspectUntracked(this.exe, true))
      if (!result.ok) return this.fail(`${problem}. ${result.error}`)
      return this.clear()
    } catch { return this.fail(`${problem}. Проверить процессы Windows не удалось. Повтори восстановление`) }
  }

  /** Shared by startup/retry callers so the same verified process is never terminated twice concurrently. */
  recover(): Promise<boolean> {
    if (this.recovering) return this.recovering
    this.recovering = this.recoverNow().finally(() => { this.recovering = undefined })
    return this.recovering
  }

  /** Returns false when ownership could not be verified; never kills by name, path alone, or a reused PID. */
  private async recoverNow(): Promise<boolean> {
    this.lastError = undefined
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.journal, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { lstatSync(this.runtimeFile) }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return true
          return this.fail('Не удалось проверить временный конфиг прошлого процесса. Повтори восстановление')
        }
        return this.recoverUnowned('Остался временный конфиг без журнала владельца')
      }
      return this.recoverUnowned('Журнал прошлого процесса повреждён')
    }
    if (!validLease(raw)) return this.recoverUnowned('Журнал прошлого процесса повреждён')
    const lease = raw
    const same = (f: Identity | null) => !!f && samePath(f.path, lease.path) && f.started === lease.started
    let found: Identity | null
    try {
      found = await this.ops.identity(lease.pid)
      if (found !== null && !validIdentity(found)) throw new Error('Process identity unavailable')
    } catch { return this.fail('Не удалось проверить владельца прошлого процесса движка. Повтори запуск Waarp с правами администратора') }
    // A new portable build may have a different extraction path. First reconcile the recorded identity,
    // not the current executable path: dead/reused PIDs are safe to clear after an upgrade or move too.
    if (!same(found)) return this.clear()
    if (win32.basename(lease.path).toLowerCase() !== win32.basename(this.exe).toLowerCase()) return this.fail('Журнал прошлого процесса ссылается на другой исполняемый файл. Автоматическая остановка заблокирована')
    try { if (!(await this.ops.terminate(lease.pid, found!))) return this.fail('Windows отказала в остановке прошлого процесса движка. Повтори запуск Waarp с правами администратора') }
    catch { return this.fail('Не удалось остановить подтверждённый прошлый процесс движка. Повтори восстановление') }
    // A terminate request is not proof. Bound both polling attempts and elapsed time; each Windows query is bounded too.
    const deadline = Date.now() + 5000
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      await this.ops.sleep(250)
      let now: Identity | null
      try {
        now = await this.ops.identity(lease.pid)
        if (now !== null && !validIdentity(now)) throw new Error('Process identity unavailable')
      } catch { return this.fail('Не удалось подтвердить завершение прошлого процесса движка. Повтори восстановление') }
      if (!same(now)) return this.clear()
    }
    return this.fail('Прошлый процесс движка ещё не завершился. Повтори восстановление')
  }
}
