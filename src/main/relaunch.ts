import { localized } from '../shared/localization'
import { ps } from './ps'

const WAIT_PARENT = '--waarp-wait-parent'
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 4

/** Replace any inherited handoff marker, preserving the app's ordinary launch arguments. */
export function relaunchArgs(args: string[], parentPid: number): string[] {
  if (!validPid(parentPid)) throw new Error(localized("winInline.relaunch.db7e2cebe57f"))
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === WAIT_PARENT) { i++; continue }
    if (args[i].startsWith(WAIT_PARENT + '=')) continue
    out.push(args[i])
  }
  return [...out, WAIT_PARENT, String(parentPid)]
}

export function relaunchParent(args: string[], selfPid = process.pid): number | undefined {
  let parent: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const raw = arg === WAIT_PARENT ? args[++i] : arg.startsWith(WAIT_PARENT + '=') ? arg.slice(WAIT_PARENT.length + 1) : undefined
    if (arg !== WAIT_PARENT && !arg.startsWith(WAIT_PARENT + '=')) continue
    const pid = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0
    if (parent !== undefined || !validPid(pid) || pid === selfPid) throw new Error(localized("winInline.relaunch.db7e2cebe57f"))
    parent = pid
  }
  return parent
}

type ParentWait = (script: string, timeout: number) => Promise<unknown>

/** Read-only handoff: hold every app-level writer until the exact process handle has exited, never just a timer. */
export async function waitForRelaunchParent(args: string[], execute: ParentWait = ps): Promise<boolean> {
  let pid: number | undefined
  try { pid = relaunchParent(args) } catch { return false }
  if (pid === undefined) return true
  // GetProcessById's missing-process ArgumentException means the parent already exited. Every other failure
  // is unknown, so the new app must not touch the shared store, bridge descriptor, or ownership journals.
  const script = `$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid})}catch{if($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]){'true';exit 0};throw};try{if($p.WaitForExit(20000)){'true'}else{'false'}}finally{$p.Dispose()}`
  try { return (await execute(script, 22_000)) === true } catch { return false }
}
