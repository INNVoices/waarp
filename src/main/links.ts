// WRP-017: links of the other popular protocols -> OutProfile (a ready sing-box outbound). VLESS keeps its own parser
// (vless.ts), AWG/WG keep awg.ts. parseAny() reads a whole list / subscription body of mixed links.
// Unknown or broken lines are counted, never guessed.
import type { OutProfile, Profile } from '../shared/types'
import { parseVless } from './vless'

const rid = (): string => Math.random().toString(36).slice(2, 10)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const b64 = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
const port = (v: string | number | undefined): number => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('bad port'); return n }
const host = (v: string | undefined): string => { const h = (v ?? '').replace(/^\[|\]$/g, ''); if (!h || h.length > 253 || /[\s/]/.test(h)) throw new Error('bad host'); return h }
const nameOf = (u: URL, fb: string): string => { try { return decodeURIComponent(u.hash.slice(1)).trim().slice(0, 60) || fb } catch { return fb } }
const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

function tlsOf(q: URLSearchParams, h: string, on: boolean): Record<string, unknown> | undefined {
  if (!on) return undefined
  if (['1', 'true'].includes((q.get('allowInsecure') || q.get('insecure') || '').toLowerCase())) throw new Error('insecure TLS is not accepted')
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
  if (type === 'ws') return clean({ type: 'ws', path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : undefined })
  if (type === 'grpc') return { type: 'grpc', service_name: q.get('serviceName') || q.get('path') || '' }
  if (type === 'http' || type === 'h2') return clean({ type: 'http', path: q.get('path') || '/', host: q.get('host') ? [q.get('host')] : undefined })
  return undefined
}

const mk = (name: string, version: string, h: string, p: number, outbound: Record<string, unknown>): OutProfile =>
  ({ kind: 'out', id: rid(), name, version, host: h, port: p, outbound, addedAt: Date.now(), source: 'personal' })

/** Extract supported share links from JSON/YAML/text containers without executing their format. */
export function linksInContainer(text: string, max = 128): string[] {
  const normalized = text.replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
  const matches = normalized.match(/(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic):\/\/[^\s"'<>\\]+/gi) ?? []
  return [...new Set(matches)].slice(0, Math.max(0, Math.min(max, 1000)))
}

function vmess(raw: string): OutProfile {
  const j = JSON.parse(b64(raw.slice(8)))
  if (!j || typeof j !== 'object' || Array.isArray(j) || !UUID.test(String(j.id ?? ''))) throw new Error('bad vmess credential')
  const h = host(j.add), p = port(j.port)
  const q = new URLSearchParams({ path: j.path ?? '', host: j.host ?? '', serviceName: j.path ?? '', sni: j.sni ?? '' })
  const tls = j.tls === 'tls'
  const net = j.net && j.net !== 'tcp' ? ' · ' + String(j.net).toUpperCase() : ''
  return mk(String(j.ps || h).slice(0, 60), 'VMess' + (tls ? ' · TLS' : '') + net, h, p,
    clean({ type: 'vmess', server: h, server_port: p, uuid: String(j.id), security: j.scy || 'auto', alter_id: Number(j.aid) || 0, tls: tlsOf(q, h, tls), transport: transportOf(j.net, q) }))
}

function trojan(raw: string): OutProfile {
  const u = new URL(raw); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  if (!u.username) throw new Error('no password')
  const ty = q.get('type'); const net = ty && ty !== 'tcp' ? ' · ' + ty.toUpperCase() : ''
  return mk(nameOf(u, h), 'Trojan · TLS' + net, h, p,
    clean({ type: 'trojan', server: h, server_port: p, password: decodeURIComponent(u.username), tls: tlsOf(q, h, true), transport: transportOf(ty, q) }))
}

function ss(raw: string): OutProfile {
  // ss://base64(method:password)@host:port#name   or   ss://base64(method:password@host:port)#name   (SIP002 / legacy)
  const body = raw.slice(5); const hashAt = body.indexOf('#')
  const main = hashAt >= 0 ? body.slice(0, hashAt) : body; const frag = hashAt >= 0 ? body.slice(hashAt + 1) : ''
  if (/(?:\?|&)plugin=/i.test(main)) throw new Error('Shadowsocks plugins are not supported')
  let method = '', password = '', h = '', p = 0
  if (main.includes('@')) {
    const at = main.lastIndexOf('@'); const cred = main.slice(0, at); const hp = main.slice(at + 1).split('?')[0].split('/')[0]
    const dec = cred.includes(':') ? decodeURIComponent(cred) : b64(cred)
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

function hy2(raw: string): OutProfile {
  const u = new URL(raw.replace(/^hy2:/i, 'hysteria2:')); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  const password = decodeURIComponent(u.username || u.password || '')
  if (!password) throw new Error('no hysteria2 password')
  return mk(nameOf(u, h), 'Hysteria2', h, p, clean({
    type: 'hysteria2', server: h, server_port: p, password,
    obfs: q.get('obfs') ? { type: q.get('obfs'), password: q.get('obfs-password') ?? '' } : undefined, tls: tlsOf(q, h, true)
  }))
}

function tuic(raw: string): OutProfile {
  const u = new URL(raw); const h = host(u.hostname), p = port(u.port || 443), q = u.searchParams
  const uuid = decodeURIComponent(u.username), password = decodeURIComponent(u.password || '')
  if (!UUID.test(uuid) || !password) throw new Error('bad tuic credential')
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
  if (!/:\/\//.test(body)) { try { const d = b64(body.replace(/\s+/g, '')); if (/:\/\//.test(d)) body = d } catch { /* not base64 */ } }
  const items: Profile[] = []; let skipped = 0
  for (const line of body.split(/\r?\n/).slice(0, max)) {
    if (!line.trim()) continue
    try { const p = parseLink(line); if (p) items.push(p); else skipped++ } catch { skipped++ }
  }
  return { items, skipped }
}

/** secrets inside an OutProfile, for log redaction */
export function outSecrets(p: OutProfile): string[] {
  const o = p.outbound
  return ['uuid', 'password'].map(k => o[k]).filter((v): v is string => typeof v === 'string' && v.length > 3)
}
