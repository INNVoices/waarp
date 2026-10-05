import type { OpenVpnProfile } from '../shared/types'
import { ConfError } from './conf-error'

const id = () => Math.random().toString(36).slice(2, 10)
const unsafe = new Set(['script-security', 'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'learn-address', 'client-connect', 'client-disconnect', 'plugin', 'management'])

function words(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function host(v: string): string {
  const h = v.replace(/^\[|\]$/g, '')
  if (!h || h.length > 253 || /[\s/]/.test(h)) throw new ConfError('Некорректный адрес OpenVPN-сервера')
  return h
}

function port(v: string | undefined): number {
  const n = Number(v ?? 1194)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfError('Некорректный порт OpenVPN-сервера')
  return n
}

/** Parse an embedded, non-executable OpenVPN client profile. External key files and scripts are deliberately rejected. */
export function parseOpenVpn(raw: string, name = 'OpenVPN'): OpenVpnProfile {
  name = String(name).trim().slice(0, 80) || 'OpenVPN'
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new ConfError('Конфиг OpenVPN слишком большой')
  if (!/^\s*client(?:\s|$)/mi.test(raw) && !/^\s*remote\s+/mi.test(raw)) throw new ConfError('Это не похоже на клиентский конфиг OpenVPN')

  const inline = new Map<string, string[]>()
  const clean = raw.replace(/<([a-z0-9-]+)>\s*([\s\S]*?)\s*<\/\1>/gi, (_all, key: string, body: string) => {
    const k = key.toLowerCase(); inline.set(k, [...(inline.get(k) ?? []), body.trim()]); return ''
  })
  const directives = new Map<string, string[][]>()
  for (const source of clean.split(/\r?\n/)) {
    const line = source.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const w = words(line); const key = w.shift()?.toLowerCase()
    if (!key) continue
    if (unsafe.has(key)) throw new ConfError(`OpenVPN-конфиг содержит запрещённую команду: ${key}`)
    directives.set(key, [...(directives.get(key) ?? []), w])
  }
  const one = (key: string) => directives.get(key)?.at(-1)
  const external = ['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'pkcs12']
  for (const key of external) if (one(key)?.[0] && !['[inline]', 'inline'].includes(one(key)![0].toLowerCase())) {
    throw new ConfError(`Вложи ${key} внутрь .ovpn: внешние файлы автоматически не читаются`)
  }
  const authUser = one('auth-user-pass')
  if (authUser?.[0] && !['[inline]', 'inline'].includes(authUser[0].toLowerCase())) throw new ConfError('Файл auth-user-pass автоматически не читается')
  if (authUser && !inline.has('auth-user-pass')) throw new ConfError('OpenVPN с интерактивным логином пока не поддерживается; вложи auth-user-pass в конфиг')

  const remotes = directives.get('remote') ?? []
  if (!remotes.length) throw new ConfError('В OpenVPN-конфиге нет remote')
  const protoRaw = (one('proto')?.[0] ?? 'udp').toLowerCase()
  const network = protoRaw.startsWith('tcp') ? 'tcp' : protoRaw.startsWith('udp') ? 'udp' : undefined
  if (!network) throw new ConfError(`Протокол OpenVPN не поддерживается: ${protoRaw}`)
  const servers = remotes.map(r => ({ server: host(r[0] ?? ''), server_port: port(r[1]), ...(r[2] ? { network: r[2].startsWith('tcp') ? 'tcp' : 'udp' } : {}) }))
  const first = servers[0]
  const tls: Record<string, unknown> = {}
  if (!inline.has('ca')) throw new ConfError('В OpenVPN-конфиге нет вложенного сертификата CA')
  tls.certificate = inline.get('ca')
  if (inline.has('cert')) tls.client_certificate = inline.get('cert')
  if (inline.has('key')) tls.client_key = inline.get('key')
  if (inline.has('cert') !== inline.has('key')) throw new ConfError('OpenVPN требует одновременно client certificate и client key')
  const verify = one('verify-x509-name')
  if (verify?.[0]) tls.server_name = verify[0]
  const remoteTls = one('remote-cert-tls')?.[0]
  if (remoteTls === 'server' || remoteTls === 'client') tls.remote_certificate_tls = remoteTls
  const ciphers = (one('data-ciphers')?.join(' ') ?? '').split(':').map(x => x.trim()).filter(Boolean)
  const credentials = inline.get('auth-user-pass')?.[0]?.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const numeric = (key: string): number | undefined => {
    const v = one(key)?.[0]; if (v === undefined) return undefined
    const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const duration = (key: string): string | undefined => {
    const v = one(key)?.[0]; return v && /^\d+$/.test(v) ? `${v}s` : undefined
  }
  const endpoint: Record<string, unknown> = {
    type: 'openvpn-client',
    mode: 'tls',
    ...(servers.length === 1 ? { server: first.server, server_port: first.server_port } : { servers }),
    network,
    ...(Object.keys(tls).length ? { tls } : {}),
    ...(ciphers.length ? { data_ciphers: ciphers } : {}),
    ...(one('cipher')?.[0] ? { data_ciphers_fallback: one('cipher')![0] } : {}),
    ...(one('auth')?.[0] ? { auth: one('auth')![0] } : {}),
    ...(one('compress') ? { compression: one('compress')![0] || 'stub' } : {}),
    ...(one('comp-lzo') ? { compression_lzo: one('comp-lzo')![0] || 'adaptive', allow_compression: 'asym' } : {}),
    ...(numeric('mssfix') !== undefined ? { mss_fix: numeric('mssfix') } : {}),
    ...(numeric('fragment') !== undefined ? { fragment: numeric('fragment') } : {}),
    ...(duration('ping') ? { ping_interval: duration('ping') } : {}),
    ...(duration('ping-restart') ? { ping_restart: duration('ping-restart') } : {}),
    ...(numeric('explicit-exit-notify') !== undefined ? { explicit_exit_notify: numeric('explicit-exit-notify') } : {}),
    ...(credentials?.length === 2 ? { username: credentials[0], password: credentials[1] } : {}),
    ...(inline.has('tls-auth') ? { tls: { ...tls, control_wrap: { type: 'tls_auth', key: inline.get('tls-auth'), direction: one('key-direction')?.[0] === '0' ? 'server' : 'client' } } } : {}),
    ...(inline.has('tls-crypt') ? { tls: { ...tls, control_wrap: { type: 'tls_crypt', key: inline.get('tls-crypt') } } } : {})
  }
  return { kind: 'openvpn', id: id(), name: name.slice(0, 60), host: first.server, port: first.server_port, version: `OpenVPN · ${network.toUpperCase()}`, endpoint, addedAt: Date.now(), source: 'personal' }
}

export function looksLikeOpenVpn(text: string): boolean {
  return /^\s*(?:client|remote\s+)/mi.test(text) && /^\s*remote\s+/mi.test(text)
}

export function openVpnSecrets(p: OpenVpnProfile): string[] {
  const out: string[] = []
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string' && /(?:key|password|tls_auth|tls_crypt)/i.test(key) && v.length > 3) out.push(v)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(p.endpoint)
  return out
}
