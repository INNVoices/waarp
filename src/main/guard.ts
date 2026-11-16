import type { Adapter, Notice, Profile } from '../shared/types'
import { isIPv4 } from 'node:net'
import { ps } from './ps'

const SCAN = `
$ErrorActionPreference='Stop'
$up = @(Get-NetAdapter -IncludeHidden | Where-Object { $_.Status -eq 'Up' })
$ips = @(Get-NetIPAddress | Where-Object { $_.AddressFamily -eq 'IPv4' })
$routes = @(Get-NetRoute | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','0.0.0.0/1','128.0.0.0/1','::/0','::/1','8000::/1' })
$items = @($up | ForEach-Object {
  $i=$_.ifIndex
  $prefixes=@($routes | Where-Object { $_.ifIndex -eq $i } | Select-Object -ExpandProperty DestinationPrefix)
  [pscustomobject]@{name=[string]$_.Name;desc=[string]$_.InterfaceDescription;ipv4=@($ips | Where-Object { $_.InterfaceIndex -eq $i } | Select-Object -ExpandProperty IPAddress);prefixes=$prefixes}
})
[pscustomobject]@{ok=1;adapters=$items}|ConvertTo-Json -Depth 4 -Compress
`

/** A single split /1 covers half an address family, not a full default route. */
export function hasFullDefaultRoute(prefixes: readonly string[]): boolean {
  const p = new Set(prefixes.map(prefix => prefix.toLowerCase()))
  return p.has('0.0.0.0/0') || (p.has('0.0.0.0/1') && p.has('128.0.0.0/1')) ||
    p.has('::/0') || (p.has('::/1') && p.has('8000::/1'))
}

/** A failed/partial OS read must never be presented to callers as an empty conflict-free machine. */
export function parseAdapterSnapshot(raw: unknown): Adapter[] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as { ok?: unknown; adapters?: unknown }
  if (r.ok !== 1 || !Array.isArray(r.adapters)) return undefined
  const out: Adapter[] = []
  for (const item of r.adapters) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const a = item as Partial<Adapter> & { prefixes?: unknown }
    if (typeof a.name !== 'string' || !a.name.trim() || typeof a.desc !== 'string' ||
        !Array.isArray(a.ipv4) || !a.ipv4.every(ip => typeof ip === 'string' && isIPv4(ip)) ||
        !Array.isArray(a.prefixes) || !a.prefixes.every(prefix => typeof prefix === 'string')) return undefined
    out.push({ name: a.name, desc: a.desc, ipv4: [...a.ipv4], fullRoute: hasFullDefaultRoute(a.prefixes) })
  }
  return out
}

export async function adapters(read: () => Promise<unknown> = () => ps(SCAN, 15000)): Promise<Adapter[]> {
  try {
    const list = parseAdapterSnapshot(await read())
    if (list) return list
  } catch { /* preserve an unknown state instead of silently admitting a new tunnel */ }
  throw new Error('Не удалось проверить сетевые адаптеры и маршруты Windows. Повтори попытку')
}

/** Inspection failure blocks a new start but does not tear down an already working tunnel. */
export function adapterInspectionNotice(running: boolean): Notice {
  return {
    level: running ? 'warn' : 'block',
    title: 'Не удалось проверить сеть Windows',
    text: running
      ? 'Последняя проверка адаптеров и маршрутов не завершилась. Текущее подключение сохранено; следующая проверка повторится автоматически.'
      : 'Windows не вернула полные данные об адаптерах и маршрутах. Новый туннель пока не запущен. Повтори попытку.'
  }
}

const VPN_LIKE = /wintun|wireguard|amnezia|tap-windows|tap-|openvpn|tun2socks|mullvad|proton|nord|outline|hiddify|v2ray|xray|clash|sing-?box|warp|cloudflare|zerotier|tailscale|radmin|hamachi|wiresock|exitlag|nekoray|throne/i

export function conflicts(ps: Profile[], list: Adapter[], ownName = 'Waarp', allowVpnUnderlay = false): Notice[] {
  const out: Notice[] = []
  const mine = new Set(ps.flatMap(p => (p.kind === 'awg' ? p.address : []).map(a => a.split('/')[0])))
  for (const a of list) {
    if (a.name.toLowerCase() === ownName.toLowerCase()) continue
    const same = a.ipv4.find(ip => mine.has(ip))
    if (same) {
      out.push({ level: 'warn', title: 'Адрес туннеля уже используется', text: `Адрес ${same} найден у адаптера «${a.name}». Совпадение адреса не доказывает совпадение ключа. Этот профиль может не запуститься; для одновременной работы безопаснее отдельный конфиг.` })
    }
    if (VPN_LIKE.test(a.desc) || VPN_LIKE.test(a.name)) {
      out.push(a.fullRoute
        ? allowVpnUnderlay
          ? { level: 'warn', title: `Внешний VPN: ${a.name}`, text: 'Waarp направит только выбранные карточки через их сервер поверх текущего VPN. Текущий VPN и его настройки не изменяются.' }
          : { level: 'block', title: `Включён другой VPN: ${a.name}`, text: 'У этого адаптера найден полный маршрут. Совместимость маршрутов и DNS пока не подтверждена, поэтому Waarp не запускает второй системный туннель.' }
        : { level: 'info', title: `Рядом работает ${a.name}`, text: 'Полный маршрут не найден. Это не доказывает совместимость DNS и отдельных маршрутов; проверь их перед совместной работой.' })
    }
  }
  return out
}
