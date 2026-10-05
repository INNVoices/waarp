import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

/** POSIX mode is not a Windows ACL. Throws unless the OS confirms a private file. */
export function protectPrivateFile(path: string): void {
  if (process.platform !== 'win32') { chmodSync(path, 0o600); return }
  const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
  const systemRoot = process.env.SystemRoot
  if (!user || !systemRoot) throw new Error('Windows account identity unavailable')
  execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [
    path, '/inheritance:r', '/grant:r', `${user}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
  ], { windowsHide: true, stdio: 'ignore' })
}
