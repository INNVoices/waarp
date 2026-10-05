// Windows TUN safety (hardening R1): Waarp's own TUN service subnet, the recursion guard rule, controller port choice,
// the startup readiness budget and a read-only preflight for a stale Waarp adapter or a subnet collision.
// Nothing here changes Windows: when the state is ambiguous Waarp refuses to start instead of "repairing" the system.
import { BlockList, createServer } from 'node:net'
import { arr, ps } from './ps'

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
export async function waitReady(o: { probe: () => Promise<boolean>; alive: () => boolean; budget?: number; every?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<'ready' | 'exited' | 'timeout'> {
  const now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const end = now() + (o.budget ?? START_BUDGET_MS)
  while (now() < end) {
    if (!o.alive()) return 'exited'
    if (await o.probe()) return 'ready'
    if (!o.alive()) return 'exited'
    await sleep(o.every ?? 300)
  }
  return 'timeout'
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
  if (!f || !Number.isInteger(bits)) return false
  return bits >= (f === 'ipv4' ? TUN.v4.bits : TUN.v6.bits) && inOurs(net)
}

/** pure decision. Called only when no Waarp core is running, so any adapter named exactly Waarp is a leftover. */
export function tunPreflight(snap: TunSnapshot | undefined): Preflight {
  if (!snap) return { ok: false, kind: 'tun_unknown', text: 'Не удалось проверить сетевые адаптеры Windows. Туннель не запущен, сеть не менялась' }
  if (snap.adapters.some(a => a.name === TUN.name)) {
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
$a=@(Get-NetAdapter -IncludeHidden | Where-Object { $_.Name -eq '${TUN.name}' } | ForEach-Object { [pscustomobject]@{ name=$_.Name; desc=$_.InterfaceDescription; status=[string]$_.Status } })
$ip=@(Get-NetIPAddress | Where-Object { $_.IPAddress -like '172.19.*' -or $_.IPAddress -like 'fdfe:*' } | ForEach-Object { [pscustomobject]@{ ip=$_.IPAddress; alias=$_.InterfaceAlias } })
$rt=@(Get-NetRoute | Where-Object { $_.DestinationPrefix -like '172.19.*' -or $_.DestinationPrefix -like 'fdfe:*' } | ForEach-Object { [pscustomobject]@{ prefix=$_.DestinationPrefix; alias=$_.InterfaceAlias } })
[pscustomobject]@{ ok=1; adapters=$a; addrs=$ip; routes=$rt } | ConvertTo-Json -Depth 4 -Compress
`
/** read-only Windows inspection; undefined when it could not be read (then the caller refuses to start) */
export async function tunSnapshot(): Promise<TunSnapshot | undefined> {
  try {
    const r = await ps<{ ok?: number; adapters?: unknown; addrs?: unknown; routes?: unknown }>(SNAP, 15000)
    if (!r || Array.isArray(r) || r.ok !== 1) return undefined
    return { adapters: arr(r.adapters as TunSnapshot['adapters']), addrs: arr(r.addrs as TunSnapshot['addrs']), routes: arr(r.routes as TunSnapshot['routes']) }
  } catch { return undefined }
}

const ROUTES = `
$up=@(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $_.ifIndex })
@(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | ForEach-Object { [pscustomobject]@{ alias=$_.InterfaceAlias; nextHop=$_.NextHop; up=($up -contains $_.ifIndex) } }) | ConvertTo-Json -Compress
`
/** R4: read-only IPv4 default routes with the UP state of their interface; undefined when unreadable */
export async function defaultRoutes(): Promise<{ alias: string; nextHop: string; up: boolean }[] | undefined> {
  try {
    const r = await ps<unknown>(ROUTES, 10000)
    return arr(r as { alias: string; nextHop: string; up: boolean } | { alias: string; nextHop: string; up: boolean }[]).filter(x => x && typeof x.alias === 'string' && typeof x.nextHop === 'string')
  } catch { return undefined }
}
