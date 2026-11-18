// Public lists feed a persistent, encrypted candidate pool. Checking candidates
// never changes application routes; only fresh observations enter the ready list.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Profile } from '../shared/types'
import { atlasCountry, countryFromName, profileCountry, projectAtlas, type AtlasProjection } from '../shared/atlas'
import { parseAny } from './links'
import { Checker } from './checker'
import { catalogLabel, roundRobin, sourceLabel } from './catalog-sample'
import { RuntimeJournal } from './runtime-journal'
import { parseVpnGateCsv } from './vpngate'
import { protectPrivateFile } from './private-file'
import { validLatency } from './health'
import { preparePublicCandidateResult, publicCandidateEndpointsAllowed } from './catalog-endpoint'
import { PublicPathCleanupError } from './public-service-path'
import type { PublicResolver } from './vless'
import { DEFAULT_SOURCES } from '../shared/public-sources'
import { fetchCatalogSources, type CatalogSourceText } from './catalog-fetch'
import { CatalogPool, CATALOG_POOL_LIMIT, CATALOG_READY_TTL, catalogFamily, catalogHost, catalogPort, type CatalogEntry } from './catalog-pool'

export { DEFAULT_SOURCES } from '../shared/public-sources'
export { fetchCatalogSources, type CatalogSourceText } from './catalog-fetch'

const CHECK_BATCH = 8
const CHECK_TOTAL = 64
const AUTO_LEASE_MS = 45_000
const AUTO_BURST = 64
const READY_PREVIEW = 50
const CACHED_PREVIEW = 200
const MAX_CACHE_BYTES = 96 * 1024 * 1024

export interface CatalogNode {
  id: string; name: string; proto: string; host: string; port: number; country: string; source?: string
  ping?: number; alive?: boolean; checkedAt?: number; lastSuccessAt?: number; nextCheckAt?: number
  status?: 'ready' | 'cached' | 'failed' | 'unverified' | 'checking' | 'queued' | 'dns-failed' | 'unsupported'
  checkError?: string
}
export interface CatalogSourceReport {
  url: string; ok: boolean; count: number; error?: string
  sourceId?: string; selectedUrl?: string; attempts?: CatalogSourceText['attempts']
}
export interface CatalogState {
  updatedAt?: number; verifiedAt?: number; sources: CatalogSourceReport[]
  /** total/cachedCount count stored candidates; neither means reachable. */
  total: number; cachedCount: number; readyCount: number
  planned?: number; checked: number; alive: CatalogNode[]; cached: CatalogNode[]; busy: boolean
  automatic: boolean; checkingIds: string[]; queuedIds: string[]
  checkedCount: number; failedCount: number; skippedCount: number; uncheckedCount: number
  checkIssue?: { kind: 'engine' | 'dns' | 'unsupported' | 'unreachable'; message: string }
  cacheError?: string
}
export type CatalogRegion = 'eu' | 'asia' | 'americas' | 'other'
export interface CatalogPage {
  items: CatalogNode[]; total: number; page: number; pageSize: number; pages: number
  regions: { id: CatalogRegion; name: string; total: number; ready: number }[]
  /** Country groups across the same search/region/availability result, before its country filter. */
  atlas: AtlasProjection
}
const REGIONS: { id: CatalogRegion; name: string; countries: ReadonlySet<string> }[] = [
  { id: 'eu', name: 'Европа', countries: new Set('AL AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MD ME MK MT NL NO PL PT RO RS SE SI SK UA'.split(' ')) },
  { id: 'asia', name: 'Азия и Ближний Восток', countries: new Set('AE AM AZ BD BH BN BT CN GE HK ID IL IN IQ IR JO JP KG KH KR KZ LA LB LK MM MN MO MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE'.split(' ')) },
  { id: 'americas', name: 'Северная и Южная Америка', countries: new Set('AR BO BR CA CL CO CR CU DO EC GT HN JM MX NI PA PE PR PY SV US UY VE'.split(' ')) },
  { id: 'other', name: 'Другие регионы', countries: new Set() }
]
const regionOf = (country: string): CatalogRegion => REGIONS.find(region => region.countries.has(country))?.id ?? 'other'
const countryLabels = ['ru', 'en'].map(locale => new Intl.DisplayNames([locale], { type: 'region' }))
const countrySearch = (country: string): string => /^[A-Z]{2}$/.test(country)
  ? countryLabels.map(labels => labels.of(country) ?? '').join(' ') : ''
