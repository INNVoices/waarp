// Candidate storage and observations are separate. A successful old observation
// is useful for recovery ordering, but only this session/network can make it ready.
import { createHash, randomBytes } from 'node:crypto'
import type { Profile } from '../shared/types'
import { credentialKey } from './discovery'
import { diverseSample } from './catalog-sample'
import { validLatency } from './health'
import { publicCandidateEndpointsAllowed } from './catalog-endpoint'

export const CATALOG_POOL_LIMIT = 10_000
export const CATALOG_READY_TTL = 5 * 60_000
const MAX_PROFILE_BYTES = 64 * 1024
const MAX_POOL_BYTES = 48 * 1024 * 1024
const MAX_HISTORY = 8
const MAX_IDENTITIES = CATALOG_POOL_LIMIT * 2
const MAX_COOLDOWN = 6 * 60 * 60_000
const RECENT_HISTORY = 7 * 24 * 60 * 60_000
const COOLDOWNS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, MAX_COOLDOWN]
const ID = /^pub-[a-f0-9]{20}$/
const KEY = /^(vless|out|openvpn)\|[a-f0-9]{64}$/

export type PublicProfile = Exclude<Profile, { kind: 'awg' }>
export interface CatalogObservation {
  at: number
  ok: boolean
  latency?: number
  /** Opaque, transient session + network epoch. Never an SSID or adapter name. */
  context: string
}
export interface CatalogEntry {
  profile: PublicProfile
  sources: string[]
  firstSeen: number
  lastSeen: number
  lastSuccessAt?: number
  failures: number
  nextProbeAt: number
  history: CatalogObservation[]
}
export interface CatalogPoolData {
  entries: CatalogEntry[]
  identities: [string, string][]
  cursor: number
  recoveryCursor: number
}

const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const cap = (value: number, maximum: number): number => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0
export const catalogHost = (p: PublicProfile): string => p.kind === 'vless' ? p.vless.server : p.host
export const catalogPort = (p: PublicProfile): number => p.kind === 'vless' ? p.vless.port : p.port
export const catalogFamily = (p: PublicProfile): string => p.kind === 'out' ? String(p.outbound.type) : p.kind
const hostKey = (p: PublicProfile): string => catalogHost(p).toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
const latest = (entry: CatalogEntry): CatalogObservation | undefined => entry.history.at(-1)

/** Cache input is bounded and validated before it is used. Network ingestion
 * only supplies profiles already constructed by the share-link/CSV parsers. */
function publicProfile(value: unknown): PublicProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as PublicProfile
  if (!['vless', 'out', 'openvpn'].includes(p.kind) || typeof p.name !== 'string' || typeof p.version !== 'string') return undefined
  if (p.kind === 'vless' && (!p.vless || typeof p.vless.uuid !== 'string')) return undefined
  if (p.kind === 'out' && (!p.outbound || typeof p.outbound !== 'object' || typeof p.outbound.type !== 'string')) return undefined
  if (p.kind === 'openvpn' && (!p.endpoint || typeof p.endpoint !== 'object')) return undefined
  if (typeof catalogHost(p) !== 'string' || !catalogHost(p) || !Number.isInteger(catalogPort(p)) || catalogPort(p) < 1 || catalogPort(p) > 65535) return undefined
  try {
    const json = JSON.stringify(p)
    if (Buffer.byteLength(json) > MAX_PROFILE_BYTES) return undefined
    const copy = JSON.parse(json) as PublicProfile
    if (!publicCandidateEndpointsAllowed(copy)) return undefined
    copy.source = 'public'
    copy.name = copy.name.trim().slice(0, 100)
    if (copy.kind !== 'openvpn') { delete copy.sub; delete copy.subKey; delete copy.subMissing }
    credentialKey(copy) // reject an incomplete cached VLESS/config structure
    return copy
  } catch { return undefined }
}

/** Bounded at-rest reservoir; the short ready list is a projection, not storage. */
export class CatalogPool {
  private entries = new Map<string, CatalogEntry>()
  private identities = new Map<string, string>()
  private cursor = 0
  private recoveryCursor = 0
  private epoch = randomBytes(16).toString('hex')
  readonly limit: number
  constructor(private now: () => number = Date.now, limit = CATALOG_POOL_LIMIT) {
    this.limit = Math.max(1, cap(limit, CATALOG_POOL_LIMIT))
  }

