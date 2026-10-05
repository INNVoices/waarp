import { parseConf } from './awg'
import { createHmac, randomBytes } from 'node:crypto'
import { isSubscriptionUrl } from './vless'
import { linksInContainer, parseAny } from './links'
import { looksLikeOpenVpn, parseOpenVpn } from './openvpn'

export type ClipKind = 'awg' | 'openvpn' | 'vless' | 'sub' | 'other' | 'none'
/** what the clipboard holds, for a preview: a name, a host and a protocol; never a key, uuid or token */
export interface ClipPeek { kind: ClipKind; name?: string; host?: string; version?: string; count?: number; fingerprint?: string }

const MAX = 200_000
const FINGERPRINT_KEY = randomBytes(32)

export function peekClip(text: string): ClipPeek {
  const t = (text ?? '').trim()
  if (!t || t.length > MAX) return { kind: 'none' }
  // Per-process HMAC is enough to debounce the same clipboard value without exposing a stable hash of credentials.
  const fingerprint = createHmac('sha256', FINGERPRINT_KEY).update(t).digest('hex').slice(0, 16)
  if (looksLikeOpenVpn(t)) {
    try { const p = parseOpenVpn(t); return { kind: 'openvpn', name: p.name, host: p.host, version: p.version, fingerprint } }
    catch { return { kind: 'none' } }
  }
  if (/\[Interface\]/i.test(t) || /^vpn:\/\//i.test(t)) {
    try {
      const p = parseConf(t)
      return { kind: 'awg', name: p.name, host: p.peer.host, version: p.version, fingerprint }
    } catch { return { kind: 'none' } }
  }
  if (isSubscriptionUrl(t)) {
    try { return { kind: 'sub', host: new URL(t).host, fingerprint } } catch { return { kind: 'none' } }
  }
  {
    const embedded = linksInContainer(t, 20)
    const result = parseAny(embedded.length ? embedded.join('\n') : t, 20)
    if (result.items.length) {
      const first = result.items[0]
      const host = first.kind === 'vless' ? first.vless.server : first.kind === 'awg' ? first.peer.host : first.host
      return { kind: first.kind === 'vless' ? 'vless' : 'other', name: first.name, host, version: first.version, count: result.items.length, fingerprint }
    }
  }
  return { kind: 'none' }
}
