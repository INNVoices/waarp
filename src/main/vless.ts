import type { VlessFields, VlessNetwork, VlessProfile, VlessSecurity, VlessXhttpExtra } from '../shared/vless-types'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { ConfError } from './conf-error'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PBK = /^[A-Za-z0-9_-]{43}$/
const SID = /^(?:[0-9a-f]{2}){0,8}$/i
const LINK = /^vless:\/\/([^@/?#]+)@(\[[^\]]+\]|[^:/?#]+):(\d{1,5})\/?(?:\?([^#]*))?(?:#(.*))?$/is
const FPS = ['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', '360', 'qq', 'random', 'randomized']
const MODES = ['auto', 'packet-up', 'stream-up', 'stream-one']
const KNOWN = new Set(['type', 'security', 'pbk', 'sid', 'fp', 'sni', 'path', 'host', 'mode', 'flow', 'encryption', 'extra', 'spx', 'alpn', 'serviceName', 'headerType', 'allowInsecure', 'insecure', 'pqv'])
const XMUX: Record<string, string> = {
  maxConcurrency: 'max_concurrency',
  maxConnections: 'max_connections',
  cMaxReuseTimes: 'c_max_reuse_times',
  hMaxRequestTimes: 'h_max_request_times',
  hMaxReusableSecs: 'h_max_reusable_secs'
}

export const DEFAULT_FP = 'firefox'

export function looksLikeVless(text: string): boolean {
  const t = text.trim()
  if (/^vless:\/\//im.test(t)) return true
  if (/^https:\/\/\S+$/i.test(t)) return true
  if (!t || /\[Interface\]/i.test(t) || /^vpn:\/\//i.test(t) || /[^A-Za-z0-9+/=_\-\s]/.test(t)) return false
  return decodeList(t) !== undefined
}

export function isSubscriptionUrl(text: string): boolean {
  return /^https:\/\/\S+$/i.test(text.trim())
}

function decodeList(t: string): string | undefined {
  const b64 = t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (b64.length < 16) return undefined
  const dec = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8')
  return dec.includes('://') ? dec : undefined
}

function range(v: unknown): string | undefined {
  if (typeof v === 'number') return v > 0 ? String(v) : undefined
  if (typeof v === 'string') {
    const s = v.trim()
    return s && s !== '0' && s !== '0-0' ? s : undefined
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const a = Number(o.from), b = Number(o.to)
    if (Number.isFinite(a) && Number.isFinite(b) && (a > 0 || b > 0)) return a === b ? String(a) : `${a}-${b}`
  }
  return undefined
}

function mapExtra(raw: string, notApplied: string[]): VlessXhttpExtra | undefined {
  let data: unknown
  try { data = JSON.parse(raw) } catch { notApplied.push('extra'); return undefined }
  if (!data || typeof data !== 'object' || Array.isArray(data)) { notApplied.push('extra'); return undefined }
  const out: VlessXhttpExtra = {}
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (k === 'xPaddingBytes') {
      const r = range(v)
      if (r) out.xPaddingBytes = r
    } else if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) {
      const h: Record<string, string> = {}
      for (const [hk, hv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof hv === 'string') h[hk] = hv
        else notApplied.push('headers.' + hk)
      }
      if (Object.keys(h).length) out.headers = h
    } else if (k === 'xmux' && v && typeof v === 'object' && !Array.isArray(v)) {
      const x: NonNullable<VlessXhttpExtra['xmux']> = {}
      for (const [xk, xv] of Object.entries(v as Record<string, unknown>)) {
        if (xk in XMUX) {
          const r = range(xv)
          if (r) (x as Record<string, string>)[xk] = r
        } else if (xk === 'hKeepAlivePeriod') {
          const n = Number(xv)
          if (Number.isFinite(n) && n > 0) x.hKeepAlivePeriod = Math.floor(n)
        } else notApplied.push('xmux.' + xk)
      }
      if (x.maxConcurrency && x.maxConnections) { delete x.maxConnections; notApplied.push('xmux.maxConnections') }
      if (Object.keys(x).length) out.xmux = x
    } else notApplied.push(k)
  }
  return Object.keys(out).length ? out : undefined
}

function label(f: VlessFields): string {
  const sec = f.security === 'reality' ? 'REALITY' : f.security === 'tls' ? 'TLS' : ''
  return ['VLESS', sec, f.network === 'tcp' ? '' : f.network.toUpperCase()].filter(Boolean).join(' · ')
}

export function parseVless(raw: string, fallbackName = 'Сервер'): VlessProfile {
  const link = raw.trim()
  const m = link.match(LINK)
  if (!m) throw new ConfError('Ссылка vless:// не читается. Нужен вид vless://uuid@host:port?…')
  let uuid: string
  try { uuid = decodeURIComponent(m[1]) } catch { uuid = m[1] }
  if (!UUID.test(uuid)) throw new ConfError('В ссылке нет корректного uuid')
  const port = Number(m[3])
  if (!(port >= 1 && port <= 65535)) throw new ConfError('Порт в ссылке должен быть от 1 до 65535')
  const server = m[2].replace(/^\[|\]$/g, '')
  const q = new URLSearchParams(m[4] ?? '')
  const g = (k: string) => q.get(k)?.trim() || undefined
  const notApplied: string[] = []

  const security = (g('security') ?? 'none').toLowerCase()
  if (security !== 'reality' && security !== 'tls' && security !== 'none') throw new ConfError(`Защита security=${security} не поддерживается`)

  const typeRaw = (g('type') ?? 'tcp').toLowerCase()
  const typeMap: Record<string, VlessNetwork> = { tcp: 'tcp', raw: 'tcp', xhttp: 'xhttp', splithttp: 'xhttp', ws: 'ws', grpc: 'grpc' }
  const network = typeMap[typeRaw]
  if (!network) throw new ConfError(`Транспорт type=${typeRaw} не поддерживается. Есть xhttp, tcp, ws, grpc`)

  const fp = (g('fp') ?? DEFAULT_FP).toLowerCase()
  if (!FPS.includes(fp)) throw new ConfError(`Отпечаток fp=${fp} не поддерживается`)

  const pbk = g('pbk')
  const sid = g('sid') ?? ''
  const sni = g('sni')
  if (security === 'reality') {
    if (!pbk) throw new ConfError('В ссылке нет pbk (публичный ключ REALITY)')
    if (!PBK.test(pbk)) throw new ConfError('pbk не похож на ключ REALITY (нужно 43 символа base64url)')
    if (!SID.test(sid)) throw new ConfError('sid должен быть hex чётной длины, до 16 символов')
    if (!sni) throw new ConfError('В ссылке нет sni для REALITY')
  }

  const mode = g('mode')
  if (mode && network === 'xhttp' && !MODES.includes(mode)) throw new ConfError(`Режим mode=${mode} не поддерживается. Есть ${MODES.join(', ')}`)

  const spx = g('spx')
  if (spx && spx !== '/') notApplied.push('spx')
  if (g('pqv')) notApplied.push('pqv')
  const ins = g('allowInsecure') ?? g('insecure')
  if (ins === '1' || ins === 'true') notApplied.push('allowInsecure')
  if (g('headerType') && g('headerType') !== 'none') notApplied.push('headerType')
  for (const k of new Set(q.keys())) if (!KNOWN.has(k)) notApplied.push(k)

  const extraRaw = g('extra')
  const extra = extraRaw && network === 'xhttp' ? mapExtra(extraRaw, notApplied) : undefined
  if (extraRaw && network !== 'xhttp') notApplied.push('extra')

  const enc = g('encryption')
  const alpn = g('alpn')?.split(',').map(x => x.trim()).filter(Boolean)

  const vless: VlessFields = {
    server,
    port,
    uuid,
    ...(g('flow') ? { flow: g('flow') } : {}),
    ...(enc && enc !== 'none' ? { encryption: enc } : {}),
    security: security as VlessSecurity,
    ...(sni ? { sni } : {}),
    fp,
    ...(security === 'reality' ? { pbk, sid } : {}),
    ...(spx ? { spx } : {}),
    ...(alpn?.length ? { alpn } : {}),
    network,
    ...(g('path') ? { path: g('path') } : {}),
    ...(g('host') ? { host: g('host') } : {}),
    ...(mode && network === 'xhttp' ? { mode } : {}),
    ...(g('serviceName') ? { serviceName: g('serviceName') } : {}),
    ...(extra ? { extra } : {}),
    notApplied
  }

  let name = m[5] ?? ''
  try { name = decodeURIComponent(name) } catch {}
  name = name.trim().slice(0, 40) || fallbackName
  return { kind: 'vless', id: Math.random().toString(36).slice(2, 10), name, version: label(vless), addedAt: Date.now(), vless }
}

export interface SubResult { items: VlessProfile[]; skipped: number; errors: string[] }

export function parseSubscription(text: string): SubResult {
  let t = text.trim()
  if (!t.includes('://')) {
    const dec = decodeList(t)
    if (dec) t = dec
  }
  const items: VlessProfile[] = []
  const errors: string[] = []
  let skipped = 0
  let n = 0
  for (const line0 of t.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line || line.startsWith('#')) continue
    n++
    if (!/^vless:\/\//i.test(line)) { skipped++; continue }
    try {
      items.push(parseVless(line, `Сервер ${n}`))
    } catch (e) {
      skipped++
      errors.push(`${n}: ${e instanceof ConfError ? e.message : 'не прочиталась'}`)
    }
  }
  return { items, skipped, errors }
}

export const vlessKey = (p: VlessProfile) => `${p.vless.uuid}|${p.vless.server}|${p.vless.port}`

export function vlessOutbound(p: VlessProfile, tag: string) {
  const v = p.vless
  const o: Record<string, unknown> = { type: 'vless', tag, server: v.server, server_port: v.port, uuid: v.uuid }
  if (v.flow) o.flow = v.flow
  if (v.encryption) o.encryption = v.encryption
  if (v.security !== 'none') {
    const tls: Record<string, unknown> = {
      enabled: true,
      ...(v.sni ? { server_name: v.sni } : {}),
      utls: { enabled: true, fingerprint: v.fp },
      ...(v.alpn?.length ? { alpn: v.alpn } : {}),
      ...(v.recordFragment ? { record_fragment: true } : {})
    }
    if (v.security === 'reality') tls.reality = { enabled: true, public_key: v.pbk, short_id: v.sid ?? '' }
    o.tls = tls
  }
  if (v.network === 'xhttp') {
    const t: Record<string, unknown> = { type: 'xhttp' }
    if (v.mode) t.mode = v.mode
    if (v.host) t.host = v.host
    if (v.path) t.path = v.path
    if (v.extra?.headers) t.headers = v.extra.headers
    if (v.extra?.xPaddingBytes) t.x_padding_bytes = v.extra.xPaddingBytes
    if (v.extra?.xmux) {
      const x: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v.extra.xmux)) x[XMUX[k] ?? 'h_keep_alive_period'] = val
      t.xmux = x
    }
    o.transport = t
  } else if (v.network === 'ws') {
    o.transport = { type: 'ws', ...(v.path ? { path: v.path } : {}), ...(v.host ? { headers: { Host: v.host } } : {}) }
  } else if (v.network === 'grpc') {
    o.transport = { type: 'grpc', ...(v.serviceName ? { service_name: v.serviceName } : {}) }
  }
  return o
}