  get size(): number { return this.entries.size }
  get context(): string { return this.epoch }
  all(): CatalogEntry[] { return [...this.entries.values()] }
  entry(id: string): CatalogEntry | undefined { return this.entries.get(id) }
  profile(id: string): PublicProfile | undefined {
    const profile = this.entries.get(id)?.profile
    return profile ? structuredClone(profile) : undefined
  }

  invalidate(): void {
    // No persisted session can confer readiness in a new process/network. Old
    // network cooldowns are skipped by eligible(), not misreported as failures.
    this.epoch = randomBytes(16).toString('hex')
  }

  ready(entry: CatalogEntry, now = this.now()): boolean {
    const observation = latest(entry)
    return !entry.profile.revoked && !!observation?.ok && observation.context === this.epoch &&
      validLatency(observation.latency) && now >= observation.at && now - observation.at < CATALOG_READY_TTL
  }

  status(entry: CatalogEntry, now = this.now()): 'ready' | 'cached' | 'failed' | 'unverified' {
    if (this.ready(entry, now)) return 'ready'
    const observation = latest(entry)
    if (observation?.context === this.epoch && !observation.ok) return 'failed'
    return entry.lastSuccessAt !== undefined ? 'cached' : 'unverified'
  }

  private eligible(entry: CatalogEntry, now: number): boolean {
    if (entry.profile.revoked) return false
    const observation = latest(entry)
    // A clock moving backwards must not trap all records in an endless cooldown.
    return !observation || observation.context !== this.epoch || observation.ok ||
      now < observation.at || now >= entry.nextProbeAt
  }

  /** Merge one fair, source-interleaved round; failures/omissions never clear the pool. */
  ingest(candidates: readonly { profile: Profile; source: string }[]): number {
    const now = this.now()
    let accepted = 0
    const byKey = new Map([...this.entries].map(([id, entry]) => [credentialKey(entry.profile), id]))
    for (const candidate of candidates) {
      const profile = publicProfile(candidate.profile)
      if (!profile) continue
      const key = credentialKey(profile)
      const source = candidate.source.slice(0, 1024)
      const existing = byKey.get(key)
      if (existing) {
        const entry = this.entries.get(existing)!
        entry.lastSeen = now
        // Names are presentation, not connection identity. Keep the existing ID.
        entry.profile.name = profile.name
        if (source && !entry.sources.includes(source) && entry.sources.length < 4) entry.sources.push(source)
        accepted++
        continue
      }
      // New identities use the complete effective config, not host/password.
      // Existing v1 IDs migrate intact; dropping bounded historical tombstones
      // can never make a new SNI/path take another config's former legacy ID.
      const id = this.identities.get(key) ?? 'pub-' + createHash('sha256').update(key).digest('hex').slice(0, 20)
      if (this.entries.has(id)) continue // a corrupted cached identity cannot rebind a live entry
      profile.id = id
      this.identities.delete(key); this.identities.set(key, id)
      this.entries.set(id, { profile, sources: source ? [source] : [], firstSeen: now, lastSeen: now, failures: 0, nextProbeAt: 0, history: [] })
      byKey.set(key, id)
      accepted++
    }
    this.enforceBounds()
    return accepted
  }

  /** Reserve part of each round for useful history; the persisted cursor walks
   * the rest even when the first hundreds of upstream entries all fail. */
  plan(limit = 64): PublicProfile[] {
    const budget = cap(limit, 64), now = this.now(), entries = this.all()
    if (!budget || !entries.length) return []
    const selected: CatalogEntry[] = []
    const selectedIds = new Set<string>()
    const known = entries.filter(entry => entry.lastSuccessAt !== undefined && this.eligible(entry, now))
      .sort((a, b) => (latest(a)?.at ?? 0) - (latest(b)?.at ?? 0))
      .slice(0, Math.min(24, Math.floor(budget * 3 / 8)))
    for (const entry of known) { selected.push(entry); selectedIds.add(entry.profile.id) }
    let scanned = 0
    this.cursor %= entries.length
    while (scanned < entries.length && selected.length < budget) {
      const entry = entries[this.cursor]
      this.cursor = (this.cursor + 1) % entries.length
      scanned++
      if (selectedIds.has(entry.profile.id) || !this.eligible(entry, now)) continue
      selected.push(entry); selectedIds.add(entry.profile.id)
    }
    return selected.map(entry => structuredClone(entry.profile))
  }

