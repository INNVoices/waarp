// WRP-015 public VPN catalog: auto-updated public lists -> parsed nodes -> health-checked through a dedicated
// local checker (no TUN) -> the best alive nodes, by country and protocol. Public nodes are untrusted: they are
// labelled, never used as a silent fallback for personal tunnels, and only enter routing when the user picks them.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Profile } from '../shared/types'
import { parseAny } from './links'
import { Checker } from './checker'
import { catalogLabel, roundRobin, sourceLabel } from './catalog-sample'
import { RuntimeJournal } from './runtime-journal'
import { parseVpnGateCsv } from './vpngate'
import { protectPrivateFile } from './private-file'

// RC2 F: only sources with a clear license/terms; inventory in docs/SOURCES.md. No license = not a default.
export const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all',
  'https://raw.githubusercontent.com/mrdevmohamed/v2ray-configs/main/All_Configs_Sub.txt',
  'https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt',
  'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS.txt',
  'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_SS%2BAll_RUS.txt',
  'https://www.vpngate.net/api/iphone/'
]
const MAX_BYTES = 32 * 1024 * 1024
const MAX_NODES = 3000
// Keep background verification light enough for an ordinary workstation: at most eight
// simultaneous connections and a bounded one-minute-ish sample instead of probing thousands.
const CHECK_BATCH = 8
const CHECK_TOTAL = 64
const RECHECK_PREVIOUS = 24
const KEEP_ALIVE = 50

export interface CatalogNode { id: string; name: string; proto: string; host: string; port: number; country: string; source?: string; ping?: number; alive?: boolean; checkedAt?: number }
export interface CatalogState { updatedAt?: number; sources: { url: string; ok: boolean; count: number; error?: string }[]; total: number; planned?: number; checked: number; alive: CatalogNode[]; busy: boolean }

const NAMES: Record<string, string> = {
  'united states': 'US', usa: 'US', america: 'US', 'united kingdom': 'GB', england: 'GB', britain: 'GB', germany: 'DE', deutschland: 'DE',
  netherlands: 'NL', holland: 'NL', france: 'FR', finland: 'FI', sweden: 'SE', norway: 'NO', denmark: 'DK', poland: 'PL', russia: 'RU',
  ukraine: 'UA', turkey: 'TR', 'türkiye': 'TR', canada: 'CA', japan: 'JP', korea: 'KR', singapore: 'SG', 'hong kong': 'HK', taiwan: 'TW',
  india: 'IN', iran: 'IR', china: 'CN', spain: 'ES', italy: 'IT', switzerland: 'CH', austria: 'AT', czech: 'CZ', romania: 'RO', estonia: 'EE',
  latvia: 'LV', lithuania: 'LT', kazakhstan: 'KZ', israel: 'IL', 'united arab emirates': 'AE', uae: 'AE', australia: 'AU', brazil: 'BR',
  ireland: 'IE', belgium: 'BE', luxembourg: 'LU', bulgaria: 'BG', hungary: 'HU', moldova: 'MD', armenia: 'AM', georgia: 'GE', vietnam: 'VN', indonesia: 'ID'
}
const CODES = new Set(Object.values(NAMES))

/** 2-letter country from a flag emoji, a country name, or a known code in the node name; '??' when unknown (no GeoIP DB yet) */
export function countryOf(name: string): string {
  const flag = [...name].filter(c => { const p = c.codePointAt(0)!; return p >= 0x1f1e6 && p <= 0x1f1ff })
  if (flag.length >= 2) return String.fromCharCode(flag[0].codePointAt(0)! - 0x1f1e6 + 65, flag[1].codePointAt(0)! - 0x1f1e6 + 65)
  const noTags = name.replace(/\[[^\]]*\]/g, ' ')
  const low = noTags.toLowerCase()
  for (const [k, v] of Object.entries(NAMES)) if (low.includes(k)) return v
  const m = /(?:^|[\s|_\-(])([A-Z]{2})(?=$|[\s|_\-)\d])/.exec(noTags)
  return m && CODES.has(m[1]) ? m[1] : '??'
}

