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
  if (Object.keys(v).some(k => !allowed.has(k))) fail('неподдерживаемые поля; нужен экспорт outbound, без маршрутов, файлов и listener')
}
const text = (v: unknown, max = 4096): string => {
  if (typeof v !== 'string' || !v || v.length > max || /[\x00-\x1f\x7f]/.test(v)) fail('некорректное текстовое поле')
  return v
}
const integer = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail('некорректный порт или MTU')
  return v
}
function hostname(v: unknown): string {
  const value = text(v, 253).replace(/^\[|\]$/g, '')
  if (isIP(value)) return value
  const ascii = domainToASCII(value.replace(/\.$/, '')).toLowerCase()
  if (!ascii || /^[0-9.]+$/.test(ascii) || !ascii.split('.').every(s => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))) fail('некорректный адрес сервера')
  return ascii
}
function prefix(v: unknown, family: 4 | 6): string {
  const raw = text(v, 64), parts = raw.split('/'), max = family === 4 ? 32 : 128
  if (parts.length > 2 || isIP(parts[0]) !== family || (parts[1] !== undefined && !/^\d+$/.test(parts[1]))) fail('неверный внутренний IP-адрес')
  const bits = parts[1] === undefined ? max : Number(parts[1])
  if (bits < 0 || bits > max) fail('неверная маска внутреннего адреса')
  return `${parts[0]}/${bits}`
}
function key(v: unknown, privateKey: boolean): string {
  const value = text(v)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('ключ должен быть DER в base64')
  const der = Buffer.from(value, 'base64')
  try {
    // Enforce one DER sequence without trailing bytes; SEC1 is INTEGER 1 + OCTET STRING,
    // while PKCS8 starts INTEGER 0 + an algorithm sequence. An optional SEC1 public part is legal.
    if (der[0] !== 0x30) fail('некорректный DER')
    let offset = 2, length = der[1]
    if (length & 0x80) {
      const count = length & 0x7f
      if (count < 1 || count > 2 || der[2] === 0) fail('некорректная длина DER')
      length = 0
      for (let i = 0; i < count; i++) length = length * 256 + der[offset++]
      if (length < 128) fail('некорректная длина DER')
    }
    if (offset + length !== der.length || (privateKey && (der[offset] !== 2 || der[offset + 1] !== 1 || der[offset + 2] !== 1 || der[offset + 3] !== 4))) fail('неверный формат EC-ключа')
    const parsed = privateKey ? createPrivateKey({ key: der, format: 'der', type: 'sec1' }) : createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (parsed.asymmetricKeyType !== 'ec' || !['prime256v1', 'secp384r1', 'secp521r1'].includes(parsed.asymmetricKeyDetails?.namedCurve ?? '')) fail('нужен поддерживаемый EC-ключ')
    // Native uses SEC1 for private keys, SPKI for public keys. Reject trailing DER and PKCS8 aliases.
    if (!privateKey && !Buffer.from(parsed.export({ format: 'der', type: 'spki' })).equals(der)) fail('некорректный формат EC-ключа')
  } catch { fail(privateKey ? 'некорректный приватный EC-ключ (SEC1)' : 'некорректный публичный EC-ключ (SPKI)') }
  return value
}
function duration(v: unknown, negative = false): string {
  const value = text(v, 16)
  if (value === '0' || (negative && value === '-1s')) return value
  const m = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!m || Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]] ?? 0) > 86400) fail('неверный интервал: от 0 до 24 часов')
  return value
}

