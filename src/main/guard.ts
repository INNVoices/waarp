import type { Adapter, Notice, Profile } from '../shared/types'
import { arr, ps } from './ps'

const SCAN = `
$up = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' }
$full = @(Get-NetRoute -AddressFamily IPv4 | Where-Object { $_.DestinationPrefix -in '0.0.0.0/0','0.0.0.0/1','128.0.0.0/1' } | Select-Object -ExpandProperty ifIndex)
@($up | ForEach-Object { $i = $_.ifIndex; [pscustomobject]@{ name = $_.Name; desc = $_.InterfaceDescription; ipv4 = @(Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress); fullRoute = ($full -contains $i) -and ($_.InterfaceDescription -notmatch 'Realtek|Intel|Killer|Broadcom|Qualcomm|MediaTek|Marvell|Wi-?Fi|Ethernet Controller|Wireless') } }) | ConvertTo-Json -Depth 3 -Compress
`

export async function adapters(): Promise<Adapter[]> {
  const raw = await ps<Adapter | Adapter[]>(SCAN, 15000).catch(() => [] as Adapter[])
  return arr(raw).map(a => ({ ...a, ipv4: arr(a.ipv4) }))
}

const VPN_LIKE = /wintun|wireguard|amnezia|tap-windows|tap-|openvpn|tun2socks|mullvad|proton|nord|outline|hiddify|v2ray|xray|clash|sing-?box|warp|cloudflare|zerotier|tailscale|radmin|hamachi|wiresock|exitlag|nekoray|throne/i

export function conflicts(ps: Profile[], list: Adapter[], ownName = 'Waarp', allowVpnUnderlay = false): Notice[] {
  const out: Notice[] = []
  const mine = new Set(ps.flatMap(p => (p.kind === 'awg' ? p.address : []).map(a => a.split('/')[0])))
  for (const a of list) {
    if (a.name === ownName) continue
    const same = a.ipv4.find(ip => mine.has(ip))
    if (same) {
      out.push({ level: 'warn', title: 'Адрес туннеля уже используется', text: `Адрес ${same} найден у адаптера «${a.name}». Совпадение адреса не доказывает совпадение ключа, поэтому другие маршруты не блокируются. Этот профиль может не запуститься; для одновременной работы безопаснее отдельный конфиг.` })
      continue
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
