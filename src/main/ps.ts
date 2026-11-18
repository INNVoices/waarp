import { localized } from '../shared/localization'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const SYS = process.env.SystemRoot || 'C:\\Windows'
export const POWERSHELL = join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function ps<T = unknown>(script: string, timeout = 20000): Promise<T> {
  const wrapped = `$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, out) => {
        // Partial stdout is not proof that a native inspection completed. In
        // particular, a timeout/nonzero exit must never turn JSON `true` into success.
        if (err) return reject(new Error(err.killed
          ? localized("winInline.ps.dc474dc806fd")
          : localized("winInline.ps.988ea28029b6", err.code ?? 'unknown')))
        const s = out.trim()
        if (!s) return resolve([] as T)
        try { resolve(JSON.parse(s) as T) } catch { reject(new Error(localized("winInline.ps.4ec294eb1ea0"))) }
      })
  })
}

export async function isAdmin(): Promise<boolean> {
  // `net session` depends on the Server service, which can be disabled even for
  // an elevated user. Inspect the current UAC token instead; bound the native call.
  const script = `$ErrorActionPreference='Stop';$id=[Security.Principal.WindowsIdentity]::GetCurrent();try{$principal=New-Object Security.Principal.WindowsPrincipal($id);$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)|ConvertTo-Json -Compress}finally{$id.Dispose()}`
  try { return (await ps<boolean>(script, 10000)) === true } catch { return false }
}

/** Cache only proven elevation. A failed initial native read must remain retryable;
 *  concurrent callers share one bounded read instead of spawning PowerShell in parallel. */
export function createAdminCheck(read: () => Promise<boolean> = isAdmin): () => Promise<boolean> {
  let elevated = false
  let pending: Promise<boolean> | undefined
  return () => {
    if (elevated) return Promise.resolve(true)
    if (pending) return pending
    const current = Promise.resolve().then(read).catch(() => false).then(value => { elevated = value === true; return elevated }).finally(() => {
      if (pending === current) pending = undefined
    })
    pending = current
    return current
  }
}

export const arr = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x])