export function masqueNode(raw: unknown): OutProfile {
  if (!object(raw) || raw.type !== 'masque') fail('ожидался outbound с type: masque')
  keys(raw, NODE_KEYS)
  const server = hostname(raw.server), serverPort = raw.server_port === undefined ? 443 : integer(raw.server_port, 1, 65535)
  const profile = raw.profile === undefined ? 'cloudflare' : text(raw.profile, 20)
  if (!['cloudflare', 'standard'].includes(profile)) fail('profile должен быть cloudflare или standard')
  const vhttp = raw.vhttp === undefined ? (profile === 'standard' ? 'h3' : 'auto') : text(raw.vhttp, 8)
  if (!['auto', 'h2', 'h3'].includes(vhttp) || (profile === 'standard' && vhttp !== 'h3')) fail('standard поддерживает только h3; cloudflare — auto, h3 или h2')
  const ip = raw.ip === undefined ? undefined : prefix(raw.ip, 4), ipv6 = raw.ipv6 === undefined ? undefined : prefix(raw.ipv6, 6)
  if (!ip && !ipv6) fail('нужен внутренний ip или ipv6 из конфигурации')
  if (profile === 'cloudflare' && (!raw.private_key || !raw.public_key)) fail('нужны личный private_key и public_key сервера из регистрации WARP')
  const out: Record<string, unknown> = { type: 'masque', server, server_port: serverPort, profile, vhttp }
  for (const field of ['private_key', 'public_key'] as const) if (raw[field] !== undefined) out[field] = key(raw[field], field === 'private_key')
  if (ip) out.ip = ip
  if (ipv6) out.ipv6 = ipv6
  if (raw.uri !== undefined) {
    const uri = text(raw.uri), u = (() => { try { return new URL(uri) } catch { return fail('некорректный CONNECT-IP URI') } })()
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) fail('CONNECT-IP URI должен быть HTTPS без пароля и fragment')
    out.uri = uri
  } else if (profile === 'standard') fail('для standard нужен URI сервера CONNECT-IP')
  out.mtu = raw.mtu === undefined ? 1280 : integer(raw.mtu, ipv6 ? 1280 : 576, 9000)
  const tls = raw.tls === undefined ? {} : raw.tls
  if (!object(tls)) fail('tls должен быть объектом')
  keys(tls, TLS_KEYS)
  if (tls.enabled !== undefined && tls.enabled !== true) fail('TLS нельзя отключить')
  if (tls.insecure !== undefined && tls.insecure !== false) fail('проверка сертификата или ключа сервера обязательна')
  const safeTLS: Record<string, unknown> = { enabled: true }
  for (const field of ['disable_sni', 'fragment', 'record_fragment'] as const) if (tls[field] !== undefined) {
    if (typeof tls[field] !== 'boolean') fail('TLS-флаг должен быть true или false')
    if (field !== 'disable_sni' && tls[field] && vhttp === 'h3') fail('фрагментация TLS не применяется к HTTP/3')
    safeTLS[field] = tls[field]
  }
  if (tls.server_name !== undefined) safeTLS.server_name = hostname(tls.server_name)
  if (tls.fragment_fallback_delay !== undefined) safeTLS.fragment_fallback_delay = duration(tls.fragment_fallback_delay)
  out.tls = safeTLS
  for (const field of ['idle_timeout', 'keep_alive_period'] as const) if (raw[field] !== undefined) out[field] = duration(raw[field], field === 'keep_alive_period')
  if (raw.udp_fragment !== undefined) {
    if (typeof raw.udp_fragment !== 'boolean') fail('udp_fragment должен быть true или false')
    out.udp_fragment = raw.udp_fragment
  }
  if (raw.network_list !== undefined) {
    const list = typeof raw.network_list === 'string' ? [raw.network_list] : raw.network_list
    if (!Array.isArray(list) || !list.length || list.length > 2 || list.some(v => !['tcp', 'udp'].includes(v)) || new Set(list).size !== list.length) fail('network_list должен содержать tcp и/или udp')
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
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) fail('конфиг больше 1 МБ')
  let value: unknown
  try { value = JSON.parse(text) } catch { return fail('некорректный JSON') }
  if (object(value) && value.outbounds !== undefined) { keys(value, new Set(['outbounds'])); value = value.outbounds }
  const nodes = Array.isArray(value) ? value : [value]
  if (!nodes.length || nodes.length > 64) fail('допустимо от 1 до 64 outbound-профилей')
  // Validate the entire envelope before returning any items; never partially accept runtime fields.
  const profiles = nodes.map(masqueNode), count = Math.max(0, Math.min(64, Math.floor(limit)))
  return { items: profiles.slice(0, count), skipped: Math.max(0, profiles.length - count) }
}
