import { app, nativeImage } from 'electron'
import { wCoverage } from '../shared/brand-w'
import { basename } from 'node:path'
import type { AppInfo } from '../shared/types'
import { matchDirFor } from './awg'
import { arr, ps } from './ps'

const SKIP = /(unins|uninstall|setup|install|update(?!r\.exe)|crashpad|crashreport|crash processor|crash handler|helper|elevat|repair|readme|manual|help|license|cmd\.exe$|powershell|conhost|explorer\.exe$|svchost|runtimebroker|dllhost|msedgewebview2|textinputhost|searchhost|shellexperience|startmenuexperience|systemsettings|applicationframehost|ctfmon|sihost|taskhostw|lockapp|smartscreen|securityhealth|widgets|rundll32|waarp|sing-box|electron\.exe$)/i

const SCAN = `
$sh = New-Object -ComObject WScript.Shell
$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:PUBLIC\\Desktop", [Environment]::GetFolderPath('Desktop'))
$lnk = foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -File } }
$inst = foreach ($l in $lnk) { try { $t = $sh.CreateShortcut($l.FullName).TargetPath; if ($t -and $t.ToLower().EndsWith('.exe') -and (Test-Path -LiteralPath $t)) { [pscustomobject]@{ n = $l.BaseName; p = $t } } } catch {} }
$run = Get-Process | Where-Object { $_.Path } | Group-Object Path | ForEach-Object { $f = $_.Group[0]; $w = ($_.Group | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0; $d = $f.Description; [pscustomobject]@{ n = $(if ($d) { $d } else { $f.ProcessName }); p = $f.Path; w = $w } }
[pscustomobject]@{ i = @($inst); r = @($run) } | ConvertTo-Json -Depth 3 -Compress
`

interface Raw { i?: { n: string; p: string }[] | { n: string; p: string }; r?: { n: string; p: string; w: boolean }[] | { n: string; p: string; w: boolean } }

const iconCache = new Map<string, string>()
let appCache: AppInfo[] | undefined
let appCacheAt = 0
let scanInFlight: Promise<AppInfo[]> | undefined

async function icon(exe: string): Promise<string | undefined> {
  const k = exe.toLowerCase()
  if (iconCache.has(k)) return iconCache.get(k)
  let timeout: NodeJS.Timeout | undefined
  try {
    // getFileIcon can hang on some exes (shell handlers, network paths): never let one icon stall the whole scan
    const img = await Promise.race([app.getFileIcon(exe, { size: 'large' }), new Promise<never>((_, no) => { timeout = setTimeout(() => no(new Error('icon timeout')), 2000) })])
    const url = img.isEmpty() ? '' : img.toDataURL()
    iconCache.set(k, url)
    return url || undefined
  } catch {
    iconCache.set(k, '')
    return undefined
  } finally { clearTimeout(timeout) }
}

export const idOf = (exe: string) => exe.toLowerCase()

export async function scanApps(): Promise<AppInfo[]> {
  if (appCache && Date.now() - appCacheAt < 60_000) return appCache.map(a => ({ ...a }))
  if (scanInFlight) return scanInFlight
  scanInFlight = scanAppsFresh()
  try { return await scanInFlight } finally { scanInFlight = undefined }
}

async function scanAppsFresh(): Promise<AppInfo[]> {
  const raw = await ps<Raw>(SCAN, 45000)
  const map = new Map<string, AppInfo>()
  for (const x of arr(raw.i)) {
    if (!x?.p || !x.n) continue
    if (SKIP.test(basename(x.p)) || SKIP.test(x.n)) continue
    const id = idOf(x.p)
    if (map.has(id)) continue
    map.set(id, { id, name: x.n.replace(/\s*\(x64\)|\s*\(64-bit\)/gi, ''), exe: x.p, matchDir: matchDirFor(x.p), running: false, windowed: false, source: 'installed' })
  }
  for (const x of arr(raw.r)) {
    if (!x?.p) continue
    const id = idOf(x.p)
    const had = map.get(id)
    if (had) { had.running = true; had.windowed = had.windowed || x.w; continue }
    if (SKIP.test(basename(x.p)) || /\\windows\\/i.test(x.p)) continue
    map.set(id, { id, name: x.n || basename(x.p).replace(/.exe$/i, ""), exe: x.p, matchDir: matchDirFor(x.p), running: true, windowed: x.w, source: 'running' })
  }
  const dirs = new Map<string, AppInfo>()
  for (const a of map.values()) if (a.source === 'installed' && a.matchDir) dirs.set(a.matchDir.toLowerCase(), a)
  for (const a of [...map.values()].sort((x, y) => Number(y.windowed) - Number(x.windowed))) {
    if (a.source !== 'running' || !a.matchDir) continue
    const k = a.matchDir.toLowerCase()
    const owner = dirs.get(k)
    if (owner) { owner.running = true; map.delete(a.id); continue }
    dirs.set(k, a)
  }
  const list = [...map.values()].sort((a, b) => Number(b.windowed) - Number(a.windowed) || Number(b.running) - Number(a.running) || a.name.localeCompare(b.name, 'ru'))
  // Return inventory before slow Windows shell icon providers finish.
  appCache = list
  appCacheAt = Date.now()
  void (async () => {
    for (let i = 0; i < list.length; i += 6) {
      await Promise.all(list.slice(i, i + 6).map(async a => { a.icon = await icon(a.exe) }))
    }
  })()
  return list.map(a => ({ ...a }))
}

export async function describeExe(exe: string): Promise<AppInfo> {
  const name = basename(exe).replace(/\.exe$/i, '')
  return { id: idOf(exe), name, exe, matchDir: matchDirFor(exe), running: false, windowed: false, source: 'manual', icon: await icon(exe) }
}

/** RC2 A: tray = the wordmark w (no window mark); grey closed, accent open */
export function trayImage(on: boolean) {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  const c = on ? [0xd9, 0x77, 0x57] : [0x8f, 0x95, 0x9a]
  const cov = wCoverage(size, 0.94)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    // BGRA, premultiplied alpha
    const a = cov[i]
    buf[o] = Math.round(c[2] * a); buf[o + 1] = Math.round(c[1] * a); buf[o + 2] = Math.round(c[0] * a); buf[o + 3] = Math.round(a * 255)
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}
