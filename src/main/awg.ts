import { inflateSync } from 'node:zlib'
import { generateKeyPairSync } from 'node:crypto'
import { isIP } from 'node:net'
import type { AppPick, AwgParams, AwgProfile, Profile, Route, Settings, Via } from '../shared/types'
import { PRESETS } from '../shared/presets'
import { ConfError } from './conf-error'
import { vlessOutbound } from './vless'
import { AUTO_ID, autoLivePool, grpTag, liveGroups, withAuto, type LiveGroup } from '../shared/groups'
import { compilePlan, planProfileIds } from '../shared/plan'
import { validateCustom } from '../shared/route-validation'
import { serviceGuardRule, TUN, TUN_ADDRESSES } from './tun'

export { validateCustom } from '../shared/route-validation'

const NUM_KEYS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'] as const
const STR_KEYS = ['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5'] as const

export { ConfError }

export function unwrapKey(input: string): string {
  const text = input.trim()
  if (/\[Interface\]/i.test(text)) return text
  const m = text.match(/^vpn:\/\/(.+)$/s)
  if (!m) throw new ConfError('Это не похоже на конфиг AmneziaWG. Нужен .conf или ключ vpn://')
  const b64 = m[1].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64')
  let json: string
  try {
    json = inflateSync(buf.subarray(4)).toString('utf8')
  } catch {
    try { json = inflateSync(buf).toString('utf8') } catch { json = buf.toString('utf8') }
  }
  let data: unknown
  try { data = JSON.parse(json) } catch { throw new ConfError('Ключ vpn:// не читается. Экспортируй из AmneziaVPN «нативный формат AmneziaWG» (.conf)') }
  const found = findConf(data)
  if (!found) throw new ConfError('В ключе нет конфига AmneziaWG. Экспортируй из AmneziaVPN файл .conf')
  return found
}

function findConf(v: unknown): string | undefined {
  if (typeof v === 'string') {
    if (v.trimStart().startsWith('{')) { try { return findConf(JSON.parse(v)) } catch {} }
    return /\[Interface\]/i.test(v) ? v : undefined
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const r = findConf(x)
      if (r) return r
    }
  }
  return undefined
}

