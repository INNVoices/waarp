import { inflateSync } from 'node:zlib'
import { generateKeyPairSync } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { join } from 'node:path'
import type { AppPick, AwgParams, AwgProfile, Profile, Route, Settings, Via } from '../shared/types'
import { PRESETS } from '../shared/presets'
import { appPatterns } from '../shared/appmatch'
import { ConfError } from './conf-error'
import { vlessOutbound } from './vless'
import { AUTO_ID, autoLivePool, grpTag, liveGroups, withAuto, type LiveGroup } from '../shared/groups'
import { compilePlan, planProfileIds } from '../shared/plan'
import { serviceGuardRule, TUN, TUN_ADDRESSES } from './tun'
import { diagnosticConfig, type DiagnosticProxy } from './diagnostic-proxy'
import { DnsPriority } from './dns-priority'

export { validateCustom } from '../shared/route-validation'

const NUM_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'] as const
const STR_KEYS = ['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5'] as const
const MAX_CONF_BYTES = 1024 * 1024

export { ConfError }

export function unwrapKey(input: string): string {
  if (Buffer.byteLength(input, 'utf8') > MAX_CONF_BYTES) throw new ConfError('Конфиг слишком большой (максимум 1 МБ)')
  const text = input.trim()
  if (/\[Interface\]/i.test(text)) return text
  const m = text.match(/^vpn:\/\/(.+)$/s)
  if (!m) throw new ConfError('Это не похоже на конфиг AmneziaWG. Нужен .conf или ключ vpn://')
  const b64 = m[1].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64')
  let json: string
  try {
    json = inflateSync(buf.subarray(4), { maxOutputLength: MAX_CONF_BYTES }).toString('utf8')
  } catch {
    try { json = inflateSync(buf, { maxOutputLength: MAX_CONF_BYTES }).toString('utf8') } catch { json = buf.toString('utf8') }
  }
  let data: unknown
  try { data = JSON.parse(json) } catch { throw new ConfError('Ключ vpn:// не читается. Экспортируй из AmneziaVPN «нативный формат AmneziaWG» (.conf)') }
  const found = findConf(data)
  if (!found) throw new ConfError('В ключе нет конфига AmneziaWG. Экспортируй из AmneziaVPN файл .conf')
  return found
}

function findConf(v: unknown, depth = 0): string | undefined {
  if (depth > 32) return undefined
  if (typeof v === 'string') {
    if (v.trimStart().startsWith('{')) { try { return findConf(JSON.parse(v), depth + 1) } catch {} }
    return /\[Interface\]/i.test(v) ? v : undefined
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const r = findConf(x, depth + 1)
      if (r) return r
    }
  }
  return undefined
}

const unsigned = (value: string, field: string, max = 0xffffffff): number => {
  const n = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n > max) throw new ConfError(`${field} должен быть целым числом от 0 до ${max}`)
  return n
}

function prefixes(value: string | undefined, field: string): string[] {
  const parts = (value ?? '').split(',').map(x => x.trim()).filter(Boolean)
  if (!parts.length) throw new ConfError(`В конфиге нет ${field}`)
  return [...new Set(parts.map(raw => {
    // wg/awg accept a bare host in both Address and AllowedIPs. Materialize its host prefix for sing-box.
    const addr = !raw.includes('/') ? raw + (isIP(raw) === 6 ? '/128' : '/32') : raw
    const match = /^([^/]+)\/(\d+)$/.exec(addr)
    const family = match && isIP(match[1])
    if (!match || !family || match[1].includes('%') || Number(match[2]) > (family === 4 ? 32 : 128)) throw new ConfError(`${field} должен содержать корректный IP и маску`)
    return match[1] + '/' + Number(match[2])
  }))]
}

