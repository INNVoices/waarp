// Windows TUN safety (hardening R1): Waarp's own TUN service subnet, the recursion guard rule, controller port choice,
// the startup readiness budget and a read-only preflight for a stale Waarp adapter or a subnet collision.
// Nothing here changes Windows: when the state is ambiguous Waarp refuses to start instead of "repairing" the system.
import { BlockList, createServer, isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { ps } from './ps'
import type { DefaultRoute } from './resume'

export const TUN = {
  name: 'Waarp',
  v4: { addr: '172.19.77.1/30', net: '172.19.77.0', bits: 30 },
  v6: { addr: 'fdfe:dcba:9876::1/126', net: 'fdfe:dcba:9876::', bits: 126 },
} as const
export const TUN_ADDRESSES = [TUN.v4.addr, TUN.v6.addr]
export const TUN_SUBNETS = [`${TUN.v4.net}/${TUN.v4.bits}`, `${TUN.v6.net}/${TUN.v6.bits}`]

/** R1.1: traffic to Waarp's own TUN service pair is dropped (after DNS hijack, before private/LAN direct) so direct
 *  can never feed it back into the same TUN. Only this /30 + /126, never ordinary LAN ranges. */
export const serviceGuardRule = (): Record<string, unknown> => ({ ip_cidr: [...TUN_SUBNETS], action: 'reject' })

/** R1.2: total time the core gets to open Wintun and answer its controller (Windows can need ~15 s to fail on its own) */
export const START_BUDGET_MS = 20_000
/** Race a read-only operation against cancellation without leaving an abort listener behind. */
export async function untilCancelled<T>(job: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) { void job.catch(() => undefined); return undefined }
  let cancel!: () => void
  const aborted = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([job, aborted]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export async function waitReady(o: {
  probe: () => Promise<boolean>; alive: () => boolean; signal?: AbortSignal
  budget?: number; every?: number; now?: () => number; sleep?: (ms: number) => Promise<void>
  setTimer?: (f: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void
}): Promise<'ready' | 'exited' | 'timeout' | 'cancelled'> {
  const now = o.now ?? (() => performance.now()), sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const setT = o.setTimer ?? ((f: () => void, ms: number) => setTimeout(f, ms))
  const clearT = o.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
  const end = now() + (o.budget ?? START_BUDGET_MS)
  if (o.signal?.aborted) return 'cancelled'
  if (now() >= end) return 'timeout'
  let expired = false, timer: unknown, cancel!: () => void
  // One deadline bounds the whole wait, including an outstanding controller call.
  // The call retains its own I/O timeout; its late result cannot trigger another probe.
  const stopped = new Promise<'timeout' | 'cancelled'>(resolve => {
    cancel = () => resolve('cancelled')
    o.signal?.addEventListener('abort', cancel, { once: true })
    timer = setT(() => { expired = true; resolve('timeout') }, Math.max(0, end - now()))
  })
  try {
    while (!expired && now() < end) {
      if (o.signal?.aborted) return 'cancelled'
      if (!o.alive()) return 'exited'
      if (expired || now() >= end) return 'timeout'
      const ready = await Promise.race([o.probe(), stopped])
      if (o.signal?.aborted) return 'cancelled'
      if (typeof ready === 'string') return ready
      // A queued response proves readiness only while this process is alive and within budget.
      if (!o.alive()) return 'exited'
      if (expired || now() >= end) return 'timeout'
      if (ready) return 'ready'
      const paused = await Promise.race([sleep(Math.min(o.every ?? 300, Math.max(0, end - now()))), stopped])
      if (typeof paused === 'string') return o.signal?.aborted ? 'cancelled' : paused
    }
    return o.signal?.aborted ? 'cancelled' : 'timeout'
  } finally {
    if (timer !== undefined) clearT(timer)
    o.signal?.removeEventListener('abort', cancel)
  }
}

/** R1.3: a free loopback port from a broad ephemeral range; undefined = none, and then nothing is spawned */
export const PORT_RANGE = [20000, 59999] as const
export async function pickPort(free: (port: number) => Promise<boolean> = loopbackFree, tries = 24, rand: () => number = Math.random): Promise<number | undefined> {
  const seen = new Set<number>()
  for (let i = 0; i < tries; i++) {
    const p = PORT_RANGE[0] + Math.floor(rand() * (PORT_RANGE[1] - PORT_RANGE[0] + 1))
    if (seen.has(p)) continue
    seen.add(p)
    if (await free(p)) return p
  }
  return undefined
}
export const loopbackFree = (port: number): Promise<boolean> => new Promise(res => {
  const s = createServer()
  s.once('error', () => res(false))
  s.listen({ host: '127.0.0.1', port, exclusive: true }, () => s.close(() => res(true)))
})

// ---- R1.4 read-only preflight
export interface TunSnapshot {
  adapters: { name: string; desc?: string; status?: string }[]
  addrs: { ip: string; alias?: string }[]
  routes: { prefix: string; alias?: string }[]
}
export type Preflight = { ok: true } | { ok: false; kind: 'tun_stale' | 'tun_collision' | 'tun_unknown'; text: string }

const ours = new BlockList()
ours.addSubnet(TUN.v4.net, TUN.v4.bits, 'ipv4')
ours.addSubnet(TUN.v6.net, TUN.v6.bits, 'ipv6')
const family = (ip: string): 'ipv4' | 'ipv6' | undefined => (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? 'ipv4' : ip.includes(':') ? 'ipv6' : undefined)
const inOurs = (ip: string): boolean => { const f = family(ip); try { return !!f && ours.check(ip.split('%')[0], f) } catch { return false } }
/** a route that lies inside (or equals) our service subnet; broader routes (default, /1 halves, a LAN /24) are not ours */
const routeInOurs = (prefix: string): boolean => {
  const [net, bitsS] = prefix.split('/')
  const bits = Number(bitsS), f = family(net ?? '')
  if (!f || !Number.isInteger(bits) || bits > (f === 'ipv4' ? 32 : 128)) return false
  return bits >= (f === 'ipv4' ? TUN.v4.bits : TUN.v6.bits) && inOurs(net)
}

/** pure decision. Called only when no Waarp core is running, so any adapter named exactly Waarp is a leftover. */
export function tunPreflight(snap: TunSnapshot | undefined): Preflight {
  if (!snap) return { ok: false, kind: 'tun_unknown', text: 'Не удалось проверить сетевые адаптеры Windows. Туннель не запущен, сеть не менялась' }
  if (snap.adapters.some(a => a.name.toLowerCase() === TUN.name.toLowerCase())) {
    return { ok: false, kind: 'tun_stale', text: 'В Windows остался адаптер Waarp от прошлого запуска. Новый туннель не запущен. Перезагрузи компьютер и попробуй снова; Waarp не будет удалять сетевые адаптеры автоматически' }
  }
  const taken = [...snap.addrs.filter(a => inOurs(a.ip)).map(a => a.alias), ...snap.routes.filter(r => routeInOurs(r.prefix)).map(r => r.alias)]
  if (taken.length) {
    const who = [...new Set(taken.filter(Boolean))].slice(0, 2).join(', ')
    return { ok: false, kind: 'tun_collision', text: `Служебная подсеть Waarp уже занята${who ? ` (${who})` : ''}. Туннель не запущен, чужую сеть Waarp не трогает` }
  }
  return { ok: true }
}

const SNAP = `
$ErrorActionPreference='Stop'
$a=@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -eq '${TUN.name}' } | ForEach-Object { [pscustomobject]@{ name=$_.Name; desc=$_.InterfaceDescription; status=[string]$_.Status } })
$ip=@(Get-NetIPAddress | Where-Object { $_.IPAddress -like '172.19.*' -or $_.IPAddress -like 'fdfe:*' } | ForEach-Object { [pscustomobject]@{ ip=$_.IPAddress; alias=$_.InterfaceAlias } })
$rt=@(Get-NetRoute | Where-Object { $_.DestinationPrefix -like '172.19.*' -or $_.DestinationPrefix -like 'fdfe:*' } | ForEach-Object { [pscustomobject]@{ prefix=$_.DestinationPrefix; alias=$_.InterfaceAlias } })
[pscustomobject]@{ ok=1; adapters=$a; addrs=$ip; routes=$rt } | ConvertTo-Json -Depth 4 -Compress
`
/** read-only Windows inspection; undefined when it could not be read (then the caller refuses to start) */
export function parseTunSnapshot(raw: unknown): TunSnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as { ok?: unknown; adapters?: unknown; addrs?: unknown; routes?: unknown }
  if (r.ok !== 1 || !Array.isArray(r.adapters) || !Array.isArray(r.addrs) || !Array.isArray(r.routes)) return undefined
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const optionalText = (v: unknown) => v === undefined || typeof v === 'string'
  if (!r.adapters.every(a => object(a) && typeof a.name === 'string' && !!a.name.trim() && optionalText(a.desc) && optionalText(a.status)) ||
      !r.addrs.every(a => object(a) && typeof a.ip === 'string' && isIP(a.ip.split('%')[0]) !== 0 && optionalText(a.alias)) ||
      !r.routes.every(route => {
        if (!object(route) || typeof route.prefix !== 'string' || !optionalText(route.alias)) return false
        const [address, bits, extra] = route.prefix.split('/')
        const af = isIP(address)
        return extra === undefined && !!af && /^\d+$/.test(bits ?? '') && Number(bits) <= (af === 4 ? 32 : 128)
      })) return undefined
  return { adapters: r.adapters, addrs: r.addrs, routes: r.routes } as TunSnapshot
}

export async function tunSnapshot(read: () => Promise<unknown> = () => ps(SNAP, 15000)): Promise<TunSnapshot | undefined> {
  try {
    return parseTunSnapshot(await read())
  } catch { return undefined }
}

const ROUTES = `
$ErrorActionPreference='Stop'
$up=@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $_.ifIndex })
$routes=@(Get-NetRoute | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','::/0' } | ForEach-Object { [pscustomobject]@{ alias=[string]$_.InterfaceAlias; nextHop=[string]$_.NextHop; up=[bool]($up -contains $_.ifIndex) } })
[pscustomobject]@{ok=1;routes=$routes}|ConvertTo-Json -Depth 3 -Compress
`
export function tunGuid(name: string = TUN.name): string {
  const h = createHash('md5').update('wintun' + name).digest()
  const x = (b: Buffer) => b.toString('hex').toUpperCase()
  const rev = (a: number, b: number) => x(Buffer.from(h.subarray(a, b)).reverse())
  return `{${rev(0, 4)}-${rev(4, 6)}-${rev(6, 8)}-${x(h.subarray(8, 10))}-${x(h.subarray(10, 16))}}`
}

const GHOST = (id: string) => `
$ErrorActionPreference='Stop'
$id='${id}'
$pnp=Join-Path $env:SystemRoot 'System32\\pnputil.exe'
if (@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -eq '${TUN.name}' }).Count -gt 0) { [pscustomobject]@{ok=1;state='adapter'} | ConvertTo-Json -Compress; return }
if ($null -eq (Get-PnpDevice -InstanceId $id -ErrorAction SilentlyContinue)) { [pscustomobject]@{ok=1;state='none'} | ConvertTo-Json -Compress; return }
$null = & $pnp /remove-device $id
for ($i=0; $i -lt 20 -and $null -ne (Get-PnpDevice -InstanceId $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 150 }
$left = $null -ne (Get-PnpDevice -InstanceId $id -ErrorAction SilentlyContinue)
[pscustomobject]@{ok=1;state=$(if($left){'left'}else{'removed'})} | ConvertTo-Json -Compress
`

export type GhostState = 'none' | 'removed' | 'left' | 'adapter' | 'unknown'
export async function clearTunGhost(read: (script: string) => Promise<unknown> = script => ps(script, 15000)): Promise<GhostState> {
  try {
    const r = await read(GHOST('SWD\\WINTUN\\' + tunGuid())) as { ok?: unknown; state?: unknown }
    return r?.ok === 1 && ['none', 'removed', 'left', 'adapter'].includes(String(r.state)) ? r.state as GhostState : 'unknown'
  } catch { return 'unknown' }
}

/** Both address families matter for wake-up readiness; a partial response remains unknown. */
export function parseDefaultRoutes(raw: unknown): DefaultRoute[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as { ok?: unknown; routes?: unknown }
  if (r.ok !== 1 || !Array.isArray(r.routes)) return undefined
  if (!r.routes.every(route => route && typeof route === 'object' && !Array.isArray(route) &&
      typeof route.alias === 'string' && !!route.alias.trim() && typeof route.nextHop === 'string' &&
      isIP(route.nextHop.split('%')[0]) !== 0 && typeof route.up === 'boolean')) return undefined
  return r.routes as DefaultRoute[]
}

/** R4: read-only IPv4/IPv6 default routes with their interface state; undefined when unreadable. */
export async function defaultRoutes(read: () => Promise<unknown> = () => ps(ROUTES, 10000)): Promise<DefaultRoute[] | undefined> {
  try {
    return parseDefaultRoutes(await read())
  } catch { return undefined }
}
