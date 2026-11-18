// WRP-017: links of the other popular protocols -> OutProfile (a ready sing-box outbound). VLESS keeps its own parser
// (vless.ts), AWG/WG keep awg.ts. parseAny() reads a whole list / subscription body of mixed links.
// Unknown or broken lines are counted, never guessed.
import type { OutProfile, Profile } from '../shared/types'
import { parseVless } from './vless'
import { looksLikeMasque, parseMasque } from './masque'

const rid = (): string => Math.random().toString(36).slice(2, 10)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const b64 = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
const port = (v: string | number | undefined): number => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('bad port'); return n }
const host = (v: string | undefined): string => { const h = (v ?? '').replace(/^\[|\]$/g, ''); if (!h || h.length > 253 || /[\s/]/.test(h)) throw new Error('bad host'); return h }
const nameOf = (u: URL, fb: string): string => { try { return decodeURIComponent(u.hash.slice(1)).trim().slice(0, 60) || fb } catch { return fb } }
const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

function tlsOf(q: URLSearchParams, h: string, on: boolean): Record<string, unknown> | undefined {
  if (!on) return undefined
  if (['allowInsecure', 'insecure'].some(k => ['1', 'true'].includes((q.get(k) ?? '').trim().toLowerCase()))) throw new Error('insecure TLS is not accepted')
  // These change certificate verification / the handshake. Dropping them can connect to a different peer
  // than the provider intended; they need an explicit mapper before they can be accepted.
  if (['pinSHA256', 'ech'].some(k => q.get(k))) throw new Error('unsupported TLS verification option')
  const fp = q.get('fp')
  if (fp && !['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', '360', 'qq', 'random', 'randomized'].includes(fp.toLowerCase())) throw new Error('unsupported TLS fingerprint')
  return clean({
    enabled: true,
    server_name: q.get('sni') || q.get('peer') || h,
    alpn: q.get('alpn') ? q.get('alpn')!.split(',') : undefined,
    utls: fp ? { enabled: true, fingerprint: fp.toLowerCase() } : undefined
  })
}

function transportOf(type: string | null, q: URLSearchParams): Record<string, unknown> | undefined {
  type = (type ?? '').trim().toLowerCase()
  if (q.get('headerType') && q.get('headerType') !== 'none') throw new Error('unsupported transport header')
  if (!type || type === 'tcp' || type === 'raw') return undefined
  if (type === 'ws') return clean({ type: 'ws', path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : undefined })
  if (type === 'grpc') return { type: 'grpc', service_name: q.get('serviceName') || q.get('path') || '' }
  if (type === 'http' || type === 'h2') return clean({ type: 'http', path: q.get('path') || '/', host: q.get('host') ? [q.get('host')] : undefined })
  if (type === 'httpupgrade') return clean({ type: 'httpupgrade', path: q.get('path') || '/', host: q.get('host') || undefined })
  throw new Error('unsupported transport')
}

const mk = (name: string, version: string, h: string, p: number, outbound: Record<string, unknown>): OutProfile =>
  ({ kind: 'out', id: rid(), name, version, host: h, port: p, outbound, addedAt: Date.now(), source: 'personal' })