  /** Only actual, uncancelled probe outcomes after confirmed cleanup enter history. */
  observe(id: string, latency: unknown, context: string, at = this.now()): void {
    if (context !== this.epoch) return
    const entry = this.entries.get(id)
    if (!entry || !finiteTime(at)) return
    const ok = validLatency(latency)
    const previous = latest(entry)
    entry.failures = ok ? 0 : Math.min(COOLDOWNS.length, previous?.context === context ? entry.failures + 1 : 1)
    entry.nextProbeAt = ok ? at : at + COOLDOWNS[entry.failures - 1]
    if (ok) entry.lastSuccessAt = at
    entry.history.push({ at, ok, ...(ok ? { latency } : {}), context })
    if (entry.history.length > MAX_HISTORY) entry.history.splice(0, entry.history.length - MAX_HISTORY)
  }

  bestReady(limit = 5): CatalogEntry[] {
    const now = this.now()
    const ready = this.all().filter(entry => this.ready(entry, now))
      .sort((a, b) => latest(a)!.latency! - latest(b)!.latency!)
    return this.diverse(ready, cap(limit, this.limit))
  }

  cached(limit = 200): CatalogEntry[] {
    const now = this.now()
    const candidates = this.all().filter(entry => !this.ready(entry, now))
      .sort((a, b) => this.recoveryRank(a, now) - this.recoveryRank(b, now) ||
        (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0) || a.firstSeen - b.firstSeen)
    return this.diverse(candidates, cap(limit, 200))
  }

  recoveryCandidates(limit = 8): PublicProfile[] {
    const now = this.now(), budget = cap(limit, 64), entries = this.all()
    if (!budget || !entries.length) return []
    const candidates = entries.filter(entry => this.eligible(entry, now))
      .sort((a, b) => this.recoveryRank(a, now) - this.recoveryRank(b, now) || (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0))
    // Keep a small, useful head, then rotate even if those historical candidates
    // all fail to fetch a list. Download failure is not a health observation,
    // and a repeatedly returned "best eight" would trap bootstrap indefinitely.
    const preferred = Math.min(3, Math.floor(budget / 2))
    const out: CatalogEntry[] = []
    for (const rank of [0, 1]) {
      out.push(...this.diverse(candidates.filter(entry => this.recoveryRank(entry, now) === rank), preferred - out.length))
      if (out.length >= preferred) break
    }
    const picked = new Set(out.map(entry => entry.profile.id))
    this.recoveryCursor %= entries.length
    let scanned = 0
    while (scanned < entries.length && out.length < budget) {
      const entry = entries[this.recoveryCursor]
      this.recoveryCursor = (this.recoveryCursor + 1) % entries.length
      scanned++
      if (picked.has(entry.profile.id) || !this.eligible(entry, now)) continue
      out.push(entry); picked.add(entry.profile.id)
    }
    return out.map(entry => structuredClone(entry.profile))
  }

  private recoveryRank(entry: CatalogEntry, now: number): number {
    return this.ready(entry, now) ? 0 : entry.lastSuccessAt !== undefined ? 1 : 2
  }

  private diverse(entries: CatalogEntry[], limit: number): CatalogEntry[] {
    return diverseSample(entries, limit, entry => ({ host: hostKey(entry.profile), protocol: catalogFamily(entry.profile), source: entry.sources[0] ?? '' }))
  }

  data(): CatalogPoolData {
    return { entries: this.all(), identities: [...this.identities], cursor: this.cursor, recoveryCursor: this.recoveryCursor }
  }

  /** v2 encrypted records; observations retain historical value but their old
   * session context can never match this newly constructed pool. */
  restore(data: unknown): void {
    if (!data || typeof data !== 'object') return
    const d = data as Partial<CatalogPoolData>
    this.restoreIdentities(d.identities)
    const keys = new Set<string>()
    for (const value of Array.isArray(d.entries) ? d.entries.slice(0, CATALOG_POOL_LIMIT) : []) {
      if (!value || typeof value !== 'object') continue
      const profile = publicProfile(value.profile)
      if (!profile || !ID.test(profile.id)) continue
      const key = credentialKey(profile)
      if (this.entries.has(profile.id) || keys.has(key)) continue
      const history = (Array.isArray(value.history) ? value.history : []).slice(-MAX_HISTORY).filter(observation =>
        observation && finiteTime(observation.at) && typeof observation.ok === 'boolean' &&
        typeof observation.context === 'string' && observation.context.length <= 100 && (!observation.ok || validLatency(observation.latency)))
      this.entries.set(profile.id, {
        profile, sources: (Array.isArray(value.sources) ? value.sources : []).filter((source): source is string => typeof source === 'string').slice(0, 4).map(source => source.slice(0, 1024)),
        firstSeen: finiteTime(value.firstSeen) ? value.firstSeen : this.now(), lastSeen: finiteTime(value.lastSeen) ? value.lastSeen : this.now(),
        ...(finiteTime(value.lastSuccessAt) ? { lastSuccessAt: value.lastSuccessAt } : {}),
        failures: cap(value.failures, COOLDOWNS.length), nextProbeAt: finiteTime(value.nextProbeAt) ? value.nextProbeAt : 0, history
      })
      this.identities.set(key, profile.id)
      keys.add(key)
    }
    this.cursor = cap(d.cursor ?? 0, CATALOG_POOL_LIMIT)
    this.recoveryCursor = cap(d.recoveryCursor ?? 0, CATALOG_POOL_LIMIT)
    this.enforceBounds()
  }