export function parseConf(raw: string, name = 'Сервер'): AwgProfile {
  name = String(name).trim().slice(0, 80) || 'Сервер'
  const text = unwrapKey(raw)
  const sec: Record<string, Record<string, string>> = {}
  let cur = ''
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const h = line.match(/^\[(\w+)\]$/)
    if (h) {
      cur = h[1].toLowerCase()
      if (sec[cur]) cur = cur + '#'
      sec[cur] ??= {}
      continue
    }
    const kv = line.match(/^([A-Za-z0-9]+)\s*=\s*(.*)$/)
    if (kv && cur) sec[cur][kv[1].toLowerCase()] = kv[2].trim()
  }
  const i = sec['interface'], p = sec['peer']
  if (!i || !p) throw new ConfError('В конфиге нет [Interface] или [Peer]')
  if (sec['peer#']) throw new ConfError('В одном туннеле Waarp поддерживается один [Peer]; раздели конфиг на отдельные туннели')
  const commands = ['preup', 'postup', 'predown', 'postdown', 'table'].filter(k => i[k] !== undefined)
  if (commands.length) throw new ConfError(`Waarp не выполняет системные директивы из конфига: ${commands.join(', ')}`)
  if (!i.privatekey) throw new ConfError('В конфиге нет PrivateKey')
  if (!p.publickey) throw new ConfError('В конфиге нет PublicKey сервера')
  if (!p.endpoint) throw new ConfError('В конфиге нет Endpoint сервера')
  const validKey = (key: string) => /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32
  if (!validKey(i.privatekey)) throw new ConfError('PrivateKey должен быть ключом WireGuard (32 байта, base64)')
  if (!validKey(p.publickey)) throw new ConfError('PublicKey сервера должен быть ключом WireGuard (32 байта, base64)')
  if (p.presharedkey && !validKey(p.presharedkey)) throw new ConfError('PresharedKey должен быть ключом WireGuard (32 байта, base64)')
  const ep = p.endpoint.match(/^\[?([^\]]+?)\]?:(\d+)$/)
  if (!ep) throw new ConfError('Endpoint должен быть вида host:port')
  const port = Number(ep[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfError('Порт Endpoint должен быть от 1 до 65535')
  const list = (s?: string) => (s ?? '').split(',').map(x => x.trim()).filter(Boolean)
  const address = list(i.address).map(a => (a.includes('/') ? a : a.includes(':') ? a + '/128' : a + '/32'))
  if (!address.length) throw new ConfError('В конфиге нет Address')
  for (const addr of address) {
    const [ip, prefix] = addr.split('/')
    const family = isIP(ip)
    if (!family || !/^\d+$/.test(prefix ?? '') || Number(prefix) > (family === 4 ? 32 : 128)) throw new ConfError('Address должен содержать корректный IP и маску')
  }
  const awg: AwgParams = {}
  for (const k of NUM_KEYS) if (i[k] !== undefined && i[k] !== '') {
    const n = Number(i[k])
    if (!Number.isFinite(n)) throw new ConfError(`Параметр ${k.toUpperCase()} должен быть числом`)
    awg[k] = n
  }
  for (const k of STR_KEYS) if (i[k]) awg[k] = i[k]
  const mtu = i.mtu ? Number(i.mtu) : undefined
  if (mtu !== undefined && (!Number.isInteger(mtu) || mtu < 576 || mtu > 9000)) throw new ConfError('MTU должен быть целым числом от 576 до 9000')
  const keepalive = p.persistentkeepalive ? Number(p.persistentkeepalive) : undefined
  if (keepalive !== undefined && (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535)) throw new ConfError('PersistentKeepalive должен быть целым числом от 0 до 65535')
  return {
    kind: 'awg',
    id: Math.random().toString(36).slice(2, 10),
    name,
    address,
    privateKey: i.privatekey,
    dns: list(i.dns),
    mtu: mtu && Number.isFinite(mtu) ? mtu : undefined,
    awg,
    peer: {
      publicKey: p.publickey,
      presharedKey: p.presharedkey || undefined,
      host: ep[1],
      port,
      keepalive
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
  const ranged = [a.h1, a.h2, a.h3, a.h4].some(h => h && h.includes('-'))
  if (a.s3 !== undefined || a.s4 !== undefined || a.i1 || ranged) return 'AmneziaWG 2'
  if (a.jc !== undefined || a.h1) return 'AmneziaWG 1'
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

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function appRules(apps: Pick<AppPick, 'exe' | 'matchDir'>[]) {
  const exact: string[] = []
  const regex: string[] = []
  for (const a of apps) {
    if (a.matchDir) regex.push('(?i)^' + reEsc(a.matchDir) + '\\\\')
    else exact.push(a.exe)
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
}

/** HOTFIX-RUNTIME-01: what one core run has loaded: profiles (ids, in profile order), live groups, fallback pairs */
export interface Loaded { profiles: string[]; groups: LiveGroup[]; fbs: FbGroup[] }
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
export function loadedSets(profiles: Profile[], given: Settings, o: Pick<BuildOpts, 'autoLive' | 'keep'> = {}): { used: Profile[]; lg: LiveGroup[]; fbs: FbGroup[] } {
  const live = { autoLive: o.autoLive }
  const s = withAuto(given, profiles, o.autoLive)
  const base = new Set(usedProfiles(given, profiles, live).map(p => p.id))
  const kept = new Set(o.keep?.profiles ?? [])
  const used = profiles.filter(p => !p.revoked && (base.has(p.id) || kept.has(p.id)))
  const have = new Set(used.map(p => p.id))
  const lg = mergeKept(liveGroups(s, new Set(profiles.filter(p => !p.revoked).map(p => p.id))), o.keep?.groups.filter(g => g.members.every(m => have.has(m))), g => g.id)
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
    peers: [{
      address: p.peer.host,
      port: p.peer.port,
      public_key: p.peer.publicKey,
      ...(p.peer.presharedKey ? { pre_shared_key: p.peer.presharedKey } : {}),
      allowed_ips: ['0.0.0.0/0', '::/0'],
      persistent_keepalive_interval: p.peer.keepalive ?? 25
    }]
  }
  for (const [k, v] of Object.entries(p.awg)) {
    if (v === undefined) continue
    ep[k] = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
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
  // interface address; OpenVPN = unknown until the server pushes it -> treated as IPv4-only; proxies (VLESS/out) carry IPv6
  // to their server. A group is capable only if every loaded member is (the live pick may move). IPv6 to a path that cannot
  // carry it is rejected (fail closed), never sent Direct; hostname traffic keeps the IPv4-first DNS.
  const v6p = (p: Profile) => (p.kind === 'awg' ? p.address.some(a => a.includes(':')) : p.kind !== 'openvpn')
  const v6id = (id: string) => { const p = used.find(x => x.id === id); return !!p && v6p(p) }
  const v6 = (tag: string): boolean => {
    if (tag === DIRECT) return true
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
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    // R1.1: Waarp's own TUN service pair never goes direct (direct -> TUN recursion); before the private/LAN rule
    serviceGuardRule()
  ]
  if (s.lanDirect) rules.push({ ip_is_private: true, outbound: DIRECT })
  if (o.selfExe) rules.push({ process_path: [o.selfExe], outbound: DIRECT })
  const dnsRules: Record<string, unknown>[] = []
  // HOTFIX-RUNTIME-01 C: "Russian sites direct" is a global bypass: it wins over app and card routes, and its DNS stays local first
  if (s.ruDirect) {
    rules.push({ domain_suffix: RU_DIRECT, outbound: DIRECT })
    dnsRules.push({ domain_suffix: RU_DIRECT, server: 'local' })
  }

  // Explicit application intent wins before broader destination/service rules.
  for (const [key, list] of byTarget(act.filter(r => r.kind === 'app' && r.exe))) {
    const tag = targetOf(key, list)
    const { exact, regex } = appRules(list.map(r => ({ exe: r.exe!, matchDir: r.wholeDir === true ? r.matchDir : undefined })))
    const m: Record<string, unknown> = {}
    if (exact.length) m.process_path = exact
    if (regex.length) m.process_path_regex = regex
    rules.push(...noV6(m, o.selectors ? outR(list[0]) : key), { ...m, outbound: tag })
  }
  for (const kind of ['custom', 'preset'] as const) {
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
      else if (domains.length && dns !== 'local') dnsRules.push({ domain_suffix: domains, server: dns })
    }
  }
  if (rest === BLOCK) dnsRules.push({ action: 'reject' })
  // G: everything else over an IPv4-only rest path: IPv6 is rejected, not leaked Direct
  rules.push(...noV6({}, rest))

  // Card-only mode has no single tunnel that can honestly own global DNS.
  // Keep DNS local until the UI offers an explicit DNS route instead of choosing used[0].
  const dnsFinal = rest !== DIRECT && rest !== BLOCK ? viaDns(REST_SEL, dnsOf(s.rest)) : 'local'
  const final = rest === BLOCK ? 'direct' : via(REST_SEL, rest)

  const dnsServers: Record<string, unknown>[] = [{ type: 'local', tag: 'local' }]
  // WireGuard Interface DNS entries are ordinary DNS servers, not implicit DoH endpoints.
  // Keep private/team resolvers as supplied and send their queries through the selected tunnel.
  const resolver = (p: Profile) => {
    const imported = p.kind === 'awg' ? p.dns.find(d => isIP(d) !== 0) : undefined
    return imported ? { type: 'udp', server: imported, server_port: 53 } : { type: 'https', server: '1.1.1.1' }
  }
  for (const p of used) dnsServers.push({ ...resolver(p), tag: 'dns-' + p.id, detour: tagOf(p.id) })
  for (const g of lg) dnsServers.push({ ...resolver(used.find(p => p.id === g.members[0])!), tag: 'dns-' + g.id, detour: grpTag(g.id) })
  for (const g of fbs) dnsServers.push({ ...resolver(used.find(p => p.id === g.main)!), tag: 'dns-' + g.tag, detour: g.tag })
  // a route's DNS follows the route's own selector: the same resolver as its target, detour = the route switch
  for (const d of routeDns) dnsServers.push({ ...dnsServers.find(x => x.tag === d.from)!, tag: d.tag, detour: d.detour })

  return {
    log: { level: 'info', timestamp: true },
    dns: { servers: dnsServers, rules: dnsRules, final: dnsFinal, strategy: 'ipv4_only' },
    inbounds: [{
      type: 'tun',
      tag: 'tun',
      interface_name: TUN.name,
      // Dual-stack TUN keeps literal IPv6 and existing IPv6-capable apps inside the same policy.
      // DNS remains IPv4-first until each provider advertises verified IPv6 capability.
      address: [...TUN_ADDRESSES],
      mtu: 1400,
      auto_route: true,
      strict_route: false,
      stack: 'mixed',
      ...(s.lanDirect ? { route_exclude_address: PRIVATE } : {})
    }],
    endpoints: used.flatMap(p => (p.kind === 'awg' ? [endpoint(p)] : p.kind === 'openvpn' ? [{ ...p.endpoint, tag: tagOf(p.id) }] : [])),
    outbounds: [
      { type: 'direct', tag: DIRECT },
      ...used.flatMap(p => (p.kind === 'vless' ? [vlessOutbound(p, tagOf(p.id))] : p.kind === 'out' ? [{ ...p.outbound, tag: tagOf(p.id) }] : [])),
      // every group is a selector driven by Waarp's own probe rounds (engine.groupStep): no urltest ping-chasing (W2.2).
      // 'fastest' keeps established sessions on an improvement switch; 'first' only switches away from a dead member.
      ...lg.map(g => ({ type: 'selector', tag: grpTag(g.id), outbounds: g.members.map(tagOf), default: tagOf(g.members[0]), interrupt_exist_connections: g.policy === 'first' })),
      ...fbs.map(g => ({ type: 'selector', tag: g.tag, outbounds: [tagOf(g.main), tagOf(g.fb)], default: tagOf(g.main), interrupt_exist_connections: true })),
      ...sels
    ],
    route: { rules: blockRules(rest === BLOCK ? [...rules, { network: ['tcp', 'udp'], outbound: BLOCK }] : rules), final, auto_detect_interface: true, find_process: true, default_domain_resolver: 'local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${o.api.port}`, secret: o.api.secret } }
  }
}

/** WRP-013 local checker config: no inbound, no TUN, userspace WireGuard, clash API on localhost only.
 *  Lets Waarp measure every tunnel (urltest / site probe) while the system tunnel is closed. */
export function checkConfig(profiles: Profile[], api: { port: number; secret: string }) {
  const active = profiles.filter(p => !p.revoked)
  return {
    log: { level: 'warn', timestamp: false },
    endpoints: active.flatMap((p): Record<string, unknown>[] => (p.kind === 'awg' ? [{ ...endpoint(p), system: false }] : p.kind === 'openvpn' ? [{ ...p.endpoint, tag: tagOf(p.id) }] : [])),
    outbounds: [{ type: 'direct', tag: 'direct' }, ...active.flatMap(p => (p.kind === 'vless' ? [vlessOutbound(p, tagOf(p.id))] : p.kind === 'out' ? [{ ...p.outbound, tag: tagOf(p.id) }] : []))],
    route: { final: 'direct' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${api.port}`, secret: api.secret } }
  }
}
