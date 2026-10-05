// Hardening R2 (A + C): graceful Windows stop of the owned core. The core runs in its own hidden console; a hidden
// helper attaches to that console and raises CTRL_BREAK, which sing-box handles as an interrupt (clean close, exit 0).
// Only a numeric internal PID enters the helper; PowerShell comes from System32, never from PATH.
import { execFile } from 'node:child_process'
import { POWERSHELL } from './ps'

const SCRIPT = (pid: number) => `$ErrorActionPreference='SilentlyContinue'
Add-Type -Namespace WaarpStop -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p); [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);'
[WaarpStop.K]::FreeConsole() | Out-Null
if ([WaarpStop.K]::AttachConsole(${pid})) { [WaarpStop.K]::GenerateConsoleCtrlEvent(1, 0) | Out-Null }`

/** best effort: the caller decides by watching the exact process exit, never by this result */
export function ctrlBreak(pid: number, timeout = 5000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 4) return Promise.resolve()
  const encoded = Buffer.from(SCRIPT(pid), 'utf16le').toString('base64')
  return new Promise(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout }, () => resolve())
  })
}

/** wait for an exit event (or an already exited child) up to `ms` */
export function waitExit(c: { exitCode: number | null; signalCode: string | null; once(ev: 'exit', f: () => void): unknown; removeListener?(ev: 'exit', f: () => void): unknown }, ms: number): Promise<boolean> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); resolve(true) }
    const t = setTimeout(() => { c.removeListener?.('exit', done); resolve(false) }, ms)
    c.once('exit', done)
  })
}

/** R2.2: run a shutdown job with a hard upper bound; never hangs the app or Windows shutdown */
export async function bounded<T>(job: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout | undefined
  const r = await Promise.race([job, new Promise<'timeout'>(res => { t = setTimeout(() => res('timeout'), ms) })])
  clearTimeout(t)
  return r
}
