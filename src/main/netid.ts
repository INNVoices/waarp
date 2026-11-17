// W3.3b network fingerprint for per-network memory. Reads the default gateway's MAC (and the Wi-Fi SSID when there
// is one) locally, read-only, and returns only a salted hash. No stable gateway identity -> undefined, and the
// caller then keeps no memory for this network (never a shared "unknown" bucket). Raw values never leave this file.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const run = (cmd: string, args: string[], signal?: AbortSignal): Promise<string> => new Promise(res => {
  if (signal?.aborted) { res(''); return }
  execFile(cmd, args, { windowsHide: true, timeout: 4000, signal }, (err, out) => res(err ? '' : String(out)))
})

/** pure: a stable gateway MAC is required; SSID only narrows it */
export function fingerprintFrom(gwMac: string | undefined, ssid: string | undefined, salt: string): string | undefined {
  const mac = (gwMac ?? '').trim().toLowerCase().replace(/-/g, ':')
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return undefined
  return createHash('sha256').update(salt + '|' + mac + '|' + (ssid ?? '').trim()).digest('hex').slice(0, 32)
}

// Windows chooses by route + interface metric. Read the documented interface property, then bind ARP to that NIC.
// https://learn.microsoft.com/en-us/windows-server/networking/technologies/network-subsystem/net-sub-interface-metric
export const GATEWAY_MAC_PS = `
try {
  $interfaces = @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop)
  $ranked = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { $_.NextHop -ne '0.0.0.0' } | ForEach-Object {
    $route = $_
    $nic = @($interfaces | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex })
    if ($nic.Count -ne 1 -or $null -eq $route.RouteMetric -or $null -eq $nic[0].InterfaceMetric) { throw 'Unknown route metric' }
    [pscustomobject]@{ InterfaceIndex = $route.InterfaceIndex; NextHop = $route.NextHop; Metric = [long]$route.RouteMetric + [long]$nic[0].InterfaceMetric }
  })
  $best = @($ranked | Sort-Object Metric)
  if ($best.Count -eq 0) { return }
  $ties = @($best | Where-Object { $_.Metric -eq $best[0].Metric } | Select-Object InterfaceIndex, NextHop -Unique)
  if ($ties.Count -ne 1) { return }
  (Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex $best[0].InterfaceIndex -IPAddress $best[0].NextHop -PolicyStore ActiveStore -ErrorAction Stop).LinkLayerAddress
} catch { }
`.trim()

export async function networkFingerprint(salt: string, signal?: AbortSignal): Promise<string | undefined> {
  // the physical default route (a real next hop), not a tunnel's on-link route
  const mac = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GATEWAY_MAC_PS], signal)).trim()
  const wlan = await run('netsh', ['wlan', 'show', 'interfaces'], signal)
  if (signal?.aborted) return undefined
  const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(wlan)?.[1]
  return fingerprintFrom(mac, ssid, salt)
}
