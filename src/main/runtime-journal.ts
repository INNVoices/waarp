// C12: only a process recorded by this Waarp run may be recovered. The journal has no credentials.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { ps } from './ps'

interface Identity { path: string; started: string }
interface Lease extends Identity { version: 1; runId: string; pid: number }

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

async function identity(pid: number): Promise<Identity | null> {
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){'null'}else{[pscustomobject]@{path=$p.ExecutablePath;started=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`
  const value = await ps<Identity | null>(script)
  if (value === null) return null
  if (!value || typeof value.path !== 'string' || typeof value.started !== 'string') throw new Error('Process identity unavailable')
  return value
}

/** read-only process identity + a terminate that re-checks the identity first; injectable for offline tests */
export interface ProcessOps {
  identity: (pid: number) => Promise<Identity | null>
  terminate: (pid: number, id: Identity) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}
const realOps: ProcessOps = {
  identity,
  terminate: async (pid, id) => {
    const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){'true'}elseif($p.ExecutablePath -ieq ${quote(id.path)} -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq ${quote(id.started)}){$r=Invoke-CimMethod -InputObject $p -MethodName Terminate;if($r.ReturnValue -eq 0){'true'}else{'false'}}else{'true'}`
    return (await ps<boolean>(script)) === true
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

export class RuntimeJournal {
  private journal: string
  private runtimeFile: string
  private runId = randomBytes(16).toString('hex')
  private lease?: Lease

  constructor(private dir: string, private exe: string, configName: 'run.json' | 'check.json', private ops: ProcessOps = realOps) {
    this.journal = join(dir, configName + '.owner')
    this.runtimeFile = join(dir, configName)
  }

  async record(pid: number | undefined): Promise<boolean> {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false
    const temp = this.journal + '.tmp'
    try {
      const found = await this.ops.identity(pid)
      if (!found || found.path.toLowerCase() !== this.exe.toLowerCase()) return false
      const lease: Lease = { version: 1, runId: this.runId, pid, path: found.path, started: found.started }
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temp, JSON.stringify(lease))
      renameSync(temp, this.journal)
      this.lease = lease
      return true
    } catch { try { rmSync(temp, { force: true }) } catch {}; return false }
  }

  /** R2: is this PID still exactly the process recorded by this run (path + creation time)? Read-only. */
  async owned(pid: number): Promise<'same' | 'gone' | 'other' | 'unknown'> {
    const l = this.lease
    if (!l || l.pid !== pid) return 'unknown'
    try {
      const found = await this.ops.identity(pid)
      if (!found) return 'gone'
      return found.path.toLowerCase() === l.path.toLowerCase() && found.started === l.started ? 'same' : 'other'
    } catch { return 'unknown' }
  }

  clear(): void {
    this.lease = undefined
    try { rmSync(this.journal, { force: true }) } catch { /* retry on next launch */ }
    try { rmSync(this.runtimeFile, { force: true }) } catch { /* retry on next launch */ }
  }

  /** After all known leases are reconciled, block startup if an older untracked copy still uses this executable. */
  static async noUntracked(exe: string): Promise<boolean> {
    try {
      const name = quote(basename(exe))
      const path = quote(exe)
      const script = `$ErrorActionPreference='Stop';$p=@(Get-CimInstance Win32_Process -Filter "Name = ${name}");if(@($p|Where-Object{-not $_.ExecutablePath -or $_.ExecutablePath -ieq ${path}}).Count -gt 0){'false'}else{'true'}`
      return (await ps<boolean>(script)) === true
    } catch { return false }
  }

  /** Returns false when ownership could not be verified; never kills by name, path alone, or a reused PID. */
  async recover(): Promise<boolean> {
    if (!existsSync(this.journal)) return true
    let lease: Lease
    try { lease = JSON.parse(readFileSync(this.journal, 'utf8')) } catch { return false }
    if (lease.version !== 1 || !/^[0-9a-f]{32}$/.test(lease.runId) || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 ||
        typeof lease.path !== 'string' || lease.path.toLowerCase() !== this.exe.toLowerCase() ||
        typeof lease.started !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(lease.started)) return false
    const same = (f: Identity | null) => !!f && f.path.toLowerCase() === lease.path.toLowerCase() && f.started === lease.started
    let found: Identity | null
    try { found = await this.ops.identity(lease.pid) } catch { return false }
    // gone, or the PID now belongs to another process (reuse): the recorded process no longer exists; never touch the new one
    if (!same(found)) { this.clear(); return true }
    try { if (!(await this.ops.terminate(lease.pid, found!))) return false } catch { return false }
    // a terminate request is not proof: clear the lease only when that exact identity is observed gone
    for (let i = 0; i < 20; i++) {
      await this.ops.sleep(250)
      let now: Identity | null
      try { now = await this.ops.identity(lease.pid) } catch { return false }
      if (!same(now)) { this.clear(); return true }
    }
    return false
  }
}