function endpointAddress(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/.exec(value)
  if (!match) throw new ConfError('Endpoint должен быть вида host:port или [IPv6]:port')
  const port = unsigned(match[3], 'Порт Endpoint', 65535)
  if (!port) throw new ConfError('Порт Endpoint должен быть от 1 до 65535')
  let host = match[1] ?? match[2]
  if (match[1]) {
    if (isIP(host) !== 6) throw new ConfError('В квадратных скобках Endpoint должен быть IPv6-адрес')
  } else if (!isIP(host)) {
    host = domainToASCII(host).toLowerCase()
    const labels = host.replace(/\.$/, '').split('.')
    if (!host || host.length > 253 || /^[\d.]+$/.test(host) || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new ConfError('Endpoint должен содержать корректный IP или имя сервера')
  }
  return { host, port }
}

function magicHeader(value: string, key: string): string {
  const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(value)
  if (!match) throw new ConfError(`${key} должен быть числом или диапазоном min-max`)
  const lo = unsigned(match[1], key), hi = match[2] === undefined ? lo : unsigned(match[2], key)
  if (lo > hi) throw new ConfError(`${key}: начало диапазона не может быть больше конца`)
  return lo === hi ? String(lo) : `${lo}-${hi}`
}

/** Validate the pinned Windows AWG CPS grammar without rewriting its case-sensitive packet strings. */
function signaturePacket(value: string, key: string): string {
  const tags = [...value.matchAll(/<([^<>]*)>/g)]
  if (!tags.length || value.replace(/<[^<>]*>/g, '').trim()) throw new ConfError(`${key} должен содержать последовательность тегов <...>`)
  for (const tag of tags) {
    const [kind, arg, extra] = tag[1].trim().split(/\s+/)
    if (['r', 'rc', 'rd', 'dz'].includes(kind)) {
      // The pinned Windows wireguard-go build uses MaxMessageSize = 2048 - 32 for these tag arguments.
      if (arg === undefined || extra !== undefined) throw new ConfError(`${key}: у тега ${kind} должен быть один размер`)
      unsigned(arg, `${key}: размер ${kind}`, 2016)
    } else if (kind === 'b') {
      if (!arg || extra !== undefined || !/^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(arg)) throw new ConfError(`${key}: тег b должен содержать байты в hex-формате`)
    } else if (!['t', 'd', 'ds'].includes(kind) || arg !== undefined) throw new ConfError(`${key}: неподдерживаемый тег или аргумент`)
  }
  return value
}

export function parseConf(raw: string, name = 'Сервер'): AwgProfile {
  name = String(name).trim().slice(0, 80) || 'Сервер'
  const text = unwrapKey(raw)
  const sec: Record<string, Record<string, string>> = Object.create(null)
  let cur = ''
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.split('#', 1)[0].trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const h = line.match(/^\[(\w+)\]$/)
    if (h) {
      cur = h[1].toLowerCase()
      if (cur !== 'interface' && cur !== 'peer') throw new ConfError(`Неподдерживаемая секция [${h[1]}]`)
      if (sec[cur]) throw new ConfError(cur === 'peer' ? 'В одном туннеле Waarp поддерживается один [Peer]; раздели конфиг на отдельные туннели' : 'В одном туннеле должен быть один [Interface]')
      sec[cur] = Object.create(null)
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
    if (!kv || !cur) throw new ConfError('Строка конфига должна иметь вид параметр = значение внутри секции')
    const key = kv[1].toLowerCase(), value = kv[2].trim()
    if ((cur === 'interface' && ['address', 'dns'].includes(key)) || (cur === 'peer' && key === 'allowedips')) sec[cur][key] = [sec[cur][key], value].filter(Boolean).join(', ')
    else {
      if (sec[cur][key] !== undefined && sec[cur][key] !== value) throw new ConfError(`Параметр ${kv[1]} задан несколько раз с разными значениями`)
      sec[cur][key] = value
    }
  }
  const i = sec['interface'], p = sec['peer']
  if (!i || !p) throw new ConfError('В конфиге нет [Interface] или [Peer]')
  const commands = ['preup', 'postup', 'predown', 'postdown', 'table'].filter(k => i[k] !== undefined)
  if (commands.length) throw new ConfError(`Waarp не выполняет системные директивы из конфига: ${commands.join(', ')}`)
  const interfaceKeys = new Set<string>(['privatekey', 'address', 'dns', 'mtu', 'listenport', ...NUM_KEYS, ...STR_KEYS, 'headerprotectionkey', 'randomtrailers', 'disablecookies'])
  const peerKeys = new Set(['publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive'])
  const unsupported = [...Object.keys(i).filter(k => !interfaceKeys.has(k)), ...Object.keys(p).filter(k => !peerKeys.has(k))]
  if (unsupported.length) throw new ConfError(`Импорт не поддерживает параметры: ${unsupported.join(', ')}. Они не были отброшены; нужен совместимый конфиг WireGuard/AmneziaWG`)
  if (!i.privatekey) throw new ConfError('В конфиге нет PrivateKey')
  if (!p.publickey) throw new ConfError('В конфиге нет PublicKey сервера')
  if (!p.endpoint) throw new ConfError('В конфиге нет Endpoint сервера')
  const validKey = (key: string) => /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32
  if (!validKey(i.privatekey)) throw new ConfError('PrivateKey должен быть ключом WireGuard (32 байта, base64)')
  if (!validKey(p.publickey)) throw new ConfError('PublicKey сервера должен быть ключом WireGuard (32 байта, base64)')
  if (p.presharedkey && !validKey(p.presharedkey)) throw new ConfError('PresharedKey должен быть ключом WireGuard (32 байта, base64)')
  const ep = endpointAddress(p.endpoint)
  const list = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean)
  const address = prefixes(i.address, 'Address')
  const allowedIPs = prefixes(p.allowedips, 'AllowedIPs')
  const awg: AwgParams = {}
  for (const k of NUM_KEYS) if (i[k] !== undefined && i[k] !== '') {
    awg[k] = unsigned(i[k], k.toUpperCase(), k.startsWith('s') ? 65535 : 0xffffffff)
  }
  if ((awg.jmin ?? 0) > (awg.jmax ?? 0)) throw new ConfError('Jmin не может быть больше Jmax')
  if (i.headerprotectionkey !== undefined) {
    if (!validKey(i.headerprotectionkey)) throw new ConfError('HeaderProtectionKey должен быть ключом 32 байта в base64, как на сервере')
    if (Buffer.from(i.headerprotectionkey, 'base64').every(b => b === 0)) throw new ConfError('HeaderProtectionKey не может состоять только из нулей; если защита заголовка не используется, уберите этот параметр')
    if ((['s1', 's2', 's3', 's4'] as const).some(k => (awg[k] ?? 0) < 12)) throw new ConfError('С HeaderProtectionKey параметры S1–S4 должны быть не меньше 12')
    awg.header_protection_key = i.headerprotectionkey
  }
  const flag = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined
    if (/^(true|1|on)$/i.test(v)) return true
    if (/^(false|0|off)$/i.test(v)) return false
    throw new ConfError(`${name} должен быть true или false`)
  }
  const trailers = flag(i.randomtrailers, 'RandomTrailers'), cookies = flag(i.disablecookies, 'DisableCookies')
  if (trailers !== undefined) awg.random_trailers = trailers
  if (cookies !== undefined) awg.disable_cookies = cookies
  for (const k of STR_KEYS) if (i[k]) awg[k] = k.startsWith('h') ? magicHeader(i[k], k.toUpperCase()) : signaturePacket(i[k], k.toUpperCase())
  const headers = (['h1', 'h2', 'h3', 'h4'] as const).map((key, index) => {
    const value = awg[key]
    const parts = (value && value !== '0' ? value : String(index + 1)).split('-').map(Number)
    return { key, lo: parts[0], hi: parts[1] ?? parts[0] }
  })
  for (let a = 0; a < headers.length; a++) for (let b = a + 1; b < headers.length; b++) {
    if (headers[a].lo <= headers[b].hi && headers[b].lo <= headers[a].hi) throw new ConfError(`${headers[a].key.toUpperCase()} и ${headers[b].key.toUpperCase()} не должны пересекаться`)
  }
  const mtu = i.mtu ? unsigned(i.mtu, 'MTU', 9000) : undefined
  if (mtu !== undefined && mtu < 576) throw new ConfError('MTU должен быть целым числом от 576 до 9000')
  const keepalive = p.persistentkeepalive ? (/^off$/i.test(p.persistentkeepalive) ? 0 : unsigned(p.persistentkeepalive, 'PersistentKeepalive', 65535)) : undefined
  const listenPort = i.listenport ? unsigned(i.listenport, 'ListenPort', 65535) : undefined
  return {
    kind: 'awg',
    id: Math.random().toString(36).slice(2, 10),
    name,
    address,
    privateKey: i.privatekey,
    dns: list(i.dns),
    mtu: mtu && Number.isFinite(mtu) ? mtu : undefined,
    listenPort,
    awg,
    peer: {
      publicKey: p.publickey,
      presharedKey: p.presharedkey || undefined,
      host: ep.host,
      port: ep.port,
      keepalive,
      allowedIPs
    },
    version: detectVersion(awg),
    addedAt: Date.now()
  }
}

