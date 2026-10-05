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
        if (err && !out) return reject(err)
        const s = out.trim()
        if (!s) return resolve([] as T)
        try { resolve(JSON.parse(s) as T) } catch (e) { reject(e) }
      })
  })
}

export function isAdmin(): Promise<boolean> {
  return new Promise(resolve => {
    execFile(join(SYS, 'System32', 'net.exe'), ['session'], { windowsHide: true }, err => resolve(!err))
  })
}

export const arr = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x])