export function vlessSecrets(p: VlessProfile): string[] {
  const v = p.vless
  return [v.uuid, v.pbk, v.sid, p.sub].filter((x): x is string => !!x && x.length >= 4)
}

export function redactVless(s: string, known: string[] = []): string {
  let out = s
  for (const k of known) if (k.length >= 4) out = out.split(k).join('…')
  return out
    .replace(/vless:\/\/\S+/gi, 'vless://…')
    .replace(/https:\/\/([^\s/?#]+)[^\s]*/gi, 'https://$1/…')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, m => m.slice(0, 4) + '…')
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, m => m.slice(0, 4) + '…')
}

const PRIVATE_HOST = /^(?:localhost|.*\.localhost|\[?::1?\]?|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0)$/i
const PRIVATE_ADDRESSES = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) PRIVATE_ADDRESSES.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE_ADDRESSES.addSubnet(address, prefix, 'ipv6')
const hostnameOf = (u: URL): string => u.hostname.replace(/^\[|\]$/g, '')

export interface FetchOpts { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; maxRedirects?: number }

function checkUrl(u: URL) {
  if (u.protocol !== 'https:') throw new ConfError('Подписка должна быть по https')
  if (u.username || u.password) throw new ConfError('Логин и пароль в адресе подписки не поддерживаются')
  if (PRIVATE_HOST.test(hostnameOf(u).replace(/\.$/, '')) || privateIp(hostnameOf(u))) throw new ConfError('Адрес подписки указывает на локальную сеть')
}

function privateIp(address: string): boolean {
  const family = isIP(address)
  // BlockList also checks IPv4-mapped IPv6 against IPv4 ranges (including canonical ::ffff:7f00:1).
  return family !== 0 && PRIVATE_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('aborted')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function resolvedPublic(u: URL, signal: AbortSignal): Promise<LookupAddress[]> {
  const hostname = hostnameOf(u)
  if (isIP(hostname)) {
    if (privateIp(hostname)) throw new ConfError('Адрес подписки указывает на локальную сеть')
    return [{ address: hostname, family: isIP(hostname) }]
  }
  let addresses: { address: string; family: number }[]
  try { addresses = await untilAbort(lookup(hostname, { all: true, verbatim: true }), signal) }
  catch (error) { if (signal.aborted) throw error; throw new ConfError('Не удалось определить адрес сервера подписки') }
  if (!addresses.length || addresses.some(x => privateIp(x.address))) throw new ConfError('Адрес подписки указывает на локальную сеть')
  return addresses
}

/** The caller has validated this address set; never resolve again when Node tries another IP family. */
export function pinnedAddressLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    const candidates = addresses.filter(address => !family || address.family === family)
    if (!candidates.length) { callback(Object.assign(new Error('No checked address for this family'), { code: 'ENOTFOUND' }), []); return }
    // Node's dual-stack connector requests all:true. Returning a string there breaks every HTTPS dial.
    if (options.all) callback(null, candidates)
    else callback(null, candidates[0].address, candidates[0].family)
  }
}