/** Build a client profile for a server the user already controls. Server-side peer enrollment is separate. */
export function createWireGuardProfile(input: { name: string; address: string; endpoint: string; serverPublicKey: string }): { profile: AwgProfile; clientPublicKey: string } {
  const fields = [input.name, input.address, input.endpoint, input.serverPublicKey]
  if (fields.some(v => typeof v !== 'string' || !v.trim() || v.length > 256 || /[\r\n]/.test(v))) throw new ConfError('Заполни данные сервера без переносов строк')
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64')
  const clientPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  const config = `[Interface]\nPrivateKey = ${secret}\nAddress = ${input.address.trim()}\n\n[Peer]\nPublicKey = ${input.serverPublicKey.trim()}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = ${input.endpoint.trim()}\nPersistentKeepalive = 25\n`
  const profile = parseConf(config, input.name.trim())
  profile.source = 'personal'
  profile.clientPublicKey = clientPublicKey
  return { profile, clientPublicKey }
}

export function detectVersion(a: AwgParams): string {
  if (a.header_protection_key || a.random_trailers || a.disable_cookies) return 'AmneziaWG 3'
  const ranged = [a.h1, a.h2, a.h3, a.h4].some(h => h && h.includes('-'))
  if (a.s3 !== undefined || a.s4 !== undefined || [a.i1, a.i2, a.i3, a.i4, a.i5].some(Boolean) || ranged) return 'AmneziaWG 2'
  if (NUM_KEYS.some(k => a[k] !== undefined) || [a.h1, a.h2, a.h3, a.h4].some(Boolean)) return 'AmneziaWG 1'
  return 'WireGuard'
}

export function redact(s: string): string {
  return s.replace(/[A-Za-z0-9+/]{42,44}={0,2}/g, m => m.slice(0, 4) + '…')
}

const GENERIC = /^(?:[a-z]:\\windows(?:\\(?:system32|syswow64))?|[a-z]:\\program files(?: \(x86\))?|[a-z]:\\users\\[^\\]+\\appdata\\(?:local|roaming)(?:\\programs)?|[a-z]:\\programdata|[a-z]:\\users\\[^\\]+\\desktop|[a-z]:\\users\\[^\\]+\\downloads|[a-z]:)\\?$/i

export function matchDirFor(exe: string): string | undefined {
  const parts = exe.split('\\')
  parts.pop()
  if (parts.length && /^app-\d/i.test(parts[parts.length - 1])) parts.pop()
  const dir = parts.join('\\')
  if (!dir || GENERIC.test(dir)) return undefined
  return dir
}

export function appRules(apps: Pick<AppPick, 'exe' | 'matchDir'>[]) {
  const exact: string[] = []
  const regex: string[] = []
  for (const a of apps) {
    const p = appPatterns({ exe: a.exe, matchDir: a.matchDir, wholeDir: !!a.matchDir })
    exact.push(...p.exact)
    regex.push(...p.regex.map(x => '(?i)' + x))
  }
  return { exact, regex }
}

export function splitCustom(items: string[]) {
  const domains: string[] = []
  const cidrs: string[] = []
  for (const raw of items) {
    const v = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, m => (/^\/\d{1,3}$/.test(m) ? m : ''))
    if (!v) continue
    if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) cidrs.push(v.includes('/') ? v : v + '/32')
    else if (v.includes(':') && /^[0-9a-f:]+(\/\d{1,3})?$/.test(v)) cidrs.push(v.includes('/') ? v : v + '/128')
    else domains.push(v.replace(/^\*\./, '').replace(/^\./, ''))
  }
  return { domains, cidrs }
}

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8', '224.0.0.0/4', '255.255.255.255/32', 'fc00::/7', 'fe80::/10']
const RU_DIRECT = ['ru', 'xn--p1ai', 'su', 'yandex.net', 'yastatic.net', 'vk.com', 'userapi.com', 'mail.ru', 'gosuslugi.ru', 'sberbank.ru', 'tinkoff.ru', 'tbank.ru', 'ozon.ru', 'wildberries.ru', 'avito.ru']

export interface BuildOpts {
  api: { port: number; secret: string }; selfExe?: string; /** R5 runtime Auto live pool */ autoLive?: readonly string[]
  /** HOTFIX-RUNTIME-01: every route (and the rest) goes through its own selector, so a later pick is a live selector switch */
  selectors?: boolean
  /** HOTFIX-RUNTIME-01: what the running core already has loaded; kept so a live-apply candidate never drops a loaded path */
  keep?: Loaded
  hostV6?: boolean
  slots?: Slots
  ruleDir?: string
  preload?: readonly string[]
  /** Keep complete groups over the warm private pool available for selector-only switches. */
  preloadGroups?: boolean
  diagnostic?: DiagnosticProxy
}

/** HOTFIX-RUNTIME-01: what one core run has loaded: profiles (ids, in profile order), live groups, fallback pairs */
export interface Loaded { profiles: string[]; groups: LiveGroup[]; fbs: FbGroup[]; slots?: Slots }

export interface Slots { app: string[]; dom: string[] }
const appPool = (s: Settings) => s.routes.filter(r => r.kind === 'app' && r.exe).map(r => r.id)
const domPool = (s: Settings) => [...s.routes.filter(r => r.kind === 'custom'), ...s.routes.filter(r => r.kind === 'list'), ...s.routes.filter(r => r.kind === 'preset')].map(r => r.id)
const room = (n: number) => Math.ceil((n + 12) / 8) * 8
const pad = (ids: string[], size: number) => [...ids, ...Array<string>(Math.max(0, size - ids.length)).fill('')]
const repack = (ids: string[], size: number) => (ids.length > size ? undefined : pad(ids, size))