async function fetchText(url: string): Promise<string> {
  const allowed = new Set(['raw.githubusercontent.com', 'www.vpngate.net', 'vpngate.net'])
  let current = new URL(url)
  if (current.protocol !== 'https:' || !allowed.has(current.hostname.toLowerCase())) throw new Error('источник не разрешён')
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000)
  try {
    let r: Response | undefined
    for (let hop = 0; hop <= 3; hop++) {
      r = await fetch(current, { signal: ac.signal, redirect: 'manual' })
      if (r.status < 300 || r.status >= 400) break
      const location = r.headers.get('location')
      if (!location || hop === 3) throw new Error('слишком много перенаправлений')
      current = new URL(location, current)
      if (current.protocol !== 'https:' || !allowed.has(current.hostname.toLowerCase())) throw new Error('перенаправление на неразрешённый источник')
    }
    if (!r) throw new Error('источник не ответил')
    if (!r.ok) throw new Error('HTTP ' + r.status)
    if (!r.body) throw new Error('пустой ответ источника')
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('слишком большой список') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const buf = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(buf)
  } finally { clearTimeout(t) }
}

export class Catalog {
  state: CatalogState = { sources: [], total: 0, checked: 0, alive: [], busy: false }
  private nodes = new Map<string, Profile>()
  private file: string
  constructor(private dir: string, private exe: string, private onChange: (s: CatalogState) => void) {
    this.file = join(dir, 'catalog.json')
    try {
      if (existsSync(this.file)) {
        const envelope = JSON.parse(readFileSync(this.file, 'utf8'))
        if (envelope.version !== 1 || typeof envelope.sealed !== 'string') { rmSync(this.file, { force: true }); return } // remove legacy plaintext public cache
        if (!safeStorage.isEncryptionAvailable()) return
        const d = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.sealed, 'base64')))
        this.state = { ...this.state, ...d.state, busy: false }
        for (const p of d.nodes ?? []) this.nodes.set(p.id, p)
      }
    } catch { /* cache unreadable: start empty; never overwrite a personal profile store */ }
  }

  node(id: string): Profile | undefined { return this.nodes.get(id) }
  recover(): Promise<boolean> { return new RuntimeJournal(join(this.dir, 'catalog-check'), this.exe, 'check.json').recover() }

  /** fetch every source, parse, dedupe, then health-check a bounded sample through the local checker */
  async refresh(sources: string[] = DEFAULT_SOURCES): Promise<CatalogState> {
    if (this.state.busy) return this.state
    const previous = this.state
    this.state = { ...this.state, busy: true }; this.onChange(this.state)
    const seen = new Map<string, Profile>(); const report: CatalogState['sources'] = []
    const nodeSources = new Map<string, string>()
    const buckets: Profile[][] = []
    const selectedSources = sources.slice(0, 10)
    const perSourceLimit = Math.max(1, Math.ceil(MAX_NODES / selectedSources.length))
    // Sources are independent. Fetch them concurrently so one 20-second timeout cannot
    // multiply into several minutes; parsing and deduplication remain deterministic in source order.
    const fetched = await Promise.all(selectedSources.map(async url => {
      try { return { url, body: await fetchText(url) } }
      catch (error) { return { url, error: error instanceof Error ? error.message : String(error) } }
    }))
    for (const item of fetched) {
      const { url } = item
      if (typeof item.body !== 'string') { report.push({ url, ok: false, count: 0, error: item.error }); continue }
      try {
        const items = /vpngate\.net\/api\/iphone\/?$/i.test(url) ? parseVpnGateCsv(item.body, perSourceLimit) : parseAny(item.body, perSourceLimit).items
        let n = 0
        const protocols = new Map<string, Profile[]>()
        for (const p of items) {
          const k = p.kind === 'vless' ? `vless|${p.vless.server}|${p.vless.port}|${p.vless.uuid}` : p.kind === 'out' ? `${p.outbound.type}|${p.host}|${p.port}|${String(p.outbound.uuid ?? p.outbound.password ?? '')}` : p.kind === 'openvpn' ? `openvpn|${p.host}|${p.port}|${JSON.stringify(p.endpoint)}` : p.id
          if (seen.has(k) || seen.size >= MAX_NODES) continue
          if (p.kind === 'out' || p.kind === 'openvpn') p.source = 'public'
          p.id = 'pub-' + createHash('sha256').update(k).digest('hex').slice(0, 20)
          nodeSources.set(p.id, sourceLabel(url))
          seen.set(k, p); n++
          const family = p.kind === 'out' ? String(p.outbound.type) : p.kind
          const group = protocols.get(family) ?? []
          group.push(p); protocols.set(family, group)
        }
        if (n) buckets.push(roundRobin([...protocols.values()]))
        report.push(n ? { url, ok: true, count: n } : { url, ok: false, count: 0, error: 'В источнике нет поддерживаемых узлов' })
      } catch (error) { report.push({ url, ok: false, count: 0, error: error instanceof Error ? error.message : String(error) }) }
    }
    if (!report.some(x => x.ok)) {
      this.state = { ...previous, sources: report, busy: false }
      this.onChange(this.state)
      return this.state
    }
    const all = roundRobin(buckets)
    // Recheck enough known-good nodes to keep the list useful, but reserve most of every
    // automatic refresh for discovery. This continuously replenishes the public pool instead
    // of spending the whole bounded budget on the same previously alive entries.
    const prev = new Set(this.state.alive.map(a => `${a.host}:${a.port}`))
    const hostOf = (p: Profile) => (p.kind === 'vless' ? p.vless.server : p.kind === 'awg' ? p.peer.host : p.host)
    const portOf = (p: Profile) => (p.kind === 'vless' ? p.vless.port : p.kind === 'awg' ? p.peer.port : p.port)
    const knownCandidates = all.filter(p => prev.has(`${hostOf(p)}:${portOf(p)}`)).slice(0, RECHECK_PREVIOUS)
    const fresh = all.filter(p => !prev.has(`${hostOf(p)}:${portOf(p)}`)).slice(0, CHECK_TOTAL - knownCandidates.length)
    const sample = [...knownCandidates, ...fresh]
    this.state = { ...this.state, sources: report, total: all.length, planned: sample.length, checked: 0 }
    this.onChange(this.state)
    const alive: CatalogNode[] = []
    const chk = new Checker(this.exe, join(this.dir, 'catalog-check'))
    let started = 0
    try {
      for (let i = 0; i < sample.length; i += CHECK_BATCH) {
        const batch = sample.slice(i, i + CHECK_BATCH)
        if (!(await chk.ensure(batch, []))) continue
        started++
        const pings = await chk.pings()
        for (const p of batch) {
          const ms = pings[p.id]
          if (ms !== undefined) {
            const country = countryOf(p.name)
            p.name = catalogLabel(p.name, country, hostOf(p))
            alive.push({ id: p.id, name: p.name, proto: p.version, host: hostOf(p), port: portOf(p), country, source: nodeSources.get(p.id), ping: ms, alive: true, checkedAt: Date.now() })
          }
        }
        this.state = { ...this.state, sources: report, total: all.length, planned: sample.length, checked: Math.min(i + CHECK_BATCH, sample.length), alive: alive.slice().sort((a, b) => a.ping! - b.ping!) }
        this.onChange(this.state)
      }
    } catch (e) {
      report.push({ url: 'local checker', ok: false, count: 0, error: e instanceof Error ? e.message : String(e) })
      this.state = { ...previous, sources: report, busy: false }
      this.onChange(this.state)
      return this.state
    } finally { await chk.stop() }
    if (sample.length && !started) {
      report.push({ url: 'local checker', ok: false, count: 0, error: 'Проверочный движок недоступен' })
      this.state = { ...previous, sources: report, busy: false }
      this.onChange(this.state)
      return this.state
    }
    if (sample.length && !alive.length) {
      // A temporary network/probe outage must not erase the last usable public list. Its old checkedAt
      // remains visible, so the UI can distinguish cached data from a fresh successful verification.
      report.push({ url: 'local checker', ok: false, count: 0, error: 'Ни один узел не ответил; оставлен прошлый рабочий список' })
      this.state = { ...previous, sources: report, busy: false }
      this.onChange(this.state)
      return this.state
    }
    alive.sort((a, b) => a.ping! - b.ping!)
    const keep = alive.slice(0, KEEP_ALIVE)
    this.nodes = new Map(keep.map(n => [n.id, all.find(p => p.id === n.id)!]))
    this.state = { updatedAt: Date.now(), sources: report, total: all.length, planned: sample.length, checked: sample.length, alive: keep, busy: false }
    if (safeStorage.isEncryptionAvailable()) {
      const tmp = this.file + '.tmp'
      try {
        const sealed = safeStorage.encryptString(JSON.stringify({ state: this.state, nodes: [...this.nodes.values()] })).toString('base64')
        mkdirSync(this.dir, { recursive: true })
        writeFileSync(tmp, JSON.stringify({ version: 1, sealed }))
        protectPrivateFile(tmp)
        renameSync(tmp, this.file)
      } catch { try { rmSync(tmp, { force: true }) } catch { /* cache is optional */ } }
    }
    this.onChange(this.state)
    return this.state
  }
}