interface CatalogMetadata {
  updatedAt?: number; verifiedAt?: number; sources: CatalogSourceReport[]
  planned?: number; checked: number; busy: boolean; cacheError?: string
  checkIssue?: CatalogState['checkIssue']
}
interface CandidateNote { context: string; at: number; retryAt: number; status: 'dns-failed' | 'unsupported'; message: string }

/** Region advertised by the source label; never inferred from an IP address. */
export const countryOf = countryFromName

export class Catalog {
  private pool: CatalogPool
  private metadata: CatalogMetadata = { sources: [], checked: 0, busy: false }
  private file: string
  private abort?: AbortController
  private pending?: Promise<CatalogState>
  private checker?: Checker
  private checkerStopped = true
  private stopping?: Promise<boolean>
  private networkHash?: string
  private expiryTimer?: ReturnType<typeof setTimeout>
  private automaticOwners = new Map<string, { expires: number; ids: string[] }>()
  private visibleIds = new Set<string>()
  private automaticTimer?: ReturnType<typeof setTimeout>
  private automaticWork = false
  private automaticBudget = 0
  private automaticPauseUntil = 0
  private automaticRefreshAt = 0
  private checking = new Set<string>()
  private notes = new Map<string, CandidateNote>()
  private countryCache = new Map<string, string>()
  constructor(private dir: string, private exe: string, private onChange: (s: CatalogState) => void, private allowStart: () => boolean = () => true,
    private readSources: (sources: string[], signal: AbortSignal) => Promise<CatalogSourceText[]> = fetchCatalogSources,
    private now: () => number = Date.now, private resolveCandidate?: PublicResolver) {
    this.pool = new CatalogPool(now)
    this.file = join(dir, 'catalog.json')
    try {
      if (!existsSync(this.file)) return
      if (statSync(this.file).size > MAX_CACHE_BYTES) return
      const envelope = JSON.parse(readFileSync(this.file, 'utf8'))
      if (![1, 2].includes(envelope.version) || typeof envelope.sealed !== 'string') { rmSync(this.file, { force: true }); return }
      if (!safeStorage.isEncryptionAvailable()) { this.metadata.cacheError = 'Защищённое хранилище каталога недоступно'; return }
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.sealed, 'base64')))
      if (envelope.version === 2) this.pool.restore(data.pool)
      else this.pool.migrate(data.nodes, data.identities, data.state?.alive)
      const state = data.metadata ?? data.state
      // Never deserialize old ready/busy flags. Observation contexts belong to
      // the process which measured them, so all restored candidates are cached.
      if (state && typeof state === 'object') {
        if (Number.isFinite(state.updatedAt) && state.updatedAt >= 0) this.metadata.updatedAt = state.updatedAt
        if (Number.isFinite(state.verifiedAt) && state.verifiedAt >= 0) this.metadata.verifiedAt = state.verifiedAt
        this.metadata.sources = (Array.isArray(state.sources) ? state.sources : []).slice(0, 12).filter((source: CatalogSourceReport) =>
          source && typeof source.url === 'string' && source.url !== 'local checker' && typeof source.ok === 'boolean' && Number.isFinite(source.count))
      }
    } catch { this.metadata.cacheError = 'Сохранённый каталог не удалось прочитать' }
  }

  /** Freshness is evaluated when read, not frozen in the last emitted event. */
  get state(): CatalogState { return this.snapshot() }
  snapshot(): CatalogState {
    const now = this.now()
    const entries = this.pool.all(), measured = entries.filter(entry => entry.history.at(-1)?.context === this.pool.context)
    const skipped = entries.filter(entry => this.notes.get(entry.profile.id)?.context === this.pool.context)
    const queuedIds = this.visibleCandidates().filter(id => !this.checking.has(id) && this.autoEligible(id))
    return {
      ...this.metadata, sources: structuredClone(this.metadata.sources),
      total: this.pool.size, cachedCount: this.pool.size,
      readyCount: entries.filter(entry => this.pool.ready(entry, now)).length,
      automatic: this.hasAutomaticOwners(), checkingIds: [...this.checking], queuedIds,
      checkedCount: measured.length, failedCount: measured.filter(entry => !entry.history.at(-1)!.ok).length,
      skippedCount: skipped.length, uncheckedCount: Math.max(0, entries.length - new Set([...measured, ...skipped].map(entry => entry.profile.id)).size),
      alive: this.bestReady(READY_PREVIEW), cached: this.pool.cached(CACHED_PREVIEW).map(entry => this.view(entry))
    }
  }

  /** Active views hold short leases, so hidden/crashed renderers cannot leave
   * a permanent scanner running. Candidate IDs only prioritize measurement;
   * this operation never imports a profile or changes application routes. */
  automatic(owner: string, active: boolean, ids: readonly string[] = []): CatalogState {
    if (active) {
      if (this.automaticOwners.has(owner) || this.automaticOwners.size < 4) {
        this.automaticOwners.set(owner, { expires: this.now() + AUTO_LEASE_MS,
          ids: [...new Set(ids)].filter(id => this.pool.entry(id)).slice(0, 100) })
      }
    } else this.automaticOwners.delete(owner)
    this.visibleIds = new Set([...this.automaticOwners.values()].flatMap(lease => lease.ids))
    if (!this.hasAutomaticOwners()) {
      if (this.automaticTimer) clearTimeout(this.automaticTimer)
      this.automaticTimer = undefined
      if (this.automaticWork) { this.abort?.abort(); void this.stopChecker() }
    } else this.scheduleAutomatic(0)
    return this.state
  }

  private hasAutomaticOwners(): boolean {
    const now = this.now()
    let changed = false
    for (const [owner, lease] of this.automaticOwners) if (lease.expires <= now) { this.automaticOwners.delete(owner); changed = true }
    if (changed) this.visibleIds = new Set([...this.automaticOwners.values()].flatMap(lease => lease.ids))
    return this.automaticOwners.size > 0
  }
  private visibleCandidates(): string[] {
    this.hasAutomaticOwners()
    return [...this.visibleIds]
  }
  private autoEligible(id: string): boolean {
    const entry = this.pool.entry(id), now = this.now()
    if (!entry || entry.profile.revoked || this.pool.ready(entry, now)) return false
    const note = this.notes.get(id)
    if (note?.context === this.pool.context && now < note.retryAt) return false
    const observation = entry.history.at(-1)
    return observation?.context !== this.pool.context || observation.ok || now < observation.at || now >= entry.nextProbeAt
  }
  private scheduleAutomatic(delay: number): void {
    if (this.automaticTimer || this.pending || !this.hasAutomaticOwners()) return
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined
      void this.runAutomatic()
    }, Math.max(delay, this.automaticPauseUntil - this.now(), 0))
    this.automaticTimer.unref()
  }
  private async runAutomatic(): Promise<void> {
    if (!this.hasAutomaticOwners()) return
    if (this.pending || !this.allowStart()) { this.scheduleAutomatic(2000); return }
    if (!this.pool.size) {
      if (this.automaticRefreshAt && this.now() - this.automaticRefreshAt < 60_000) { this.scheduleAutomatic(15_000); return }
      this.automaticRefreshAt = this.now()
      await this.start(abort => this.runRefresh(DEFAULT_SOURCES, abort, true), true, true)
      return
    }
    // Show/check the visible cached rows first. Then refresh stale lists once,
    // rather than spending every entry into the screen on a slow download.
    if (this.automaticBudget > 0 && this.now() - (this.metadata.updatedAt ?? 0) > 60 * 60_000 &&
      this.now() - this.automaticRefreshAt > 10 * 60_000) {
      this.automaticRefreshAt = this.now()
      await this.start(abort => this.runRefresh(DEFAULT_SOURCES, abort, false), false, true)
      return
    }
    const priority = this.visibleCandidates().filter(id => this.autoEligible(id)).slice(0, CHECK_BATCH / 2)
    const exclude = new Set([...priority, ...this.pool.all().filter(entry => !this.autoEligible(entry.profile.id)).map(entry => entry.profile.id)])
    const sample = [...priority, ...this.pool.plan(CHECK_BATCH - priority.length, { exclude, staleOnly: true }).map(profile => profile.id)]
    if (!sample.length) { this.scheduleAutomatic(15_000); return }
    this.automaticBudget += sample.length
    await this.start(abort => this.runProbes(abort, sample.length, sample), true, true)
  }

  node(id: string): Profile | undefined { return this.pool.profile(id) }
  bestReady(limit = 5): CatalogNode[] { return this.pool.bestReady(limit).map(entry => this.view(entry)) }
  /** Page the complete reservoir in main. The small event snapshot is only a
   * summary; its first 200 candidates must never truncate search or navigation. */
  page(input: unknown = {}): CatalogPage {
    this.hasAutomaticOwners()
    const request = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    const query = typeof request.query === 'string' ? request.query.trim().slice(0, 200).toLocaleLowerCase('ru') : ''
    const region = REGIONS.some(item => item.id === request.region) ? request.region as CatalogRegion : undefined
    const country = typeof request.country === 'string' && request.country ? atlasCountry(request.country) : undefined
    const bounded = (value: unknown, fallback: number, maximum: number) => typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback
    const pageSize = bounded(request.pageSize, 12, 100)
    const rank = (node: CatalogNode) => node.status === 'ready' ? 0 : node.status === 'cached' ? 1 :
      node.status === 'failed' || node.status === 'dns-failed' || node.status === 'unsupported' ? 3 : 2
    const candidates = this.pool.all().map(entry => this.view(entry)).filter(node => !query ||
      [node.name, node.country, countrySearch(node.country), node.host, node.proto, node.source ?? '', REGIONS.find(item => item.id === regionOf(node.country))!.name]
        .join(' ').toLocaleLowerCase('ru').includes(query))
    const regions = REGIONS.map(item => ({ id: item.id, name: item.name,
      total: candidates.filter(node => regionOf(node.country) === item.id).length,
      ready: candidates.filter(node => regionOf(node.country) === item.id && node.status === 'ready').length }))
    const mapped = candidates.filter(node => (!region || regionOf(node.country) === region) && (request.readyOnly !== true || node.status === 'ready'))
    const atlas = projectAtlas(mapped)
    const nodes = mapped.filter(node => !country || atlasCountry(node.country) === country)
      .sort((a, b) => rank(a) - rank(b) || (a.ping ?? Infinity) - (b.ping ?? Infinity) ||
        (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0) || a.id.localeCompare(b.id))
    const pages = Math.max(1, Math.ceil(nodes.length / pageSize)), page = bounded(request.page, 1, pages)
    return { items: nodes.slice((page - 1) * pageSize, page * pageSize), total: nodes.length, page, pageSize, pages, regions, atlas }
  }
  /** Historical candidates for a bounded recovery attempt, not a health claim. */
  recoveryCandidates(limit = 8): Profile[] {
    const candidates = this.pool.recoveryCandidates(limit)
    this.save() // recovery rotation survives restarts independently of probe progress
    return candidates
  }

  /** A new network invalidates current success and failure cooldowns together.
   * A hashed fingerprint only avoids duplicate notifications; it is not saved. */
  invalidateNetwork(fingerprint?: string): boolean {
    const hash = fingerprint === undefined ? undefined : createHash('sha256').update(fingerprint).digest('hex')
    if (hash !== undefined && hash === this.networkHash) return false
    this.networkHash = hash
    this.pool.invalidate()
    this.notes.clear()
    this.metadata.checkIssue = undefined
    this.abort?.abort()
    void this.stopChecker()
    this.publish()
    return true
  }

  recoveryError?: string
  async recover(): Promise<boolean> {
    if (this.checker) return this.stopChecker()
    const journal = new RuntimeJournal(join(this.dir, 'catalog-check'), this.exe, 'check.json')
    const recovered = await journal.recover()
    this.recoveryError = journal.lastError
    if (recovered) this.checkerStopped = true
    return recovered
  }

  /** Cancel our work and confirm cleanup before the main TUN can start. */
  async pause(): Promise<boolean> {
    // A main-core transition owns this pause. A stale renderer heartbeat may
    // renew its lease but must not immediately recreate the stopped worker.
    this.automaticPauseUntil = this.now() + 5000
    this.abort?.abort()
    const stopped = await this.stopChecker()
    await this.pending?.catch(() => undefined)
    return stopped && this.checkerStopped
  }

  refresh(sources: string[] = DEFAULT_SOURCES, options: { probe?: boolean } = {}): Promise<CatalogState> {
    const probe = options.probe !== false
    return this.start(abort => this.runRefresh(sources, abort, probe), probe)
  }

  /** Verification can keep progressing from cache when every source is blocked. */
  verify(limit = CHECK_TOTAL): Promise<CatalogState> {
    return this.start(abort => this.runProbes(abort, limit), true)
  }

  /** A click is the verification request. Give it priority over a long pool
   * round, wait for that checker's cleanup, then measure this exact candidate.
   * Explicit selection may retry a failed node without waiting for cooldown. */
  async verifyNode(id: string): Promise<{ ok: boolean; node?: CatalogNode; error?: string }> {
    let entry = this.pool.entry(id)
    if (!entry) return { ok: false, error: 'Сервер пропал из каталога. Обнови список.' }
    if (this.pool.ready(entry)) return { ok: true, node: this.view(entry) }
    if (!this.allowStart()) return { ok: false, error: 'Дождись завершения текущего подключения и повтори выбор сервера.' }
    if (this.pending && !(await this.pause())) return { ok: false, error: 'Предыдущая проверка не завершилась. Повтори выбор сервера.' }
    await this.start(abort => this.runProbes(abort, 1, [id]), true)
    entry = this.pool.entry(id)
    if (entry && this.pool.ready(entry)) return { ok: true, node: this.view(entry) }
    const error = this.metadata.sources.find(source => source.url === 'local checker' && !source.ok)?.error
    return { ok: false, error: error ?? 'Сервер не ответил через интернет. Выбери другой сервер или повтори проверку позже.' }
  }

  private start(work: (abort: AbortController) => Promise<void>, probe: boolean, automatic = false): Promise<CatalogState> {
    if (this.pending) return this.pending
    if (probe && !this.allowStart()) return Promise.resolve(this.state)
    const abort = new AbortController()
    this.automaticWork = automatic
    this.abort = abort
    this.metadata = { ...this.metadata, busy: true, planned: 0, checked: 0 }
    this.publish()
    this.pending = work(abort).catch(error => {
      if (!abort.signal.aborted) this.localError(error instanceof PublicPathCleanupError
        ? 'Движок загрузки не подтвердил остановку; новые проверки не запускались, кандидаты сохранены'
        : 'Обновление прервано; сохранённые кандидаты остаются в каталоге')
    }).finally(() => {
      this.pending = undefined; this.abort = undefined
      this.automaticWork = false
      this.checking.clear()
      this.metadata.busy = false
      if (this.checkerStopped) this.checker = undefined
      this.publish()
      const delay = this.metadata.checkIssue?.kind === 'engine' ? 30_000 : this.automaticBudget >= AUTO_BURST ? 10_000 : 250
      if (this.automaticBudget >= AUTO_BURST) this.automaticBudget = 0
      this.scheduleAutomatic(delay)
    }).then(() => this.state)
    return this.pending
  }

  private async runRefresh(sources: string[], abort: AbortController, probe: boolean): Promise<void> {
    const selected = [...new Set(sources)].slice(0, 10)
    const fetched: CatalogSourceText[] = await this.readSources(selected, abort.signal).catch(error => {
      // A blocked source may still allow checking cached relays. Unconfirmed
      // cleanup of the loader's shared checker is terminal for the whole round.
      if (error instanceof PublicPathCleanupError) throw error
      return selected.map(url => ({ url, error: 'Источник недоступен по выбранному пути' }))
    })
    if (abort.signal.aborted) return
    const report: CatalogSourceReport[] = []
    const buckets: { profile: Profile; source: string }[][] = []
    for (const item of fetched) {
      const sourceReport: CatalogSourceReport = {
        url: item.url, ok: false, count: 0,
        ...(item.sourceId ? { sourceId: item.sourceId } : {}),
        ...(item.selectedUrl ? { selectedUrl: item.selectedUrl } : {}),
        ...(item.attempts ? { attempts: item.attempts } : {})
      }
      if (typeof item.body !== 'string') { report.push({ ...sourceReport, error: item.error ?? 'Источник недоступен' }); continue }
      try {
        const items = item.format === 'vpngate-csv' || /vpngate\.net\/api\/iphone\/?$/i.test(item.url)
          ? parseVpnGateCsv(item.body, CATALOG_POOL_LIMIT) : parseAny(item.body, CATALOG_POOL_LIMIT).items
        const protocols = new Map<string, { profile: Profile; source: string }[]>()
        for (const profile of items) {
          if (profile.kind === 'awg' || !publicCandidateEndpointsAllowed(profile)) continue
          const family = catalogFamily(profile)
          const group = protocols.get(family) ?? []
          group.push({ profile, source: item.url }); protocols.set(family, group)
          sourceReport.count++
        }
        // A mirror/source containing already-known entries is still a valid
        // response. Global deduplication is separate from source availability.
        sourceReport.ok = sourceReport.count > 0
        if (!sourceReport.ok) sourceReport.error = 'В источнике нет поддерживаемых узлов'
        if (sourceReport.ok) buckets.push(roundRobin([...protocols.values()]))
      } catch { sourceReport.error = 'Источник не удалось разобрать как список поддерживаемых узлов' }
      report.push(sourceReport)
    }
    this.metadata.sources = report
    if (buckets.length) {
      this.pool.ingest(roundRobin(buckets))
      for (const id of this.notes.keys()) if (!this.pool.entry(id)) this.notes.delete(id)
      this.metadata.updatedAt = this.now()
    }
    // Publish/persist ingestion before probing; a missing engine or partial
    // probe failure must not throw away downloaded recovery candidates.
    this.save()
    this.publish()
    if (probe && !abort.signal.aborted && this.allowStart()) await this.runProbes(abort, CHECK_TOTAL)
  }

  private async runProbes(abort: AbortController, limit: number, selected?: string[]): Promise<void> {
    const context = this.pool.context
    const active = () => !abort.signal.aborted && this.allowStart() && this.pool.context === context &&
      (!this.automaticWork || this.hasAutomaticOwners())
    if (!active()) return
    if (!this.checkerStopped || this.checker) { this.localError('Предыдущий проверочный движок не подтвердил остановку'); return }
    const sample = selected ? selected.map(id => this.pool.profile(id)).filter((profile): profile is NonNullable<typeof profile> => !!profile) : this.pool.plan(limit)
    this.metadata.planned = sample.length
    this.metadata.checked = 0
    this.metadata.checkIssue = undefined
    this.metadata.sources = this.metadata.sources.filter(source => source.url !== 'local checker')
    this.publish()
    if (!sample.length) { this.save(); return }
    const checker = new Checker(this.exe, join(this.dir, 'catalog-check'), active)
    let measured = 0, successful = 0, skipped = 0, engineFailed = false, cleanupAttempted = false
    const cleanup = () => { cleanupAttempted = true; return this.stopChecker(checker) }
    const note = (id: string, status: CandidateNote['status'], message: string) => {
      const at = this.now()
      this.notes.set(id, { context, at, retryAt: at + (status === 'unsupported' ? 10 * 60_000 : 60_000), status, message })
      skipped++
    }
    const measure = async (batch: NonNullable<ReturnType<CatalogPool['profile']>>[]): Promise<void> => {
      if (!batch.length || !active() || engineFailed) return
      this.checker = checker
      this.checkerStopped = false
      cleanupAttempted = false
      let ensured = false
      try { ensured = await checker.ensure(batch, []) }
      catch { /* An unavailable local worker is not a failed server measurement. */ }
      if (!ensured) {
        const failure = checker.lastFailure
        if (!(await cleanup())) { this.localError('Проверочный движок не подтвердил остановку'); engineFailed = true; return }
        if (!active()) return
        if (failure?.kind === 'configuration') {
          // A single malformed public outbound used to poison all eight nodes
          // in its process. Split only rejected configurations; do not repeat
          // ordinary timeouts or missing-engine failures per candidate.
          if (batch.length > 1) {
            const middle = Math.ceil(batch.length / 2)
            await measure(batch.slice(0, middle)); await measure(batch.slice(middle))
          } else note(batch[0].id, 'unsupported', failure.message)
        } else {
          this.localError(failure?.message ?? 'Проверочный движок не выполнил измерения; кандидаты сохранены')
          engineFailed = true
        }
        return
      }
      let pings: Record<string, number | undefined> = {}
      try { pings = await checker.pings() }
      finally {
        // No health claim is published until this exact native process stopped.
        if (!(await cleanup())) { this.localError('Проверочный движок не подтвердил остановку'); engineFailed = true }
      }
      if (!active() || engineFailed) return
      const at = this.now()
      for (const profile of batch) {
        if (!Object.prototype.hasOwnProperty.call(pings, profile.id)) continue
        this.notes.delete(profile.id)
        this.pool.observe(profile.id, pings[profile.id], context, at)
        measured++
        if (validLatency(pings[profile.id])) successful++
      }
      if (!Object.keys(pings).length) {
        this.localError('Проверочный движок завершился без результатов. Серверы не отмечены как недоступные.')
        engineFailed = true
      }
      this.metadata.checked = measured
      if (measured) this.metadata.verifiedAt = at
      this.save(); this.publish()
    }
    try {
      for (let offset = 0; offset < sample.length && active() && !engineFailed; offset += CHECK_BATCH) {
        const original = sample.slice(offset, offset + CHECK_BATCH)
        this.checking = new Set(original.map(profile => profile.id))
        this.publish()
        const prepared = await Promise.all(original.map(async profile => ({ profile,
          result: await preparePublicCandidateResult(profile, abort.signal, this.resolveCandidate) })))
        if (!active()) break
        for (const { profile, result } of prepared) {
          if (result.problem === 'dns') note(profile.id, 'dns-failed', 'Не удалось получить безопасный адрес сервера через DNS. Проверка повторится автоматически.')
          else if (result.problem) note(profile.id, 'unsupported', result.problem === 'unsafe'
            ? 'Источник указал локальный или некорректный адрес. Такой узел не проверяется.'
            : 'Конфигурацию нельзя проверить с сохранением адреса и имени сервера.')
        }
        await measure(prepared.flatMap(({ result }) => result.profile ? [result.profile] : []))
        this.checking.clear()
        this.save(); this.publish()
      }
    } catch { if (active()) { this.localError('Проверочный движок не завершил измерения. Серверы без результата остаются непроверенными.'); engineFailed = true } }
    finally {
      this.checking.clear()
      if (this.checker && !cleanupAttempted && !(await cleanup())) { this.localError('Проверочный движок не подтвердил остановку'); engineFailed = true }
    }
    if (!active()) { this.save(); return }
    if (!engineFailed && !successful) {
      if (measured) this.localError(`В этой проверке ${measured} серверов не ответили на HTTPS-запросы. Остальные кандидаты проверяются отдельно.`, 'unreachable')
      else if (skipped) {
        const dns = sample.filter(profile => this.notes.get(profile.id)?.status === 'dns-failed').length
        this.localError(dns
          ? `Для ${dns} серверов не удалось определить адрес через DNS. Это не проверка работоспособности самих серверов.`
          : `Для ${skipped} серверов конфигурация не подходит проверочному движку. Поиск продолжается среди остальных кандидатов.`, dns ? 'dns' : 'unsupported')
      }
    }
    this.save()
  }

  private stopChecker(checker = this.checker): Promise<boolean> {
    if (!checker || (checker !== this.checker && this.checkerStopped)) return Promise.resolve(this.checkerStopped)
    if (this.stopping) return this.stopping
    const stopping = checker.stop().catch(() => false).then(stopped => {
      if (this.checker === checker) {
        this.checkerStopped = stopped
        if (stopped) this.checker = undefined
      }
      return stopped
    }).finally(() => { if (this.stopping === stopping) this.stopping = undefined })
    this.stopping = stopping
    return stopping
  }

  private view(entry: CatalogEntry): CatalogNode {
    const profile = entry.profile, observation = entry.history.at(-1)
    const countryKey = `${profile.country ?? ''}|${profile.name}`
    let country = this.countryCache.get(countryKey)
    if (country === undefined) {
      country = profileCountry(profile)
      if (this.countryCache.size >= CATALOG_POOL_LIMIT * 2) this.countryCache.clear()
      this.countryCache.set(countryKey, country)
    }
    const host = catalogHost(profile)
    const ready = this.pool.ready(entry)
    const note = this.notes.get(profile.id)
    const currentNote = note?.context === this.pool.context ? note : undefined
    const status: CatalogNode['status'] = this.checking.has(profile.id) ? 'checking' : ready ? 'ready' :
      this.visibleIds.has(profile.id) && this.autoEligible(profile.id) ? 'queued' : currentNote?.status ?? this.pool.status(entry)
    return {
      id: profile.id, name: catalogLabel(profile.name, country, host), proto: profile.version, host, port: catalogPort(profile), country,
      ...(entry.sources[0] ? { source: sourceLabel(entry.sources[0]) } : {}),
      status, alive: ready,
      ...(currentNote ? { checkError: currentNote.message } : {}),
      ...(ready ? { ping: observation!.latency } : {}),
      ...(observation ? { checkedAt: observation.at } : {}),
      ...(entry.lastSuccessAt !== undefined ? { lastSuccessAt: entry.lastSuccessAt } : {}),
      ...(observation?.context === this.pool.context && !observation.ok ? { nextCheckAt: entry.nextProbeAt } : {})
    }
  }

  private localError(error: string, kind: NonNullable<CatalogState['checkIssue']>['kind'] = 'engine'): void {
    this.metadata.checkIssue = { kind, message: error }
    this.metadata.sources = [...this.metadata.sources.filter(source => source.url !== 'local checker'), { url: 'local checker', ok: false, count: 0, error }]
  }

  private save(): void {
    if (!safeStorage.isEncryptionAvailable()) { this.metadata.cacheError = 'Каталог хранится в памяти: защищённое хранилище недоступно'; return }
    const temporary = this.file + '.tmp'
    try {
      const { cacheError: _error, ...metadata } = this.metadata
      const sealed = safeStorage.encryptString(JSON.stringify({ metadata: { ...metadata, busy: false }, pool: this.pool.data() })).toString('base64')
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temporary, JSON.stringify({ version: 2, sealed }), { mode: 0o600 })
      protectPrivateFile(temporary)
      renameSync(temporary, this.file)
      delete this.metadata.cacheError
    } catch {
      this.metadata.cacheError = 'Обновлённый каталог не удалось сохранить; прежний файл остаётся доступен'
      try { rmSync(temporary, { force: true }) } catch { /* no plaintext fallback */ }
    }
  }

  private publish(): void {
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = undefined }
    const now = this.now()
    const expiration = this.pool.all().filter(entry => this.pool.ready(entry, now)).reduce((earliest, entry) =>
      Math.min(earliest, entry.history.at(-1)!.at + CATALOG_READY_TTL), Infinity)
    // Idle UI also loses a stale ready badge, even without another user action.
    if (Number.isFinite(expiration)) {
      this.expiryTimer = setTimeout(() => this.publish(), Math.max(1, expiration - now + 1))
      this.expiryTimer.unref()
    }
    this.onChange(this.state)
  }
}
