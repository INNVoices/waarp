import type { OpenVpnProfile } from '../shared/types'
import { ConfError } from './conf-error'

const id = () => Math.random().toString(36).slice(2, 10)
const unsafe = new Set(['script-security', 'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'learn-address', 'client-connect', 'client-disconnect', 'plugin', 'management', 'tls-verify', 'auth-user-pass-verify', 'config'])
const inlineKeys = new Set(['ca', 'cert', 'key', 'auth-user-pass', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'peer-fingerprint'])

function words(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m[3]?.startsWith('#') || m[3]?.startsWith(';')) break
    out.push(m[1] ?? m[2] ?? m[3])
  }
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

function protocol(value: string): string {
  const normalized = value.toLowerCase().replace(/-client$/, '')
  if (!/^(?:udp|tcp)[46]?$/.test(normalized)) throw new ConfError(`Протокол OpenVPN не поддерживается: ${value}`)
  return normalized
}

/** Parse an embedded, non-executable OpenVPN client profile. External key files and scripts are deliberately rejected. */
export function parseOpenVpn(raw: string, name = 'OpenVPN'): OpenVpnProfile {
  name = String(name).trim().slice(0, 80) || 'OpenVPN'
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new ConfError('Конфиг OpenVPN слишком большой')
  if (!/^\s*(?:--)?client(?:\s|$)/mi.test(raw) && !/^\s*(?:--)?remote\s+/mi.test(raw)) throw new ConfError('Это не похоже на клиентский конфиг OpenVPN')

  const inline = new Map<string, string[]>()
  const clean = raw.replace(/<([a-z0-9-]+)>([\s\S]*?)<\/\1>/gi, (_all, key: string, body: string) => {
    const k = key.toLowerCase()
    if (!inlineKeys.has(k)) throw new ConfError(`Вложенный блок OpenVPN не поддерживается: ${k}`)
    // Spaces belong to the credential. Remove only the framing newlines around an inline file.
    const value = k === 'auth-user-pass' ? body.replace(/^\r?\n/, '').replace(/\r?\n[\t ]*$/, '') : body.trim()
    inline.set(k, [...(inline.get(k) ?? []), value]); return ''
  })
  const directives = new Map<string, string[][]>()
  for (const source of clean.split(/\r?\n/)) {
    const line = source.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const w = words(line); const key = w.shift()?.toLowerCase().replace(/^--/, '')
    if (!key) continue
    if (unsafe.has(key)) throw new ConfError(`OpenVPN-конфиг содержит запрещённую команду: ${key}`)
    directives.set(key, [...(directives.get(key) ?? []), w])
  }
  const one = (key: string) => directives.get(key)?.at(-1)
  if (one('dev')?.[0]?.toLowerCase().startsWith('tap') || one('dev-type')?.[0]?.toLowerCase() === 'tap') throw new ConfError('OpenVPN TAP не поддерживается: нужен конфиг TUN')
  // These constraints cannot be discarded: doing so changes peer verification or the tunnel itself.
  for (const key of ['crl-verify', 'capath', 'verify-hash', 'tls-ciphersuites', 'x509-username-field', 'http-proxy', 'socks-proxy', 'secret', 'static-challenge']) {
    if (directives.has(key)) throw new ConfError(`Параметр OpenVPN пока не поддерживается: ${key}`)
  }
  const external = ['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12']
  for (const key of external) if (one(key)?.[0] && !['[inline]', 'inline'].includes(one(key)![0].toLowerCase())) {
    throw new ConfError(`Вложи ${key} внутрь .ovpn: внешние файлы автоматически не читаются`)
  }
  const authUser = one('auth-user-pass')
  if (authUser?.[0] && !['[inline]', 'inline'].includes(authUser[0].toLowerCase())) throw new ConfError('Файл auth-user-pass автоматически не читается')
  if (authUser && !inline.has('auth-user-pass')) throw new ConfError('OpenVPN с интерактивным логином пока не поддерживается; вложи auth-user-pass в конфиг')
  for (const key of external) if (directives.has(key) && !inline.has(key)) throw new ConfError(`В OpenVPN-конфиге нет вложенного блока ${key}`)

  const remotes = directives.get('remote') ?? []
  if (!remotes.length) throw new ConfError('В OpenVPN-конфиге нет remote')
  const defaultNetwork = protocol(one('proto')?.[0] ?? 'udp')
  const servers = remotes.map(r => ({ server: host(r[0] ?? ''), server_port: port(r[1]), ...(r[2] ? { network: protocol(r[2]) } : {}) }))
  const first = servers[0]
  const network = servers.length === 1 ? first.network ?? defaultNetwork : defaultNetwork
  const tls: Record<string, unknown> = {}
  const fingerprints = [...(directives.get('peer-fingerprint') ?? []).flat(), ...(inline.get('peer-fingerprint') ?? []).flatMap(v => v.split(/\r?\n/))]
    .map(v => v.trim().replace(/:/g, '').toLowerCase()).filter(Boolean)
  if (fingerprints.some(v => !/^[0-9a-f]{64}$/.test(v))) throw new ConfError('Некорректный отпечаток сертификата OpenVPN')
  if (fingerprints.length) tls.peer_fingerprint = [...new Set(fingerprints)]
  if (!inline.has('ca') && !fingerprints.length) throw new ConfError('В OpenVPN-конфиге нет вложенного сертификата CA или отпечатка сервера')
  if (inline.has('ca')) tls.certificate = inline.get('ca')
  if (inline.has('cert')) tls.client_certificate = inline.get('cert')
  if (inline.has('key')) tls.client_key = inline.get('key')
  if (inline.has('cert') !== inline.has('key')) throw new ConfError('OpenVPN требует одновременно client certificate и client key')
  const verify = one('verify-x509-name')
  if (verify) {
    const type = verify[1] ?? 'subject' // OpenVPN's default differs from sing-box's default ('name').
    if (!verify[0] || !['subject', 'name', 'name-prefix'].includes(type)) throw new ConfError('Некорректный verify-x509-name в OpenVPN')
    tls.server_name = verify[0]; tls.server_name_type = type
  }
  const remoteTls = one('remote-cert-tls')?.[0]
  if (directives.has('remote-cert-tls') && !['server', 'client'].includes(remoteTls ?? '')) throw new ConfError('Некорректный remote-cert-tls в OpenVPN')
  if (remoteTls === 'server' || remoteTls === 'client') tls.remote_certificate_tls = remoteTls
  if (directives.has('remote-cert-ku') && !one('remote-cert-ku')?.length) throw new ConfError('remote-cert-ku должен содержать маску проверки сертификата')
  if (one('remote-cert-ku')?.length) tls.remote_certificate_ku = one('remote-cert-ku')
  if (directives.has('remote-cert-eku') && !one('remote-cert-eku')?.[0]) throw new ConfError('remote-cert-eku должен содержать назначение сертификата')
  if (one('remote-cert-eku')?.[0]) {
    if (remoteTls) throw new ConfError('Не сочетай remote-cert-tls и remote-cert-eku в одном OpenVPN-конфиге')
    tls.remote_certificate_eku = one('remote-cert-eku')![0]
  }
  for (const [key, field, allowed] of [['ns-cert-type', 'ns_certificate_type', ['server', 'client']], ['tls-cert-profile', 'certificate_profile', ['insecure', 'legacy', 'preferred', 'suiteb']]] as const) {
    const value = one(key)
    if (value) {
      if (value.length !== 1 || !(allowed as readonly string[]).includes(value[0])) throw new ConfError(`Некорректный ${key} в OpenVPN`)
      tls[field] = value[0]
    }
  }
  for (const [key, field] of [['tls-version-min', 'version_min'], ['tls-version-max', 'version_max'], ['tls-cipher', 'cipher'], ['tls-groups', 'groups']] as const) {
    const value = one(key)
    if (value) {
      if (value.length !== 1 || !value[0]) throw new ConfError(`Некорректный ${key} в OpenVPN`)
      if (key.startsWith('tls-version-') && !['1.0', '1.1', '1.2', '1.3'].includes(value[0])) throw new ConfError(`Некорректный ${key} в OpenVPN`)
      tls[field] = value[0]
    }
  }
  const wraps = ['tls-auth', 'tls-crypt', 'tls-crypt-v2'].filter(k => inline.has(k))
  if (wraps.length > 1) throw new ConfError('В OpenVPN-конфиге указан больше чем один способ защиты управляющего канала')
  if (wraps.length) {
    const key = wraps[0]
    const direction = one('key-direction')?.[0] ?? one('tls-auth')?.[1]
    if (key === 'tls-auth' && direction !== undefined && direction !== '0' && direction !== '1') throw new ConfError('key-direction OpenVPN должен быть 0 или 1')
    tls.control_wrap = { type: key.replace(/-/g, '_'), key: inline.get(key),
      ...(key === 'tls-auth' && direction !== undefined ? { direction: direction === '0' ? 'server' : 'client' } : {}) }
  }
  const ciphers = (one('data-ciphers')?.join(' ') ?? '').split(':').map(x => x.trim()).filter(Boolean)
  const allowCompression = one('allow-compression')?.[0]
  if (directives.has('allow-compression') && !['no', 'asym', 'yes'].includes(allowCompression ?? '')) throw new ConfError('Некорректный allow-compression в OpenVPN')
  const credentials = inline.get('auth-user-pass')?.[0]?.split(/\r?\n/)
  if (credentials && (inline.get('auth-user-pass')!.length !== 1 || credentials.length !== 2 || !credentials.every(Boolean))) throw new ConfError('auth-user-pass должен содержать ровно две непустые строки: логин и пароль')
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
    ...((one('data-ciphers-fallback') ?? one('cipher'))?.[0] ? { data_ciphers_fallback: (one('data-ciphers-fallback') ?? one('cipher'))![0] } : {}),
    ...(one('auth')?.[0] ? { auth: one('auth')![0] } : {}),
    ...(one('compress') ? { compression: one('compress')![0] || 'stub' } : {}),
    ...(one('comp-lzo') ? { compression_lzo: one('comp-lzo')![0] || 'adaptive', allow_compression: 'asym' } : {}),
    ...(allowCompression ? { allow_compression: allowCompression } : {}),
    ...(numeric('mssfix') !== undefined ? { mss_fix: numeric('mssfix') } : {}),
    ...(numeric('fragment') !== undefined ? { fragment: numeric('fragment') } : {}),
    ...(duration('ping') ? { ping_interval: duration('ping') } : {}),
    ...(duration('ping-restart') ? { ping_restart: duration('ping-restart') } : {}),
    ...(numeric('explicit-exit-notify') !== undefined ? { explicit_exit_notify: numeric('explicit-exit-notify') } : {}),
    ...(credentials ? { username: credentials[0], password: credentials[1] } : {})
  }
  return { kind: 'openvpn', id: id(), name: name.slice(0, 60), host: first.server, port: first.server_port, version: `OpenVPN · ${network.toUpperCase()}`, endpoint, addedAt: Date.now(), source: 'personal' }
}

export function looksLikeOpenVpn(text: string): boolean {
  return /^\s*(?:--)?(?:client|remote\s+)/mi.test(text) && /^\s*(?:--)?remote\s+/mi.test(text)
}

export function openVpnSecrets(p: OpenVpnProfile): string[] {
  const out: string[] = []
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string' && /(?:key|password|tls_auth|tls_crypt)/i.test(key) && v.length > 3) {
      out.push(v)
      // Engine output is read line by line, so a multiline PEM alone would not redact a key line.
      if (v.includes('\n')) out.push(...v.split(/\r?\n/).filter(line => line.length > 3 && !line.startsWith('-----')))
    }
    else if (Array.isArray(v)) v.forEach(x => walk(x, key))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  walk(p.endpoint)
  return [...new Set(out)]
}
