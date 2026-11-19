import { localized } from '../shared/localization'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

/** POSIX mode is not a Windows ACL. Throws unless the OS confirms a private file. */
export function protectPrivateFile(path: string): void {
  if (process.platform !== 'win32') { chmodSync(path, 0o600); return }
  const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
  const systemRoot = process.env.SystemRoot
  if (!user || !systemRoot) throw new Error(localized("winInline.private-file.0cbec4f11ce6"))
  execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [
    path, '/inheritance:r', '/grant:r', `${user}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
  ], { windowsHide: true, stdio: 'ignore' })
}

/** Background persistence must not block Electron's event loop on an ACL process. */
export async function protectPrivateFileAsync(path: string): Promise<void> {
  if (process.platform !== 'win32') { await chmod(path, 0o600); return }
  const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
  const systemRoot = process.env.SystemRoot
  if (!user || !systemRoot) throw new Error(localized("winInline.private-file.0cbec4f11ce6"))
  await new Promise<void>((resolve, reject) => execFile(join(systemRoot, 'System32', 'icacls.exe'), [
    path, '/inheritance:r', '/grant:r', `${user}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)'
  ], { windowsHide: true, timeout: 5000, maxBuffer: 16384 }, error => error ? reject(error) : resolve()))
}
