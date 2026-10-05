import type { Profile } from '../shared/types'
import { parseOpenVpn } from './openvpn'

/** VPN Gate CSV has a fixed 15-column format; the last column is a base64 embedded .ovpn profile. */
export function parseVpnGateCsv(text: string, max = 1000): Profile[] {
  const out: Profile[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('*') || line.startsWith('#')) continue
    const cols = line.split(',')
    if (cols.length < 15 || !cols[14]) continue
    try {
      const raw = Buffer.from(cols[14].trim(), 'base64').toString('utf8')
      const country = /^[A-Z]{2}$/.test(cols[6] ?? '') ? cols[6] : '??'
      const p = parseOpenVpn(raw, `${country} · ${cols[0] || cols[1] || 'VPN Gate'}`)
      p.source = 'public'
      out.push(p)
      if (out.length >= max) break
    } catch { /* malformed or unsupported public relay */ }
  }
  return out
}
