// Read-only companion for the installed ExitLag client.
// No network probes, private IPC calls, driver control, writes to ExitLag or UI actions.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExitLagSelection, ExitLagSnapshot, ExitLagVisibleCatalog } from '../shared/exitlag'
import { ps } from './ps'

interface SelectionRow { id: number; property_name: string; property_value: string | null }
const KEYS = new Set(['enabled', 'automatic_fs', 'fs_name', 'fs_alias', 'fs_country'])

/** Pure projection: never expose other DB fields (account, device, diagnostic data, etc.). */
export function parseExitLagSelections(rows: readonly SelectionRow[]): ExitLagSelection[] {
  const apps = new Map<number, Record<string, string>>()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.id) || row.id < 0 || !KEYS.has(row.property_name)) continue
    if (typeof row.property_value !== 'string' || row.property_value.length > 120) continue
    const values = apps.get(row.id) ?? {}
    values[row.property_name] = row.property_value
    apps.set(row.id, values)
  }
  return [...apps.entries()].map(([appId, values]) => ({
    appId,
    selectedServer: values.fs_name ?? '',
    country: /^[A-Z]{2}$/.test(values.fs_country ?? '') ? values.fs_country : '',
    alias: /^[A-Za-z0-9._-]{1,120}$/.test(values.fs_alias ?? '') ? values.fs_alias : '',
    enabled: values.enabled === '1',
    automatic: values.automatic_fs === '1'
  })).filter(row => row.selectedServer || row.alias).sort((a, b) => a.appId - b.appId)
}

/** SQLite immutable URI is read-only and does not create WAL/SHM beside the vendor DB.
 * A busy-WAL snapshot can be stale; never call this live connectivity evidence. */
export function readSavedExitLagSelections(file: string): ExitLagSelection[] {
  const size = statSync(file).size
  if (size < 100 || size > 24 * 1024 * 1024) throw new Error('Unexpected ExitLag database size')
  const uri = pathToFileURL(file)
  uri.searchParams.set('mode', 'ro')
  uri.searchParams.set('immutable', '1')
  const db = new DatabaseSync(uri, { readOnly: true, timeout: 150 })
  try {
    const rows = db.prepare("SELECT id, property_name, property_value FROM apps WHERE property_name IN ('enabled','automatic_fs','fs_name','fs_alias','fs_country') LIMIT 1500").all() as unknown as SelectionRow[]
    return parseExitLagSelections(rows)
  } finally { db.close() }
}

export function exitLagExe(): string | undefined {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((s): s is string => !!s)
  for (const dir of dirs) {
    const candidate = join(dir, 'ExitLag', 'ExitLag.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

export async function exitLagSnapshot(): Promise<ExitLagSnapshot> {
  const local = process.env.LOCALAPPDATA
  const file = local ? join(local, 'ExitLag', 'storage.db') : undefined
  const installed = !!exitLagExe() || (!!file && existsSync(file))
  const checkedAt = Date.now()
  const running = await ps<boolean>("(@(Get-Process -Name ExitLag -ErrorAction SilentlyContinue).Count -gt 0) | ConvertTo-Json -Compress", 8000).catch(() => false)
  if (!file || !existsSync(file)) return { installed, running, checkedAt, selections: [], completeCatalog: false }
  try {
    return { installed, running, checkedAt, selections: readSavedExitLagSelections(file), completeCatalog: false }
  } catch {
    return { installed, running, checkedAt, selections: [], completeCatalog: false, error: 'Не удалось прочитать сохранённые варианты ExitLag' }
  }
}

/** Inspect visible server names only. Does NOT open menus, scroll, click or select.
 * The UI must already show the ExitLag server picker. No remote endpoints/IDs. */
const VISIBLE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]
$p=Get-Process -Name ExitLag -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { @{screenOpen=$false;names=@()} | ConvertTo-Json -Compress; return }
$cond=New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty,[int]$p.Id)
$top=$A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$cond)
if (-not $top) { @{screenOpen=$false;names=@()} | ConvertTo-Json -Compress; return }
$textCond=New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)
$all=$top.FindAll([System.Windows.Automation.TreeScope]::Subtree,$textCond)
$names=New-Object System.Collections.Generic.List[string]
$marker=$false
$region=''
$regions=@('Северная Америка','Южная Америка','Европа','Азия','Океания')
for($i=0;$i -lt [Math]::Min($all.Count,1800);$i++){
  try {
    $c=$all.Item($i).Current
    if($c.IsOffscreen){continue}
    $name=([string]$c.Name).Trim()
    if($name -eq 'СЕРВЕРЫ'){$marker=$true}
    if($regions -contains $name){$region=$name}
    if($name.Length -le 65 -and [regex]::IsMatch($name,'^[A-Z]{2} [\p{L}\p{N} ._-]{2,58}$')){$names.Add($name)}
  }catch{}
}
@{screenOpen=$marker;region=$region;names=@($names)} | ConvertTo-Json -Compress -Depth 3
`

export async function exitLagVisibleCatalog(): Promise<ExitLagVisibleCatalog> {
  try {
    const raw = await ps<{ screenOpen?: boolean; region?: string; names?: string[] }>(VISIBLE_SCRIPT, 10000)
    const names = Array.isArray(raw?.names) ? raw.names.filter(n => typeof n === 'string' && /^[A-Z]{2} [\p{L}\p{N} ._-]{2,58}$/u.test(n)).slice(0, 150) : []
    return { screenOpen: raw?.screenOpen === true, region: typeof raw?.region === 'string' ? raw.region.slice(0, 40) : undefined, names, complete: false }
  } catch {
    return { screenOpen: false, names: [], complete: false, error: 'Не удалось прочитать видимые узлы ExitLag через Windows UI Automation' }
  }
}
