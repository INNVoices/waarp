import { localized } from '../shared/localization'
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import type { OutProfile } from '../shared/types'
import { ConfError } from './conf-error'

// Exact shared subset of desktop 1.14.2-lx.11 and Android f1bac271 option/masque_lx.go.
// Accept node exports only: a runtime config cannot install listeners, detours or file references.
const NODE_KEYS = new Set(['type', 'tag', 'server', 'server_port', 'profile', 'vhttp', 'private_key', 'public_key',
  'ip', 'ipv6', 'uri', 'mtu', 'tls', 'idle_timeout', 'keep_alive_period', 'network_list', 'udp_fragment'])
const TLS_KEYS = new Set(['enabled', 'server_name', 'disable_sni', 'insecure', 'fragment', 'record_fragment', 'fragment_fallback_delay'])
function fail(message: string): never { throw new ConfError('MASQUE: ' + message) }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: Set<string>) => {
  if (Object.keys(v).some(k => !allowed.has(k))) fail(localized("winInline.masque.b3b513fad30d"))
}
const text = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || !v || v.length > max || /[\x00-\x1f\x7f]/.test(v)) fail(localized("winInline.masque.128e9720f3bb"))
  return v
}
const integer = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(localized("winInline.masque.0459303fb387"))
  return v
}
function hostname(v: unknown): string {
  const value = text(v, 253).replace(/^\[|\]$/g, '')
  if (isIP(value)) return value
  const ascii = domainToASCII(value.replace(/\.$/, '')).toLowerCase()
  if (!ascii || /^[0-9.]+$/.test(ascii) || !ascii.split('.').every(s => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) fail(localized("winInline.masque.b8f2996a2a11"))
  return ascii
}
function prefix(v: unknown, family: 4 | 6): string {
  const raw = text(v, 64), parts = raw.split('/'), max = family === 4 ? 32 : 128
  if (parts.length > 2 || isIP(parts[0]) !== family || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) fail(localized("winInline.masque.0ace143b7fc4"))
  const bits = parts[1] === undefined ? max : Number(parts[1])
  if (bits < 0 || bits > max) fail(localized("winInline.masque.c1c195f3f130"))
  return `${parts[0]}/${bits}`
}
function key(v: unknown, privateKey: boolean): string {
  const value = text(v)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(localized("winInline.masque.217519329e69"))
  const der = Buffer.from(value, 'base64')
  try {
    // Enforce one DER sequence without trailing bytes; SEC1 is INTEGER 1 + OCTET STRING,
    // while PKCS8 starts INTEGER 0 + an algorithm sequence. An optional SEC1 public part is legal.
    if (der[0] !== 0x30) fail(localized("winInline.masque.9ebad9954474"))
    let offset = 2, length = der[1]
    if (length & 0x80) {
      const count = length & 0x7f
      if (count < 1 || count > 2 || der[2] === 0) fail(localized("winInline.masque.e264af3e4188"))
      length = 0
      for (let i = 0; i < count; i++) length = length * 256 + der[offset++]
      if (length < 128) fail(localized("winInline.masque.e264af3e4188"))
    }
    if (offset + length !== der.length || (privateKey && (der[offset] !== 2 || der[offset + 1] !== 1 || der[offset + 2] !== 1 || der[offset + 3] !== 4))) fail(localized("winInline.masque.7ae98c54b4cc"))
    const parsed = privateKey ? createPrivateKey({ key: der, format: 'der', type: 'sec1' }) : createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (parsed.asymmetricKeyType !== 'ec' || !['prime256v1', 'secp384r1', 'secp521r1'].includes(parsed.asymmetricKeyDetails?.namedCurve ?? '')) fail(localized("winInline.masque.00cf5bce7828"))
    // Native uses SEC1 for private keys, SPKI for public keys. Reject trailing DER and PKCS8 aliases.
    if (!privateKey && !Buffer.from(parsed.export({ format: 'der', type: 'spki' })).equals(der)) fail(localized("winInline.masque.26b55cccb19f"))
  } catch { fail(privateKey ? localized("winInline.masque.39e8efade503") : localized("winInline.masque.89923a3f8f6e")) }
  return value
}
function duration(v: unknown, negative = false): string {
  const value = text(v, 16)
  if (value === '0' || (negative && value === '-1s')) return value
  const m = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!m || Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]] ?? 0) > 86400) fail(localized("winInline.masque.ea202735f6e8"))
  return value
}

