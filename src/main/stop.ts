// Hardening R2: try CTRL_BREAK only for an exactly owned process with an isolated console.
// A windowsHide/piped Node spawn normally has no console; report that so the caller can use its own child handle
// immediately instead of waiting for a signal that was never sent. Never signal an inherited/shared console.
import { ps } from './ps'
import type { ProcessIdentity } from './runtime-journal'

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
const SCRIPT = (pid: number, identity: ProcessIdentity) => `$ErrorActionPreference='Stop'
$owned=$null
$attached=$false
$sent=$false
try {
  $owned=[Diagnostics.Process]::GetProcessById(${pid})
  $null=$owned.Handle
  $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'
  if($null -ne $p -and $p.ExecutablePath -ieq ${quote(identity.path)} -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq ${quote(identity.started)} -and -not $owned.HasExited){
    Add-Type -Namespace WaarpStop -Name K -MemberDefinition '
      [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool FreeConsole();
      [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
      [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList([System.Runtime.InteropServices.Out] uint[] p, uint n);
      [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);
      public delegate bool Handler(uint e);
      public static readonly Handler Ignore = delegate(uint e) { return true; };
      [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(Handler h, bool add);'
    [WaarpStop.K]::FreeConsole() | Out-Null
    $attached=[WaarpStop.K]::AttachConsole(${pid})
    if($attached){
      $members=New-Object uint32[] 3
      $count=[WaarpStop.K]::GetConsoleProcessList($members,3)
      if($count -eq 2 -and $members -contains [uint32]${pid} -and $members -contains [uint32]$PID -and [WaarpStop.K]::SetConsoleCtrlHandler([WaarpStop.K]::Ignore,$true)){
        $sent=[WaarpStop.K]::GenerateConsoleCtrlEvent(1,${pid})
      }
    }
  }
} catch { } finally { if($attached){[WaarpStop.K]::FreeConsole() | Out-Null};if($null -ne $owned){$owned.Dispose()} }
$sent | ConvertTo-Json -Compress`

/** True means a native signal was sent, not that the process exited; the caller must still observe its own handle. */
export async function ctrlBreak(pid: number, identity: ProcessIdentity, timeout = 5000): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 4 || !identity?.path || !identity.started) return false
  // Hold a native handle across the second identity check and AttachConsole. A prior ownership
  // query in Node is not enough: its target can exit before this separate helper even starts.
  try { return (await ps<boolean>(SCRIPT(pid, identity), timeout)) === true } catch { return false }
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
  try { return await Promise.race([job, new Promise<'timeout'>(res => { t = setTimeout(() => res('timeout'), ms) })]) }
  finally { clearTimeout(t) }
}
