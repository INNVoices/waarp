// W3.3b network fingerprint for per-network memory. Reads the default gateway's MAC (and the Wi-Fi SSID when there
// is one) locally, read-only, and returns only a salted hash. No stable gateway identity -> undefined, and the
// caller then keeps no memory for this network (never a shared "unknown" bucket). Raw values never leave this file.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const run = (cmd: string, args: string[]): Promise<string> => new Promise(res =>
  execFile(cmd, args, { windowsHide: true, timeout: 4000 }, (err, out) => res(err ? '' : String(out))))

/** pure: a stable gateway MAC is required; SSID only narrows it */
export function fingerprintFrom(gwMac: string | undefined, ssid: string | undefined, salt: string): string | undefined {
  const mac = (gwMac ?? '').trim().toLowerCase().replace(/-/g, ':')
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return undefined
  return createHash('sha256').update(salt + '|' + mac + '|' + (ssid ?? '').trim()).digest('hex').slice(0, 32)
}

export async function networkFingerprint(salt: string): Promise<string | undefined> {
  // the physical default route (a real next hop), not a tunnel's on-link route
  const ps = `$r = Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric | Select-Object -First 1; if ($r) { (Get-NetNeighbor -IPAddress $r.NextHop -ErrorAction SilentlyContinue | Select-Object -First 1).LinkLayerAddress }`
  const mac = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])).trim()
  const wlan = await run('netsh', ['wlan', 'show', 'interfaces'])
  const ssid = /^\s*SSID\s*:\s*(.+)$/m.exec(wlan)?.[1]
  return fingerprintFrom(mac, ssid, salt)
}