export function masqueNode(raw: unknown): OutProfile {
  if (!object(raw) || raw.type !== 'masque') fail(localized("winInline.masque.678ded44bea5"))
  keys(raw, NODE_KEYS)
  const server = hostname(raw.server), serverPort = raw.server_port === undefined ? 443 : integer(raw.server_port, 1, 65535)
  const profile = raw.profile === undefined ? 'cloudflare' : text(raw.profile, 20)
  if (!['cloudflare', 'standard'].includes(profile)) fail(localized("winInline.masque.f9a130ef8ae6"))
  const vhttp = raw.vhttp === undefined ? (profile === 'standard' ? 'h3' : 'auto') : text(raw.vhttp, 8)
  if (!['auto', 'h2', 'h3'].includes(vhttp) || (profile === 'standard' && vhttp !== 'h3')) fail(localized("winInline.masque.8b7059c463eb"))
  const ip = raw.ip === undefined ? undefined : prefix(raw.ip, 4), ipv6 = raw.ipv6 === undefined ? undefined : prefix(raw.ipv6, 6)
  if (!ip && !ipv6) fail(localized("winInline.masque.4b1bc0244551"))
  if (profile === 'cloudflare' && (!raw.private_key || !raw.public_key)) fail(localized("winInline.masque.a5cbc8e21ba7"))
  const out: Record<string, unknown> = { type: 'masque', server, server_port: serverPort, profile, vhttp }
  for (const field of ['private_key', 'public_key'] as const) if (raw[field] !== undefined) out[field] = key(raw[field], field === 'private_key')
  if (ip) out.ip = ip
  if (ipv6) out.ipv6 = ipv6
  if (raw.uri !== undefined) {
    const uri = text(raw.uri), u = (() => { try { return new URL(uri) } catch { return fail(localized("winInline.masque.506bcd98968d")) } })()
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail(localized("winInline.masque.6b80458740cb"))
    out.uri = uri
  } else if (profile === 'standard') fail(localized("winInline.masque.3f56345587d7"))
  out.mtu = raw.mtu === undefined ? 1280 : integer(raw.mtu, ipv6 ? 1280 : 576, 9000)
  const tls = raw.tls === undefined ? {} : raw.tls
  if (!object(tls)) fail(localized("winInline.masque.2c39d1d2e824"))
  keys(tls, TLS_KEYS)
  if (tls.enabled !== undefined && tls.enabled !== true) fail(localized("winInline.masque.f2b58cedd6cb"))
  if (tls.insecure !== undefined && tls.insecure !== false) fail(localized("winInline.masque.9ae7be376361"))
  const safeTLS: Record<string, unknown> = { enabled: true }
  for (const field of ['disable_sni', 'fragment', 'record_fragment'] as const) if (tls[field] !== undefined) {
    if (typeof tls[field] !== 'boolean') fail(localized("winInline.masque.66c8cc0cfff0"))
    if (field !== 'disable_sni' && tls[field] && vhttp === 'h3') fail(localized("winInline.masque.d87cb2a6b102"))
    safeTLS[field] = tls[field]
  }
  if (tls.server_name !== undefined) safeTLS.server_name = hostname(tls.server_name)
  if (tls.fragment_fallback_delay !== undefined) safeTLS.fragment_fallback_delay = duration(tls.fragment_fallback_delay)
  out.tls = safeTLS
  for (const field of ['idle_timeout', 'keep_alive_period'] as const) if (raw[field] !== undefined) out[field] = duration(raw[field], field === 'keep_alive_period')
  if (raw.udp_fragment !== undefined) {
    if (typeof raw.udp_fragment !== 'boolean') fail(localized("winInline.masque.41140e8cee3f"))
    out.udp_fragment = raw.udp_fragment
  }
  if (raw.network_list !== undefined) {
    const list = typeof raw.network_list === 'string' ? [raw.network_list] : raw.network_list
    if (!Array.isArray(list) || !list.length || list.length > 2 || list.some(v => !['tcp', 'udp'].includes(v)) || new Set(list).size !== list.length) fail(localized("winInline.masque.f9af03819dcc"))
    out.network_list = list
  }
  const name = typeof raw.tag === 'string' ? raw.tag.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 60) : ''
  return { kind: 'out', id: randomBytes(6).toString('hex'), name: name || `MASQUE ${server}`.slice(0, 80), version: `MASQUE · ${profile === 'cloudflare' ? 'WARP' : 'CONNECT-IP'} · ${vhttp.toUpperCase()}`,
    host: server, port: serverPort, outbound: out, addedAt: Date.now(), source: 'personal' }
}

export function looksLikeMasque(text: string): boolean {
  return /^\s*[\[{]/.test(text) && /"type"\s*:\s*"masque"/.test(text)
}

/** A single outbound, its array, or the exact {outbounds:[...]} export envelope. */
export function parseMasque(text: string, limit: number): { items: OutProfile[]; skipped: number } | undefined {
  if (!looksLikeMasque(text)) return undefined
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) fail(localized("winInline.masque.72466c7d889e"))
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail(localized("winInline.masque.20d2681a50f9")) }
  if (object(value) && value.outbounds !== undefined) { keys(value, new Set(['outbounds'])); value = value.outbounds }
  const nodes = Array.isArray(value) ? value : [value]
  if (!nodes.length || nodes.length > 64) fail(localized("winInline.masque.06e5682e2061"))
  // Validate the entire envelope before returning any items; never partially accept runtime fields.
  const profiles = nodes.map(masqueNode), count = Math.max(0, Math.min(64, Math.floor(limit)))
  return { items: profiles.slice(0, count), skipped: Math.max(0, profiles.length - count) }
}