function fit(ids: string[], prev: string[]): string[] | undefined {
  const out = prev.map(id => (ids.includes(id) ? id : ''))
  let last = -1
  for (let i = 0; i < ids.length; i++) {
    const at = out.indexOf(ids[i])
    if (at >= 0) { if (at <= last) return repack(ids, prev.length); last = at; continue }
    let next = out.length
    for (let j = i + 1; j < ids.length; j++) { const k = out.indexOf(ids[j]); if (k >= 0) { next = k; break } }
    let free = -1
    for (let k = last + 1; k < next; k++) if (!out[k]) { free = k; break }
    if (free < 0) return repack(ids, prev.length)
    out[free] = ids[i]
    last = free
  }
  return out
}

export function planSlots(s: Settings, prev?: Slots): Slots | undefined {
  if (!prev) { const a = appPool(s), d = domPool(s); return { app: pad(a, room(a.length)), dom: pad(d, room(d.length)) } }
  const active = new Set(s.routes.filter(r => r.on).map(r => r.id))
  const capacity = (ids: string[], pool: string[]) => {
    if (ids.length <= pool.length) return fit(ids, pool)
    // Library-only additions may outnumber the running pool. They must not force
    // a restart when the next action edits an unrelated active/global route.
    const needed = ids.filter(id => active.has(id))
    const inactive = new Set(pool.filter(id => id && !active.has(id) && ids.includes(id)).slice(0, Math.max(0, pool.length - needed.length)))
    return fit(ids.filter(id => active.has(id) || inactive.has(id)), pool)
  }
  const app = capacity(appPool(s), prev.app), dom = capacity(domPool(s), prev.dom)
  return app && dom ? { app, dom } : undefined
}

let listDomains: (id: string) => string[] = () => []
export function setListResolver(fn: (id: string) => string[]) { listDomains = fn }

export const CANARY_ZONE = 'waarp-check.invalid'
export const CANARY_IP = '127.0.0.9'
/** Keep canonical business files unchanged; only the watched copy carries its own reload witness. */
export function ruleFileWithWitness(body: string, name: string): string {
  const file = JSON.parse(body)
  if (file.version !== 3 || !Array.isArray(file.rules)) throw new Error('invalid rule file')
  return JSON.stringify({ version: 3, rules: [
    // Query type prevents this synthetic domain from becoming a traffic-routing match.
    { domain: [name], query_type: ['A'] },
    ...(file.rules.length ? [{ type: 'logical', mode: 'and', rules: [
      // A broad user suffix must not acknowledge a witness belonging to another file.
      { domain_suffix: [CANARY_ZONE], invert: true },
      ...(file.rules.length === 1 ? file.rules : [{ type: 'logical', mode: 'or', rules: file.rules }])
    ] }] : [])
  ] })
}
export const ruleFileOf = (tag: string) => tag.replace(/[^\w.-]/g, '_') + '.json'
const ENGINE_LOG = /^(trace|debug|info|warn|error)$/.test(process.env.WAARP_ENGINE_LOG ?? '') ? process.env.WAARP_ENGINE_LOG! : 'warn'
const VPN_CLIENT_DIRS = ['(?i)\\\\(?:ExitLag|WireGuard|AmneziaVPN|AmneziaWG|OpenVPN|OpenVPN Connect|Outline|Cloudflare WARP|Mullvad VPN|NordVPN|ProtonVPN|Proton\\\\VPN|Tailscale|ZeroTier|Hiddify|v2rayN|nekoray|Throne|Radmin VPN|LogMeIn Hamachi|WireSock[^\\\\]*)\\\\']
/** the per-route selector of a route card; the rest has its own */
export const routeSel = (id: string) => 'rt-' + id
export const REST_SEL = 'rest-sel'
export const isRouteSel = (tag: unknown) => typeof tag === 'string' && (tag.startsWith('rt-') || tag === REST_SEL)

export const tagOf = (id: string) => 'p-' + id

export function activeRoutes(s: Settings) {
  return s.routes.filter(r => r.on)
}

/** profiles a plan needs live. `autoLive` = runtime (bounded Auto pool); omitted = logical (every Auto candidate) */
export function usedProfiles(s: Settings, profiles: Profile[], opts: { autoLive?: readonly string[] } = {}): Profile[] {
  const plan = compilePlan(s, profiles, opts)
  const ids = new Set(planProfileIds(plan))
  return profiles.filter(p => !p.revoked && ids.has(p.id))
}

/** the same settings with every Auto reference switched off: what explicit routing alone needs */
export const withoutAuto = (s: Settings): Settings => ({ ...s, rest: s.rest === AUTO_ID ? 'direct' : s.rest, routes: s.routes.map(r => (r.via === AUTO_ID ? { ...r, on: false } : r.fallback === AUTO_ID ? { ...r, fallback: undefined } : r)) })

/** R5: the runtime Auto live pool for these settings (explicitly required profiles are live anyway, at no extra cost) */
export const runtimeAutoLive = (s: Settings, profiles: Profile[], prev?: string): string[] =>
  autoLivePool(profiles, usedProfiles(withoutAuto(s), profiles).map(p => p.id), prev)

export const selTag = (via: Via, fb: Via) => 'sel-' + via + '-' + fb

export interface FbGroup { tag: string; main: Via; fb: Via }

function validFb(r: Route, known: Set<string>): Via | undefined {
  const f = r.fallback
  if (!f || f === 'direct' || r.via === 'direct' || f === r.via) return undefined
  return known.has(r.via) && known.has(f) ? f : undefined
}

/** prefer the `keep` order (the running core), then the newly needed ones; a still-needed entry uses its new definition */
function mergeKept<T>(fresh: T[], kept: T[] | undefined, key: (x: T) => string): T[] {
  if (!kept) return fresh
  const f = new Map(fresh.map(x => [key(x), x]))
  return [...kept.map(x => f.get(key(x)) ?? x), ...fresh.filter(x => !kept.some(k => key(k) === key(x)))]
}