/** Resolve once, reject every private answer, then pin TLS sockets to the checked address set. */
async function pinnedFetch(u: URL, signal: AbortSignal): Promise<Response> {
  const target = await resolvedPublic(u, signal)
  signal.throwIfAborted()
  const hostname = hostnameOf(u)
  return await new Promise<Response>((resolve, reject) => {
    const req = httpsRequest({
      protocol: 'https:', hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'GET', servername: isIP(hostname) ? undefined : hostname, signal,
      headers: { Accept: 'text/plain, application/octet-stream;q=0.9, */*;q=0.1', 'User-Agent': 'Waarp/0.4' },
      lookup: pinnedAddressLookup(target)
    }, res => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      const status = res.statusCode ?? 500
      if ([204, 205, 304].includes(status)) {
        res.resume()
        resolve(new Response(null, { status, statusText: res.statusMessage, headers }))
      } else resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, statusText: res.statusMessage, headers }))
    })
    req.once('error', reject)
    req.end()
  })
}

export async function fetchSubscription(url: string, o: FetchOpts = {}): Promise<string> {
  const f = o.fetchImpl ?? fetch
  const max = o.maxBytes ?? 1024 * 1024
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 10_000)
  try {
    let cur: URL
    try { cur = new URL(url.trim()) } catch { throw new ConfError('Ссылка на подписку не читается') }
    for (let hop = 0; ; hop++) {
      checkUrl(cur)
      let res: Response
      try {
        // Production sockets are pinned to the address that passed the private-range check, preventing DNS rebinding.
        // Injected transports keep parser tests deterministic and never touch the network.
        res = await untilAbort(o.fetchImpl ? f(cur.toString(), { redirect: 'manual', signal: ctl.signal }) : pinnedFetch(cur, ctl.signal), ctl.signal)
      } catch (e) {
        if (e instanceof ConfError) throw e
        throw new ConfError(ctl.signal.aborted ? 'Подписка не ответила за 10 секунд' : 'Не удалось загрузить подписку')
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        void res.body?.cancel().catch(() => undefined)
        if (!loc || hop >= (o.maxRedirects ?? 3)) throw new ConfError('Слишком много перенаправлений подписки')
        try { cur = new URL(loc, cur) } catch { throw new ConfError('Перенаправление подписки не читается') }
        continue
      }
      if (!res.ok) { void res.body?.cancel().catch(() => undefined); throw new ConfError(`Подписка ответила кодом ${res.status}`) }
      const len = Number(res.headers.get('content-length'))
      if (Number.isFinite(len) && len > max) { void res.body?.cancel().catch(() => undefined); throw new ConfError('Подписка слишком большая (больше 1 МБ)') }
      if (!res.body) throw new ConfError('Подписка не вернула поток данных')
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = res.body.getReader()
      try {
        for (;;) {
          let r: ReadableStreamReadResult<Uint8Array>
          try { r = await untilAbort(reader.read(), ctl.signal) } catch { throw new ConfError(ctl.signal.aborted ? 'Подписка не ответила за 10 секунд' : 'Подписка оборвалась') }
          if (r.done) break
          size += r.value.length
          if (size > max) throw new ConfError('Подписка слишком большая (больше 1 МБ)')
          chunks.push(r.value)
        }
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
      return Buffer.concat(chunks).toString('utf8')
    }
  } finally {
    clearTimeout(timer)
  }
}
