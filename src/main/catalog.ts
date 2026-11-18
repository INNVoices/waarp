// Public lists feed a persistent, encrypted candidate pool. Checking candidates
// never changes application routes; only fresh observations enter the ready list.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Profile } from '../shared/types'
import { atlasCountry, projectAtlas, type AtlasProjection } from '../shared/atlas'
import { parseAny } from './links'
import { Checker } from './checker'
import { catalogLabel, roundRobin, sourceLabel } from './catalog-sample'
import { RuntimeJournal } from './runtime-journal'
import { parseVpnGateCsv } from './vpngate'
import { protectPrivateFile } from './private-file'
import { validLatency } from './health'
import { preparePublicCandidate, publicCandidateEndpointsAllowed } from './catalog-endpoint'
import { PublicPathCleanupError } from './public-service-path'
import type { PublicResolver } from './vless'
import { DEFAULT_SOURCES } from '../shared/public-sources'
import { fetchCatalogSources, type CatalogSourceText } from './catalog-fetch'
import { CatalogPool, CATALOG_POOL_LIMIT, CATALOG_READY_TTL, catalogFamily, catalogHost, catalogPort, type CatalogEntry } from './catalog-pool'

export { DEFAULT_SOURCES } from '../shared/public-sources'
export { fetchCatalogSources, type CatalogSourceText } from './catalog-fetch'

const CHECK_BATCH = 8
const CHECK_TOTAL = 64
const READY_PREVIEW = 50
const CACHED_PREVIEW = 200
const MAX_CACHE_BYTES = 96 * 1024 * 1024