/** the loaded sets of a build (profiles, live groups, fallback pairs); one source for buildConfig and the engine */
export function loadedSets(profiles: Profile[], given: Settings, o: Pick<BuildOpts, 'autoLive' | 'keep' | 'preload' | 'preloadGroups'> = {}): { used: Profile[]; lg: LiveGroup[]; fbs: FbGroup[] } {
  const live = { autoLive: o.autoLive }
  const s = withAuto(given, profiles, o.autoLive)
  const base = new Set(usedProfiles(given, profiles, live).map(p => p.id))
  const kept = new Set([...(o.keep?.profiles ?? []), ...(o.preload ?? [])])
  const selected = profiles.filter(p => !p.revoked && (base.has(p.id) || kept.has(p.id)))
  const byId = new Map(selected.map(p => [p.id, p]))
  // Library reorder/name changes do not change the identity/order of loaded core
  // objects. Changed credentials still use the fresh definition and require reload.
  const used = mergeKept(selected, o.keep?.profiles.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), p => p.id)
  const have = new Set(used.map(p => p.id))
  const activeGroups = liveGroups(s, new Set(profiles.filter(p => !p.revoked).map(p => p.id)))
  const allGroups = o.preloadGroups ? liveGroups(withAuto({ ...given, rest: AUTO_ID }, profiles, o.autoLive),
    new Set(profiles.filter(p => !p.revoked).map(p => p.id)), true).filter(g => g.members.every(m => have.has(m))) : []
  const warmGroups = allGroups.filter(g => !activeGroups.some(a => a.id === g.id))
  const lg = mergeKept([...activeGroups, ...warmGroups], o.keep?.groups.filter(g => g.members.every(m => have.has(m))), g => g.id)
  const fbs = mergeKept(fallbackGroups(profiles, given, live), o.keep?.fbs.filter(g => have.has(g.main) && have.has(g.fb)), g => g.tag)
  return { used, lg, fbs }
}
export const loadedOf = (sets: ReturnType<typeof loadedSets>): Loaded => ({ profiles: sets.used.map(p => p.id), groups: sets.lg, fbs: sets.fbs })

type Cfg = ReturnType<typeof buildConfig>
type Obj = Record<string, unknown>
/** HOTFIX-RUNTIME-01: the selector switches that turn `prev` into `next`, or undefined when anything else differs (restart) */
export function liveSwitches(prev: Cfg, next: Cfg): { tag: string; to: string }[] | undefined {
  const strip = (c: Cfg) => JSON.stringify({ ...c, outbounds: c.outbounds.map((x: Obj) => (isRouteSel(x.tag) ? { ...x, default: undefined } : x)) })
  if (strip(prev) !== strip(next)) return undefined
  const was = new Map(prev.outbounds.filter((x: Obj) => isRouteSel(x.tag)).map((x: Obj) => [x.tag, x.default]))
  return next.outbounds.filter((x: Obj) => isRouteSel(x.tag) && was.get(x.tag) !== x.default).map((x: Obj) => ({ tag: String(x.tag), to: String(x.default) }))
}

export function fallbackGroups(profiles: Profile[], s: Settings, opts: { autoLive?: readonly string[] } = {}): FbGroup[] {
  const known = new Set(usedProfiles(s, profiles, opts).map(p => p.id))
  const m = new Map<string, FbGroup>()
  for (const r of activeRoutes(s)) {
    const fb = validFb(r, known)
    if (fb) m.set(selTag(r.via, fb), { tag: selTag(r.via, fb), main: r.via, fb })
  }
  return [...m.values()]
}

export function endpoint(p: AwgProfile) {
  const ep: Record<string, unknown> = {
    type: 'wireguard',
    tag: tagOf(p.id),
    mtu: p.mtu ?? 1280,
    address: p.address,
    private_key: p.privateKey,
    ...(p.listenPort !== undefined ? { listen_port: p.listenPort } : {}),
    peers: [{
      address: p.peer.host,
      port: p.peer.port,
      public_key: p.peer.publicKey,
      ...(p.peer.presharedKey ? { pre_shared_key: p.peer.presharedKey } : {}),
      // Old encrypted profiles did not retain this field; preserve their former behavior until re-imported.
      allowed_ips: p.peer.allowedIPs ?? ['0.0.0.0/0', '::/0'],
      persistent_keepalive_interval: p.peer.keepalive ?? 0
    }]
  }
  for (const [k, v] of Object.entries(p.awg)) {
    if (v === undefined) continue
    ep[k] = /^h[1-4]$/.test(k) && typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  }
  return ep
}

function group<T>(items: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>()
  for (const x of items) { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]) }
  return m
}

export function routeTargets(r: Route) {
  if (r.kind === 'custom') return splitCustom([r.value ?? ''])
  if (r.kind === 'list') return { domains: listDomains(r.list ?? ''), cidrs: [] }
  if (r.kind === 'preset') {
    const p = PRESETS.find(x => x.id === r.preset)
    return { domains: p?.domains ?? [], cidrs: p?.cidrs ?? [] }
  }
  return { domains: [], cidrs: [] }
}

/** marker for a missing target; compiled to a reject rule action (sing-box >= 1.11 has no block outbound) */
export const BLOCK = '__block'
export function blockRules(rules: Record<string, unknown>[]) {
  return rules.map(r => (r.outbound === BLOCK ? (({ outbound: _o, ...m }) => ({ ...m, action: 'reject' }))(r) : r))
}

export function buildConfig(profiles: Profile[], given: Settings, o: BuildOpts) {
  return buildRuntime(profiles, given, o).cfg
}