/** Extract supported share links from JSON/YAML/text containers without executing their format. */
export function linksInContainer(text: string, max = 128): string[] {
  // A native node export must pass its strict whole-document validator, even when a field contains a share link.
  if (looksLikeMasque(text)) return []
  const normalized = text.replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
  const matches = normalized.match(/(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\/[^\s"'<>\\]+/gi) ?? []
  return [...new Set(matches)].slice(0, Math.max(0, Math.min(max, 1000)))
}

function vmess(raw: string): OutProfile {
  const j = JSON.parse(b64(raw.slice(8)))
  if (!j || typeof j !== 'object' || Array.isArray(j) || !UUID.test(String(j.id ?? ''))) throw new Error('bad vmess credential')
  const h = host(j.add), p = port(j.port)
  const q = new URLSearchParams({ path: j.path ?? '', host: j.host ?? '', serviceName: j.path ?? '', sni: j.sni ?? '',
    headerType: j.type ?? 'none', fp: j.fp ?? '', alpn: j.alpn ?? '', allowInsecure: String(j.allowInsecure ?? ''), insecure: String(j.insecure ?? ''),
    pinSHA256: j.pinSHA256 ?? '', ech: j.ech ?? '' })
  const security = String(j.tls ?? '').toLowerCase()
  if (!['', 'none', 'tls'].includes(security)) throw new Error('unsupported VMess TLS security')
  const tls = security === 'tls'
  const alterId = Number(j.aid ?? 0)
  if (!Number.isInteger(alterId) || alterId < 0 || alterId > 65535) throw new Error('bad VMess alterId')
  const cipher = j.scy || 'auto'
  if (!['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305', 'aes-128-ctr'].includes(cipher)) throw new Error('unsupported VMess cipher')
  const net = j.net && j.net !== 'tcp' ? ' · ' + String(j.net).toUpperCase() : ''
  return mk(String(j.ps || h).slice(0, 60), 'VMess' + (tls ? ' · TLS' : '') + net, h, p,
    clean({ type: 'vmess', server: h, server_port: p, uuid: String(j.id), security: cipher, alter_id: alterId, tls: tlsOf(q, h, tls), transport: transportOf(j.net, q) }))
}

function trojan(raw: string): OutProfile {
  const u = new URL(raw); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  if (!u.username) throw new Error('no password')
  if (u.password) throw new Error('Trojan password must be percent-encoded')
  if (q.get('security') && q.get('security')!.toLowerCase() !== 'tls') throw new Error('unsupported Trojan security')
  if (q.get('flow')) throw new Error('unsupported Trojan flow')
  const ty = q.get('type'); const net = ty && ty !== 'tcp' ? ' · ' + ty.toUpperCase() : ''
  return mk(nameOf(u, h), 'Trojan · TLS' + net, h, p,
    clean({ type: 'trojan', server: h, server_port: p, password: decodeURIComponent(u.username), tls: tlsOf(q, h, true), transport: transportOf(ty, q) }))
}

function ss(raw: string): OutProfile {
  // ss://base64(method:password)@host:port#name   or   ss://base64(method:password@host:port)#name   (SIP002 / legacy)
  const body = raw.slice(5); const hashAt = body.indexOf('#')
  const main = hashAt >= 0 ? body.slice(0, hashAt) : body; const frag = hashAt >= 0 ? body.slice(hashAt + 1) : ''
  if (main.includes('?') && new URLSearchParams(main.slice(main.indexOf('?') + 1)).has('plugin')) throw new Error('Shadowsocks plugins are not supported')
  let method = '', password = '', h = '', p = 0
  if (main.includes('@')) {
    const at = main.lastIndexOf('@'); const cred = main.slice(0, at); const hp = main.slice(at + 1).split('?')[0].split('/')[0]
    const dec = cred.includes(':') ? decodeURIComponent(cred) : b64(cred)
    if (dec.indexOf(':') < 1) throw new Error('bad Shadowsocks credential')
    method = dec.slice(0, dec.indexOf(':')); password = dec.slice(dec.indexOf(':') + 1)
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(hp); if (!m) throw new Error('bad ss'); h = host(m[1]); p = port(m[2])
  } else {
    const dec = b64(main.split('?')[0]); const m = /^([^:]+):(.*)@\[?([^\]]+?)\]?:(\d+)$/.exec(dec); if (!m) throw new Error('bad ss')
    method = m[1]; password = m[2]; h = host(m[3]); p = port(m[4])
  }
  if (!method || !password) throw new Error('no method')
  let name = h; try { name = decodeURIComponent(frag).trim().slice(0, 60) || h } catch { /* keep host */ }
  return mk(name, 'Shadowsocks · ' + method, h, p, { type: 'shadowsocks', server: h, server_port: p, method, password })
}

/** Hysteria2 URI port part may be a list / range (official multi-port form); new URL cannot parse that */
export function hy2Ports(raw: string): { url: string; ports?: string[] } {
  const m = /^([a-z0-9]+:\/\/[^@/?#]*@)(\[[^\]]+\]|[^:/?#]+):([0-9,-]+)([/?#].*)?$/i.exec(raw)
  if (!m || /^\d+$/.test(m[3])) return { url: raw }
  const parts = m[3].split(',')
  const ports = parts.map(x => {
    const r = /^(\d+)(?:-(\d+))?$/.exec(x)
    if (!r) throw new Error('bad hysteria2 port list')
    const a = Number(r[1]), b = Number(r[2] ?? r[1])
    if (!a || !b || a > 65535 || b > 65535 || a > b) throw new Error('bad hysteria2 port range')
    return `${a}:${b}`
  })
  if (!ports.length || ports.length > 32) throw new Error('bad hysteria2 port list')
  return { url: m[1] + m[2] + ':' + ports[0].split(':')[0] + (m[4] ?? ''), ports }
}

function hy2(input: string): OutProfile {
  const norm = input.replace(/^hy2:/i, 'hysteria2:')
  const hop = hy2Ports(norm)
  const raw = hop.url
  const u = new URL(raw); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  // Hysteria userpass is a single auth string, unlike URI protocols with separate user/password fields.
  const password = decodeURIComponent(/^[a-z0-9]+:\/\/([^/?#]*)@/i.exec(raw)?.[1] ?? '')
  if (!password) throw new Error('no hysteria2 password')
  if (q.get('obfs') && (q.get('obfs') !== 'salamander' || !q.get('obfs-password'))) throw new Error('unsupported or incomplete Hysteria2 obfuscation')
  return mk(nameOf(u, h), 'Hysteria2', h, p, clean({
    type: 'hysteria2', server: h, server_port: p, password,
    ...(hop.ports ? { server_ports: hop.ports, hop_interval: '30s' } : {}),
    obfs: q.get('obfs') ? { type: q.get('obfs'), password: q.get('obfs-password') ?? '' } : undefined, tls: tlsOf(q, h, true)
  }))
}

function tuic(raw: string): OutProfile {
  const u = new URL(raw); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  const uuid = decodeURIComponent(u.username), password = decodeURIComponent(u.password || '')
  if (!UUID.test(uuid) || !password) throw new Error('bad tuic credential')
  if (q.get('congestion_control') && !['cubic', 'new_reno', 'bbr'].includes(q.get('congestion_control')!)) throw new Error('unsupported TUIC congestion control')
  return mk(nameOf(u, h), 'TUIC v5', h, p, clean({
    type: 'tuic', server: h, server_port: p, uuid, password,
    congestion_control: q.get('congestion_control') || 'bbr', tls: { ...tlsOf(q, h, true), alpn: (q.get('alpn') || 'h3').split(',') }
  }))
}

/** one link of any supported protocol, or null (not a link we know) */
export function parseLink(line: string): Profile | null {
  const t = line.trim()
  const scheme = /^([a-z0-9]+):\/\//i.exec(t)?.[1]?.toLowerCase()
  if (!scheme) return null
  if (scheme === 'vless') return parseVless(t)
  if (scheme === 'vmess') return vmess(t)
  if (scheme === 'trojan') return trojan(t)
  if (scheme === 'ss') return ss(t)
  if (scheme === 'hysteria2' || scheme === 'hy2') return hy2(t)
  if (scheme === 'tuic') return tuic(t)
  return null
}

/** a list / subscription body (plain lines or base64) of mixed links */
export function parseAny(text: string, max = 5000): { items: Profile[]; skipped: number } {
  let body = (text ?? '').trim()
  const masque = parseMasque(body, Number.isFinite(max) ? max : 0)
  if (masque) return masque
  if (!/:\/\//.test(body)) { try { const d = b64(body.replace(/\s+/g, '')); if (/:\/\//.test(d)) body = d } catch { /* not base64 */ } }
  const lines = body.split(/\r?\n/)
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
  const items: Profile[] = []; let skipped = lines.slice(limit).filter(line => line.trim()).length
  for (const line of lines.slice(0, limit)) {
    if (!line.trim()) continue
    try { const p = parseLink(line); if (p) items.push(p); else skipped++ } catch { skipped++ }
  }
  return { items, skipped }
}

/** secrets inside an OutProfile, for log redaction */
export function outSecrets(p: OutProfile): string[] {
  const secrets: string[] = []
  const walk = (value: unknown, key = '') => {
    if (typeof value === 'string' && /^(?:uuid|password|private_key|uri)$/.test(key) && value.length > 3) secrets.push(value)
    else if (Array.isArray(value)) value.forEach(x => walk(x, key))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k)
  }
  walk(p.outbound)
  return [...new Set(secrets)]
}