  migrate(nodes: unknown, identities: unknown, oldAlive: unknown): void {
    this.restoreIdentities(identities)
    const old = Array.isArray(oldAlive) ? oldAlive : []
    for (const value of Array.isArray(nodes) ? nodes.slice(0, CATALOG_POOL_LIMIT) : []) {
      const profile = publicProfile(value)
      if (!profile || !ID.test(profile.id)) continue
      const checked = old.find(item => item?.id === profile.id)
      const at = finiteTime(checked?.checkedAt) ? checked.checkedAt : undefined
      this.identities.set(credentialKey(profile), profile.id)
      this.entries.set(profile.id, {
        profile, sources: [], firstSeen: this.now(), lastSeen: this.now(), failures: 0, nextProbeAt: 0,
        ...(at !== undefined && validLatency(checked?.ping) ? { lastSuccessAt: at } : {}),
        history: at !== undefined && validLatency(checked?.ping) ? [{ at, ok: true, latency: checked.ping, context: 'previous-process' }] : []
      })
    }
    this.enforceBounds()
  }

  private restoreIdentities(values: unknown): void {
    for (const pair of Array.isArray(values) ? values.slice(-MAX_IDENTITIES) : []) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && KEY.test(pair[0]) && ID.test(pair[1])) this.identities.set(pair[0], pair[1])
    }
  }

  private enforceBounds(): void {
    const now = this.now()
    const ordered = this.all().map((entry, index) => ({ entry, index, bytes: Buffer.byteLength(JSON.stringify(entry)) }))
    // Retain fresh readiness and useful history, but reserve discovery room.
    // Otherwise a full pool of once-working expired credentials could forever
    // reject every newly advertised replacement, despite having no ready nodes.
    ordered.sort((a, b) => this.evictionRank(a.entry, now) - this.evictionRank(b.entry, now) ||
      (b.entry.lastSuccessAt ?? 0) - (a.entry.lastSuccessAt ?? 0) || b.entry.lastSeen - a.entry.lastSeen || a.index - b.index)
    let bytes = 0
    const keep = new Set<string>()
    const admit = ({ entry, bytes: size }: typeof ordered[number]) => {
      if (keep.has(entry.profile.id) || keep.size >= this.limit || bytes + size > MAX_POOL_BYTES) return
      keep.add(entry.profile.id); bytes += size
    }
    for (const item of ordered) if (this.ready(item.entry, now)) admit(item)
    const unseen = ordered.filter(item => !item.entry.history.length)
      .sort((a, b) => b.entry.firstSeen - a.entry.firstSeen || a.index - b.index)
      .slice(0, Math.max(1, Math.floor(this.limit / 4)))
    for (const item of unseen) admit(item)
    for (const { entry, bytes: size } of ordered) {
      admit({ entry, bytes: size, index: 0 })
    }
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id)
    const activeKeys = new Set(this.all().map(entry => credentialKey(entry.profile)))
    for (const key of this.identities.keys()) {
      if (this.identities.size <= MAX_IDENTITIES) break
      if (!activeKeys.has(key)) this.identities.delete(key)
    }
    this.cursor %= this.entries.size || 1
    this.recoveryCursor %= this.entries.size || 1
  }

  private evictionRank(entry: CatalogEntry, now: number): number {
    if (this.ready(entry, now)) return 0
    const observation = latest(entry)
    if (entry.lastSuccessAt !== undefined && now >= entry.lastSuccessAt && now - entry.lastSuccessAt < RECENT_HISTORY &&
      (observation?.context !== this.epoch || observation.ok || entry.failures < 2)) return 1
    if (!entry.history.length) return 2
    return entry.lastSuccessAt !== undefined ? 3 : 4
  }
}