export function buildRuntime(profiles: Profile[], given: Settings, o: BuildOpts) {
  const s = withAuto(given, profiles, o.autoLive)
  const { used, lg, fbs } = loadedSets(profiles, given, o)
  const known = new Set(used.map(p => p.id))
  // R5: a fallback pointing at Auto resolves through the same bounded pool
  const knownG = new Set(lg.map(g => g.id))
  // C03: a target that is not direct and not a known tunnel/group is BLOCKED, never silently direct
  const out = (v: Via) => (v === 'direct' ? 'direct' : knownG.has(v) ? grpTag(v) : known.has(v) ? tagOf(v) : BLOCK)
  const dnsOf = (v: Via) => (v === 'direct' ? 'local' : knownG.has(v) || known.has(v) ? 'dns-' + v : BLOCK)
  const outR = (r: Route) => { const f = validFb(r, known); return f ? selTag(r.via, f) : out(r.via) }
  const dnsR = (r: Route) => { const f = validFb(r, known); return f ? 'dns-' + selTag(r.via, f) : dnsOf(r.via) }
  const rest = out(s.rest)
  const DIRECT = 'direct'
  const act = activeRoutes(s)
  // HOTFIX-RUNTIME-01 selector layer: one selector per route over everything this core has loaded; BLOCK stays a reject rule
  const loadedTags = [DIRECT, ...used.map(p => tagOf(p.id)), ...lg.map(g => grpTag(g.id)), ...fbs.map(g => g.tag)]
  const diagnostic = diagnosticConfig(o.diagnostic, [DIRECT, ...used.map(p => tagOf(p.id))])
  const sels: Record<string, unknown>[] = []
  const routeDns: { tag: string; from: string; detour: string }[] = []
  const via = (sel: string, target: string) => {
    if (!o.selectors || target === BLOCK) return target
    sels.push({ type: 'selector', tag: sel, outbounds: loadedTags, default: target, interrupt_exist_connections: true })
    return sel
  }
  const viaDns = (sel: string, dns: string) => {
    if (!o.selectors || dns === BLOCK || dns === 'local') return dns
    routeDns.push({ tag: 'dns-' + sel, from: dns, detour: sel })
    return 'dns-' + sel
  }
  // HOTFIX-RUNTIME-01 G: IPv6 capability per path, from the imported profile only (never invented). AWG = has an IPv6
  // interface address and an IPv6 AllowedIPs prefix; OpenVPN = unknown until the server pushes it -> treated as IPv4-only; proxies (VLESS/out) carry IPv6
  // to their server. A group is capable only if every loaded member is (the live pick may move). IPv6 to a path that cannot
  // carry it is rejected (fail closed), never sent Direct; hostname traffic keeps the IPv4-first DNS.
  const v6p = (p: Profile) => (p.kind === 'awg'
    ? p.address.some(a => a.includes(':')) && (!p.peer.allowedIPs || p.peer.allowedIPs.some(a => a.includes(':')))
    : p.kind === 'out' && p.outbound.type === 'masque'
      ? typeof p.outbound.ipv6 === 'string' && p.outbound.ipv6.includes(':')
      : p.kind !== 'openvpn')
  const v6id = (id: string) => { const p = used.find(x => x.id === id); return !!p && v6p(p) }
  const v6 = (tag: string): boolean => {
    if (tag === DIRECT) return o.hostV6 !== false
    const g = lg.find(x => grpTag(x.id) === tag)
    if (g) return g.members.every(v6id)
    const f = fbs.find(x => x.tag === tag)
    if (f) return v6id(f.main) && v6id(f.fb)
    return tag.startsWith('p-') ? v6id(tag.slice(2)) : true
  }
  const noV6 = (m: Record<string, unknown>, target: string) => (target !== BLOCK && !v6(target) ? [{ ...m, ip_version: 6, action: 'reject' }] : [])
  // with selectors every route keeps its own rule (its own switch); without, routes sharing a target share a rule
  const byTarget = (list: Route[]) => (o.selectors ? new Map(list.map(r => [routeSel(r.id), [r]])) : group(list, outR))
  const targetOf = (key: string, list: Route[]) => (o.selectors ? via(key, outR(list[0])) : key)

  const rules: Record<string, unknown>[] = [
    ...diagnostic.rules,
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    // R1.1: Waarp's own TUN service pair never goes direct (direct -> TUN recursion); before the private/LAN rule
    serviceGuardRule()
  ]
  if (s.lanDirect) rules.push({ ip_is_private: true, outbound: DIRECT })
  if (o.selfExe) rules.push({ process_path: [o.selfExe], outbound: DIRECT })
  const dnsRules: Record<string, unknown>[] = []
  const slotMode = !!(o.selectors && o.slots)
  const files: Record<string, string> = {}
  const sets: string[] = []
  // HOTFIX-RUNTIME-01 C: "Russian sites direct" is a global bypass: it wins over app and card routes, and its DNS stays local first
  if (s.ruDirect && !slotMode) {
    rules.push({ domain_suffix: RU_DIRECT, outbound: DIRECT })
    dnsRules.push({ domain_suffix: RU_DIRECT, server: 'local' })
  }

  if (slotMode) {
    const set = (tag: string, list: Record<string, unknown>[]) => { sets.push(tag); files[tag] = JSON.stringify({ version: 3, rules: list }) }
    // A selector and its DNS/IPv6 rules are separate native objects. During a
    // transaction reject only the edited matches until all watchers acknowledge
    // their generation. Existing unrelated connections are left alone.
    set('apply-guard', [])
    rules.push({ rule_set: ['apply-guard'], action: 'reject' })
    dnsRules.push({ rule_set: ['apply-guard'], rule_set_ip_cidr_match_source: true, action: 'reject' })
    set('bypass-ru', s.ruDirect ? [{ domain_suffix: RU_DIRECT }] : [])
    rules.push({ rule_set: ['bypass-ru'], outbound: DIRECT })
    dnsRules.push({ rule_set: ['bypass-ru'], server: 'local' })
    const appSet = (r: Route): Record<string, unknown>[] => {
      const p = appPatterns(r)
      const m: Record<string, unknown> = {}
      if (p.exact.length) m.process_path = p.exact
      if (p.regex.length) m.process_path_regex = p.regex.map(x => '(?i)' + x)
      return Object.keys(m).length ? [m] : []
    }
    const domSet = (r: Route, ip: boolean): Record<string, unknown>[] => {
      const t = routeTargets(r)
      const d = [...new Set(t.domains)], c = [...new Set(t.cidrs)]
      return [...(d.length ? [{ domain_suffix: d }] : []), ...(ip && c.length ? [{ ip_cidr: c }] : [])]
    }
    const dnsKey = (t: string) => (t === BLOCK ? 'dn-block' : t === DIRECT ? 'dn-direct' : 'dn-' + t)
    const buckets = new Map<string, Record<string, unknown>[]>([['dn-block', []], ['dn-direct', []], ...loadedTags.filter(t => t !== DIRECT).map((t): [string, Record<string, unknown>[]] => ['dn-' + t, []])])
    const earlierApps: { target: string; matches: Record<string, unknown>[] }[] = []
    const dnsPriority = new DnsPriority()
    for (const [p, list] of [['a', o.slots!.app], ['d', o.slots!.dom]] as const) {
      list.forEach((id, i) => {
        const n = p + i
        const r = id ? act.find(x => x.id === id) : undefined
        const t = r ? outR(r) : DIRECT
        const m = r ? (r.kind === 'app' ? appSet(r) : domSet(r, true)) : []
        set('r' + n, t === BLOCK ? [] : m)
        set('f' + n, t === DIRECT && r?.dpi === true ? m : [])
        set('x' + n, t === BLOCK ? m : [])
        set('v' + n, t !== BLOCK && !v6(t) ? m : [])
        if (r) {
          const domainMatch = r.kind === 'app' ? undefined : dnsPriority.claim(routeTargets(r).domains, t)
          const matches = r.kind === 'app' ? appSet(r) : domainMatch!.domains.length ? [{ domain_suffix: domainMatch!.domains }] : []
          const earlierOther = [...earlierApps.filter(entry => entry.target !== t).flatMap(entry => entry.matches),
            ...(domainMatch?.excludes.length ? [{ domain_suffix: domainMatch.excludes }] : [])]
          // Profile buckets have a stable native order. Preserve the card order
          // inside them, so overlapping cards cannot send DNS through another
          // tunnel merely because that profile was imported earlier.
          buckets.get(dnsKey(t))?.push(...(!matches.length ? [] : !earlierOther.length ? matches : [{
            type: 'logical', mode: 'and', rules: [
              ...(matches.length === 1 ? matches : [{ type: 'logical', mode: 'or', rules: matches }]),
              { type: 'logical', mode: 'or', rules: earlierOther, invert: true }
            ]
          }]))
          if (r.kind === 'app') earlierApps.push({ target: t, matches })
        }
        sels.push({ type: 'selector', tag: 'rt-' + n, outbounds: loadedTags, default: t === BLOCK ? DIRECT : t, interrupt_exist_connections: true })
        rules.push({ rule_set: ['x' + n], action: 'reject' }, { ip_version: 6, rule_set: ['v' + n], action: 'reject' },
          { rule_set: ['f' + n], network: 'udp', port: 443, action: 'reject' }, { rule_set: ['f' + n], action: 'route', outbound: 'rt-' + n, tls_record_fragment: true },
          { rule_set: ['r' + n], outbound: 'rt-' + n })
      })
    }
    for (const [tag, list] of buckets) set(tag, list)
    dnsRules.push({ rule_set: ['dn-block'], action: 'reject' }, { rule_set: ['dn-direct'], server: 'local' })
    for (const p of used) dnsRules.push({ rule_set: ['dn-' + tagOf(p.id)], server: 'dns-' + p.id })
    for (const g of lg) dnsRules.push({ rule_set: ['dn-' + grpTag(g.id)], server: 'dns-' + g.id })
    for (const g of fbs) dnsRules.push({ rule_set: ['dn-' + g.tag], server: 'dns-' + g.tag })
  }

  // Explicit application intent wins before broader destination/service rules.
  if (!slotMode) for (const [key, list] of byTarget(act.filter(r => r.kind === 'app' && r.exe))) {
    const tag = targetOf(key, list)
    const { exact, regex } = appRules(list.map(r => ({ exe: r.exe!, matchDir: r.wholeDir === true ? r.matchDir : undefined })))
    const m: Record<string, unknown> = {}
    if (exact.length) m.process_path = exact
    if (regex.length) m.process_path_regex = regex
    rules.push(...noV6(m, o.selectors ? outR(list[0]) : key), { ...m, outbound: tag })
  }
  if (!slotMode) for (const kind of ['custom', 'list', 'preset'] as const) {
    for (const [key, list] of byTarget(act.filter(r => r.kind === kind))) {
      const tag = targetOf(key, list)
      const t = list.map(routeTargets)
      const domains = [...new Set(t.flatMap(x => x.domains))]
      const cidrs = [...new Set(t.flatMap(x => x.cidrs))]
      const raw = o.selectors ? outR(list[0]) : key
      if (domains.length) rules.push(...noV6({ domain_suffix: domains }, raw), { domain_suffix: domains, outbound: tag })
      if (cidrs.length) rules.push(...noV6({ ip_cidr: cidrs }, raw), { ip_cidr: cidrs, outbound: tag })
      const dns = o.selectors ? viaDns(key, dnsR(list[0])) : dnsR(list[0])
      if (domains.length && dns === BLOCK) dnsRules.push({ domain_suffix: domains, action: 'reject' })
      else if (domains.length) dnsRules.push({ domain_suffix: domains, server: dns })
    }
  }
  if (rest === BLOCK && !slotMode) dnsRules.push({ action: 'reject' })
  // G: everything else over an IPv4-only rest path: IPv6 is rejected, not leaked Direct
  if (slotMode) {
    const append = (tag: string, body: Record<string, unknown>[]) => {
      sets.push(tag); files[tag] = JSON.stringify({ version: 3, rules: body })
    }
    append('rest-v6', rest !== BLOCK && !v6(rest) ? [{ network: ['tcp', 'udp'] }] : [])
    append('rest-block', rest === BLOCK ? [{ network: ['tcp', 'udp'] }] : [])
    rules.push({ ip_version: 6, rule_set: ['rest-v6'], action: 'reject' },
      { rule_set: ['rest-block'], action: 'reject' })
    for (const target of [BLOCK, ...loadedTags]) {
      const name = 'rest-dns-' + target
      append(name, rest === target ? [{ domain_regex: ['.*'] }] : [])
      if (target === BLOCK) dnsRules.push({ rule_set: [name], action: 'reject' })
      else dnsRules.push({ rule_set: [name], server: target === DIRECT ? 'local'
        : target.startsWith('p-') ? 'dns-' + target.slice(2)
        : target.startsWith('grp-') ? 'dns-' + target.slice(4) : 'dns-' + target })
    }
  } else rules.push(...noV6({}, rest))
  rules.push({ process_path_regex: VPN_CLIENT_DIRS, outbound: DIRECT })

  // Card-only mode has no single tunnel that can honestly own global DNS.
  // Keep DNS local until the UI offers an explicit DNS route instead of choosing used[0].
  const dnsFinal = !slotMode && rest !== DIRECT && rest !== BLOCK ? viaDns(REST_SEL, dnsOf(s.rest)) : 'local'
  const final = slotMode ? via(REST_SEL, rest === BLOCK ? DIRECT : rest) : rest === BLOCK ? DIRECT : via(REST_SEL, rest)

  const dnsServers: Record<string, unknown>[] = [{ type: 'local', tag: 'local' }]
  // WireGuard Interface DNS entries are ordinary DNS servers, not implicit DoH endpoints.
  // Keep private/team resolvers as supplied and send their queries through the selected tunnel.
  const resolver = (p: Profile) => {
    const imported = p.kind === 'awg' ? p.dns.find(d => isIP(d) !== 0) : undefined
    return imported ? { type: 'udp', server: imported, server_port: 53 } : { type: 'https', server: '1.1.1.1' }
  }
  const groupResolver = (members: string[]) => {
    const resolvers = members.map(id => resolver(used.find(p => p.id === id)!))
    const same = resolvers.length > 0 && resolvers.every(r => JSON.stringify(r) === JSON.stringify(resolvers[0]))
    // A private resolver belonging to one provider cannot be assumed reachable through another provider.
    return same ? resolvers[0] : { type: 'https', server: '1.1.1.1' }
  }
  for (const p of used) dnsServers.push({ ...resolver(p), tag: 'dns-' + p.id, detour: tagOf(p.id) })
  for (const g of lg) dnsServers.push({ ...groupResolver(g.members), tag: 'dns-' + g.id, detour: grpTag(g.id) })
  for (const g of fbs) dnsServers.push({ ...groupResolver([g.main, g.fb]), tag: 'dns-' + g.tag, detour: g.tag })
  // a route's DNS follows the route's own selector: the same resolver as its target, detour = the route switch
  for (const d of routeDns) dnsServers.push({ ...dnsServers.find(x => x.tag === d.from)!, tag: d.tag, detour: d.detour })

  if (slotMode) dnsRules.unshift(
    { type: 'logical', mode: 'and', rules: [
      { domain_suffix: [CANARY_ZONE] },
      // The controller query has no source IP. CIDR branches cannot become a
      // deferred destination match or switch the pinned core's DNS rule mode.
      { rule_set: sets, rule_set_ip_cidr_match_source: true }
    ], action: 'predefined', rcode: 'NOERROR', answer: [`${CANARY_ZONE}. IN A ${CANARY_IP}`] },
    // Unloaded witnesses terminate locally, without a resolver or negative cache.
    { domain_suffix: [CANARY_ZONE], action: 'predefined', rcode: 'NXDOMAIN' }
  )
  const ruleSets = slotMode ? sets.map(tag => ({ type: 'local', tag, format: 'source', path: join(o.ruleDir ?? '.', ruleFileOf(tag)) })) : []
  const cfg = {
    log: { level: ENGINE_LOG, timestamp: true },
    dns: { servers: dnsServers, rules: dnsRules, final: dnsFinal, strategy: 'ipv4_only' },
    inbounds: [...diagnostic.inbounds, {
      type: 'tun',
      tag: 'tun',
      interface_name: TUN.name,
      // Dual-stack TUN keeps literal IPv6 and existing IPv6-capable apps inside the same policy.
      // DNS remains IPv4-first until each provider advertises verified IPv6 capability.
      address: [...TUN_ADDRESSES],
      mtu: 1400,
      auto_route: true,
      // The pinned core exempts itself from its temporary DNS filter. This is not a persistent kill switch.
      strict_route: true,
      stack: 'mixed',
      ...(s.lanDirect ? { route_exclude_address: PRIVATE } : {})
    }],
    endpoints: used.flatMap(p => (p.kind === 'awg' ? [endpoint(p)] : p.kind === 'openvpn' ? [{ ...p.endpoint, tag: tagOf(p.id) }] : [])),
    outbounds: [
      { type: 'direct', tag: DIRECT },
      ...diagnostic.outbounds,
      ...used.flatMap(p => (p.kind === 'vless' ? [vlessOutbound(p, tagOf(p.id))] : p.kind === 'out' ? [{ ...p.outbound, tag: tagOf(p.id) }] : [])),
      // every group is a selector driven by Waarp's own probe rounds (engine.groupStep): no urltest ping-chasing (W2.2).
      // A failed path must release old TCP/UDP sessions. The controller holds healthy paths while traffic is active.
      ...lg.map(g => ({ type: 'selector', tag: grpTag(g.id), outbounds: g.members.map(tagOf), default: tagOf(g.members[0]), interrupt_exist_connections: true })),
      ...fbs.map(g => ({ type: 'selector', tag: g.tag, outbounds: [tagOf(g.main), tagOf(g.fb)], default: tagOf(g.main), interrupt_exist_connections: true })),
      ...sels
    ],
    route: { ...(ruleSets.length ? { rule_set: ruleSets } : {}), rules: blockRules(rest === BLOCK && !slotMode ? [...rules, { network: ['tcp', 'udp'], outbound: BLOCK }] : rules), final, auto_detect_interface: true, find_process: true, default_domain_resolver: 'local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${o.api.port}`, secret: o.api.secret } }
  }
  return { cfg, files }
}

/** WRP-013 local checker config: no inbound, no TUN, userspace WireGuard, clash API on localhost only.
 *  Lets Waarp measure every tunnel (urltest / site probe) while the system tunnel is closed. */
export function checkConfig(profiles: Profile[], api: { port: number; secret: string }, proxy?: DiagnosticProxy) {
  const active = profiles.filter(p => !p.revoked)
  const diagnostic = diagnosticConfig(proxy, ['direct', ...active.map(p => tagOf(p.id))])
  return {
    log: { level: 'warn', timestamp: false },
    // Endpoint bootstrap and probe target names use an explicit local resolver, matching main's
    // bootstrap policy. IPv4-only AWG clients must not be judged by an unrouteable AAAA candidate.
    dns: { servers: [{ type: 'local', tag: 'local' }], final: 'local', strategy: 'ipv4_only' },
    ...(proxy ? { inbounds: diagnostic.inbounds } : {}),
    endpoints: active.flatMap((p): Record<string, unknown>[] => (p.kind === 'awg' ? [{ ...endpoint(p), system: false }] : p.kind === 'openvpn' ? [{ ...p.endpoint, tag: tagOf(p.id) }] : [])),
    outbounds: [{ type: 'direct', tag: 'direct' }, ...diagnostic.outbounds, ...active.flatMap(p => (p.kind === 'vless' ? [vlessOutbound(p, tagOf(p.id))] : p.kind === 'out' ? [{ ...p.outbound, tag: tagOf(p.id) }] : []))],
    route: { ...(proxy ? { rules: diagnostic.rules } : {}), final: 'direct', default_domain_resolver: 'local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${api.port}`, secret: api.secret } }
  }
}
