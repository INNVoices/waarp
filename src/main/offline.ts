// Checks that work while the tunnel is off (owner 03.10: "работать должно независимо, просто информировать"):
// - direct site probe over the normal network (whatever routes the PC has, e.g. another VPN);
// - ICMP ping to each server's host and to a public resolver, so the analyzer is alive before the tunnel opens.
// Through-server probes still need the tunnel (sing-box outbounds); the UI says so.
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const PING = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'PING.EXE')

/** one ICMP echo, ms or undefined (host unreachable / filtered / bad name) */
export function icmp(host: string, timeoutMs = 1500): Promise<number | undefined> {
  if (!/^[a-z0-9.:-]{1,253}$/i.test(host)) return Promise.resolve(undefined)
  return new Promise(resolve => {
    execFile(PING, ['-n', '1', '-w', String(timeoutMs), host], { windowsHide: true, timeout: timeoutMs + 2000 }, (_e, out) => {
      // localized output (RU console codepage garbles "мс"): take the number right before TTL=, which every locale keeps
      const m = /[=<](\d+)\D{0,6}\s+TTL=/i.exec(String(out ?? ''))
      resolve(m ? Math.max(1, Number(m[1])) : undefined)
    })
  })
}

/** direct HTTPS reachability of a site: ms to the first response, null when it fails or times out */
export async function directProbe(target: string, timeoutMs = 6000): Promise<number | null> {
  const url = /^https?:\/\//.test(target) ? target : 'https://' + target
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ac.signal })
    return Date.now() - t0
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