export interface CatalogNode {
  id: string; name: string; proto: string; host: string; port: number; country: string; source?: string
  ping?: number; alive?: boolean; checkedAt?: number; lastSuccessAt?: number; nextCheckAt?: number
  status?: 'ready' | 'cached' | 'failed' | 'unverified'
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
}

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
          source && typeof source.url === 'string' && typeof source.ok === 'boolean' && Number.isFinite(source.count))
      }
    } catch { this.metadata.cacheError = 'Сохранённый каталог не удалось прочитать' }
  }

  /** Freshness is evaluated when read, not frozen in the last emitted event. */
  get state(): CatalogState { return this.snapshot() }
  snapshot(): CatalogState {
    const now = this.now()
    return {
      ...this.metadata, sources: structuredClone(this.metadata.sources),
      total: this.pool.size, cachedCount: this.pool.size,
      readyCount: this.pool.all().filter(entry => this.pool.ready(entry, now)).length,
      alive: this.bestReady(READY_PREVIEW), cached: this.pool.cached(CACHED_PREVIEW).map(entry => this.view(entry))
    }
  }

  node(id: string): Profile | undefined { return this.pool.profile(id) }
  bestReady(limit = 5): CatalogNode[] { return this.pool.bestReady(limit).map(entry => this.view(entry)) }
  /** Page the complete reservoir in main. The small event snapshot is only a
   * summary; its first 200 candidates must never truncate search or navigation. */
  page(input: unknown = {}): CatalogPage {
    const request = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    const query = typeof request.query === 'string' ? request.query.trim().slice(0, 200).toLocaleLowerCase('ru') : ''
    const region = REGIONS.some(item => item.id === request.region) ? request.region as CatalogRegion : undefined
    const country = typeof request.country === 'string' && request.country ? atlasCountry(request.country) : undefined
    const bounded = (value: unknown, fallback: number, maximum: number) => typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback
    const pageSize = bounded(request.pageSize, 12, 100)
    const rank = (node: CatalogNode) => node.status === 'ready' ? 0 : node.status === 'cached' ? 1 : node.status === 'failed' ? 3 : 2
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

  private start(work: (abort: AbortController) => Promise<void>, probe: boolean): Promise<CatalogState> {
    if (this.pending) return this.pending
    if (probe && !this.allowStart()) return Promise.resolve(this.state)
    const abort = new AbortController()
    this.abort = abort
    this.metadata = { ...this.metadata, busy: true, planned: 0, checked: 0 }
    this.publish()
    this.pending = work(abort).catch(error => {
      if (!abort.signal.aborted) this.localError(error instanceof PublicPathCleanupError
        ? 'Движок загрузки не подтвердил остановку; новые проверки не запускались, кандидаты сохранены'
        : 'Обновление прервано; сохранённые кандидаты остаются в каталоге')
    }).finally(() => {
      this.pending = undefined; this.abort = undefined
      this.metadata.busy = false
      if (this.checkerStopped) this.checker = undefined
      this.publish()
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
    const active = () => !abort.signal.aborted && this.allowStart() && this.pool.context === context
    if (!active()) return
    if (!this.checkerStopped || this.checker) { this.localError('Предыдущий проверочный движок не подтвердил остановку'); return }
    const sample = selected ? selected.map(id => this.pool.profile(id)).filter((profile): profile is NonNullable<typeof profile> => !!profile) : this.pool.plan(limit)
    this.metadata.planned = sample.length
    this.metadata.checked = 0
    this.metadata.sources = this.metadata.sources.filter(source => source.url !== 'local checker')
    this.publish()
    if (!sample.length) { this.save(); return }
    const checker = new Checker(this.exe, join(this.dir, 'catalog-check'), active)
    this.checker = checker
    this.checkerStopped = false
    let started = 0, measured = 0, successful = 0, preparedCount = 0, cleanupAttempted = false
    try {
      for (let offset = 0; offset < sample.length && active(); offset += CHECK_BATCH) {
        const prepared = await Promise.all(sample.slice(offset, offset + CHECK_BATCH).map(profile => preparePublicCandidate(profile, abort.signal, this.resolveCandidate)))
        const batch = prepared.filter((profile): profile is NonNullable<typeof profile> => !!profile)
        if (!active()) break
        if (!batch.length) continue
        preparedCount += batch.length
        this.checker = checker
        this.checkerStopped = false
        cleanupAttempted = false
        if (!(await checker.ensure(batch, []))) continue
        started++
        const pings = await checker.pings()
        if (!active()) break
        // Publish each completed batch promptly. A user can select a working
        // server while the rest are still being checked; the process that
        // measured that batch must first confirm its own cleanup.
        const stopped = await this.stopChecker(checker)
        cleanupAttempted = true
        if (!stopped) break
        if (!active()) break
        const at = this.now()
        for (const profile of batch) {
          // An empty map means the checker disappeared/cancelled. Its explicit
          // id -> undefined result means that this outbound was really tried.
          if (!Object.prototype.hasOwnProperty.call(pings, profile.id)) continue
          this.pool.observe(profile.id, pings[profile.id], context, at)
          measured++
          if (validLatency(pings[profile.id])) successful++
        }
        this.metadata.checked = measured
        if (measured) this.metadata.verifiedAt = at
        this.save()
        this.publish()
      }
    } catch { if (active()) this.localError('Проверочный движок не завершил все измерения') }
    finally { if (!cleanupAttempted) await this.stopChecker(checker) }
    if (!active()) { this.save(); return }
    if (!this.checkerStopped) { this.localError('Проверочный движок не подтвердил остановку'); this.save(); return }
    if (!preparedCount) this.localError('Адреса серверов не удалось безопасно проверить. Выбери другой сервер или повтори проверку позже.')
    else if (!started || !measured) this.localError('Проверочный движок не выполнил измерения; кандидаты сохранены')
    else if (!successful) this.localError('Проверенные серверы не ответили через интернет. Выбери другой сервер или повтори проверку позже.')
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
    const country = countryOf(profile.name), host = catalogHost(profile)
    const ready = this.pool.ready(entry)
    return {
      id: profile.id, name: catalogLabel(profile.name, country, host), proto: profile.version, host, port: catalogPort(profile), country,
      ...(entry.sources[0] ? { source: sourceLabel(entry.sources[0]) } : {}),
      status: this.pool.status(entry), alive: ready,
      ...(ready ? { ping: observation!.latency } : {}),
      ...(observation ? { checkedAt: observation.at } : {}),
      ...(entry.lastSuccessAt !== undefined ? { lastSuccessAt: entry.lastSuccessAt } : {}),
      ...(observation?.context === this.pool.context && !observation.ok ? { nextCheckAt: entry.nextProbeAt } : {})
    }
  }

  private localError(error: string): void {
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
