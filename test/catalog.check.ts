import { createHash } from 'node:crypto'
// Real Catalog orchestration with injected source data and fake measuring-core
// methods. No native process, TUN, external request or system network change.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Catalog, type CatalogState, type CatalogSourceText } from '../src/main/catalog'
import { CATALOG_READY_TTL } from '../src/main/catalog-pool'
import { Checker } from '../src/main/checker'
import { parseLink } from '../src/main/links'
import { credentialKey } from '../src/main/discovery'
import { PublicPathCleanupError } from '../src/main/public-service-path'
import type { Profile } from '../src/shared/types'
import { stub } from './stubs/electron'

let failures = 0, checks = 0
const ok = (value: unknown, name: string) => { checks++; if (!value) { failures++; console.error('FAIL', name) } }
const eq = (actual: unknown, expected: unknown, name: string) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const source = 'https://raw.githubusercontent.com/example/offline-fixture/main/servers.txt'
const body = 'trojan://fixture-password@server.example:443#Fixture'
const dirs: string[] = []
const original = { ensure: Checker.prototype.ensure, pings: Checker.prototype.pings, stop: Checker.prototype.stop, secure: stub.secure }
const profiles = new WeakMap<Checker, Profile[]>()
let fetched = 0, ensured = 0, stopped = 0, clock = 0
let read: (sources: string[], signal: AbortSignal) => Promise<CatalogSourceText[]>
let ensure: () => Promise<boolean>
let ping: (profiles: Profile[]) => Promise<Record<string, number | undefined>>
let stop: () => Promise<boolean>
const reset = () => {
  fetched = ensured = stopped = 0
  clock = 1_800_000_000_000
  stub.secure = true
  read = async sources => sources.map(url => ({ url, body }))
  ensure = async () => true
  ping = async current => Object.fromEntries(current.map(profile => [profile.id, 10]))
  stop = async () => true
}
const make = (allowed: () => boolean = () => true, existing?: string) => {
  const dir = existing ?? mkdtempSync(join(tmpdir(), 'waarp-catalog-test-'))
  if (!existing) dirs.push(dir)
  const updates: CatalogState[] = []
  const catalog = new Catalog(dir, join(dir, 'missing-engine.exe'), state => updates.push(state), allowed,
    (sources, signal) => { fetched++; return read(sources, signal) }, () => clock, async () => [{ address: '1.1.1.1', family: 4 }])
  return { catalog, updates, dir }
}

;(async () => {
  Checker.prototype.ensure = async function (current) { ensured++; profiles.set(this, current); return ensure() }
  Checker.prototype.pings = async function () { return ping(profiles.get(this) ?? []) }
  Checker.prototype.stop = async function () { stopped++; return stop() }
  try {
    {
      reset()
      const { catalog, updates } = make(() => false)
      await catalog.refresh([source])
      await catalog.verify()
      eq([fetched, ensured, updates.length], [0, 0, 0], 'open TUN gate refuses combined refresh/probes without fake progress')
      eq(await catalog.pause(), true, 'idle pause is a clean no-op')
      const ingested = await catalog.refresh([source], { probe: false })
      eq([fetched, ensured, ingested.total, ingested.readyCount], [1, 0, 1, 0], 'fetch-only refresh can ingest while the main core is on without starting a checker')
      eq(ingested.cached[0]?.status, 'unverified', 'download success does not mean node readiness')
    }
    {
      reset()
      const { catalog, updates } = make()
      await catalog.refresh([source])
      const savedId = catalog.state.alive[0].id
      let aborted = false
      read = (_sources, signal) => new Promise<CatalogSourceText[]>((_resolve, reject) => {
        const cancel = () => { aborted = true; reject(new Error('fixture cancellation')) }
        if (signal.aborted) cancel()
        else signal.addEventListener('abort', cancel, { once: true })
      })
      const beforeEnsure = ensured
      const first = catalog.refresh([source]), duplicate = catalog.refresh([source])
      eq(first === duplicate, true, 'duplicate refresh calls share exactly one pending operation')
      eq(catalog.state.busy, true, 'download publishes busy state')
      eq(await catalog.pause(), true, 'pause waits for cancelled downloads to settle')
      await first
      eq([aborted, ensured, catalog.state.busy], [true, beforeEnsure, false], 'download cancellation cannot start the measuring core')
      eq(catalog.state.alive[0]?.id, savedId, 'cancelling source loading does not replace a current ready observation')
      eq(updates.at(-1)?.busy, false, 'last cancellation event is settled')
      read = async sources => sources.map(url => ({ url, body: 'no supported nodes' }))
      await catalog.refresh([source], { probe: false })
      eq(catalog.state.total, 1, 'empty source does not erase the existing reservoir')
    }
    {
      reset()
      let allowed = true
      const response = deferred<CatalogSourceText[]>()
      read = () => response.promise
      const { catalog } = make(() => allowed)
      const pending = catalog.refresh([source])
      allowed = false
      response.resolve([{ url: source, body }])
      await pending
      eq([ensured, stopped], [0, 0], 'late source data cannot start a checker after admission closes')
      eq([catalog.state.total, catalog.state.readyCount], [1, 0], 'late data is safely retained as candidates without probes')
    }
    {
      reset()
      const entered = deferred<void>(), measurements = deferred<Record<string, number | undefined>>()
      let current: Profile[] = []
      ping = items => { current = items; entered.resolve(undefined); return measurements.promise }
      stop = async () => { measurements.resolve(Object.fromEntries(current.map(profile => [profile.id, 1]))); return true }
      const { catalog, updates } = make()
      const refresh = catalog.refresh([source])
      await entered.promise
      eq(ensured, 1, 'a supported source reaches one measuring batch')
      eq(await catalog.pause(), true, 'pause confirms checker cleanup before resolving')
      await refresh
      eq(stopped, 1, 'concurrent cancellation and finally share the same checker cleanup')
      eq([catalog.state.total, catalog.state.readyCount], [1, 0], 'late cancelled success cannot become ready, but ingestion survives')
      eq(updates.at(-1)?.busy, false, 'checker cancellation does not leave a perpetual busy indicator')
    }
    {
      reset()
      stop = async () => stopped > 1
      const { catalog } = make()
      const failed = await catalog.refresh([source])
      eq([ensured, stopped, failed.busy], [1, 1, false], 'unconfirmed cleanup completes with a visible failure')
      ok(failed.sources.some(item => item.url === 'local checker' && !item.ok), 'unconfirmed stop is reported')
      eq([failed.total, failed.readyCount], [1, 0], 'unconfirmed cleanup retains candidates but commits no successful observations')
      await catalog.verify()
      eq(ensured, 1, 'another verification cannot replace a checker whose stop is unconfirmed')
      eq(await catalog.pause(), true, 'later pause retries the retained exact checker')
      eq(stopped, 2, 'retry uses one additional bounded stop')
      eq(await catalog.pause(), true, 'confirmed cleanup remains clean')
      eq(stopped, 2, 'released checker is not signalled again')
    }
    {
      reset()
      stop = async () => false
      const { catalog } = make()
      await catalog.refresh([source])
      eq(await catalog.pause(), false, 'persistently unconfirmed cleanup prevents a successful pause')
      stop = async () => true
      eq(await catalog.pause(), true, 'cleanup can recover on a later explicit attempt')
      eq(stopped, 3, 'recovery did not lose the failed-cleanup process handle')
    }
    {
      reset()
      const { catalog } = make()
      await catalog.refresh([source])
      const id = catalog.state.alive[0].id
      clock++
      ping = async current => Object.fromEntries(current.map(profile => [profile.id, undefined]))
      const failed = await catalog.refresh([source])
      eq([failed.total, failed.readyCount, failed.alive.length], [1, 0, 0], 'all-failed recheck cannot resurrect the previous ready list')
      eq(failed.cached[0]?.status, 'failed', 'a measured failure is visible separately from historical success')
      ok(failed.cached[0]?.lastSuccessAt, 'failed recheck keeps historical success for future recovery ordering')
      eq(failed.cached[0]?.ping, undefined, 'a cached/failed candidate never displays old latency as current')
      ok(catalog.node(id), 'failed candidate remains explicitly importable by its stable ID')
      const before = ensured
      await catalog.verify()
      eq(ensured, before, 'failure cooldown prevents an immediate repeated network probe')
      catalog.invalidateNetwork('another network')
      ping = async current => Object.fromEntries(current.map(profile => [profile.id, 9]))
      await catalog.verify()
      eq(catalog.state.readyCount, 1, 'new network allows rechecking despite the old network failure cooldown')
    }
    {
      reset()
      const { catalog } = make()
      await catalog.refresh([source])
      ping = async () => ({})
      await catalog.verify()
      eq(catalog.state.readyCount, 1, 'disappearing checker is not misclassified as a measured server failure')
      clock += CATALOG_READY_TTL
      eq([catalog.state.readyCount, catalog.state.alive.length], [0, 0], 'state getter expires readiness even without another operation')
      eq(catalog.state.cached[0]?.status, 'cached', 'expired success remains labeled as cached history')
    }
    {
      reset()
      const { catalog } = make()
      await catalog.refresh([source])
      eq(catalog.invalidateNetwork('network-A'), true, 'first network context change invalidates readiness')
      eq(catalog.state.readyCount, 0, 'network invalidation immediately clears the ready projection')
      await catalog.verify()
      eq(catalog.invalidateNetwork('network-A'), false, 'duplicate network notification does not invalidate a fresh recheck')
      eq(catalog.state.readyCount, 1, 'same network fingerprint retains fresh evidence')
      const entered = deferred<void>(), measurements = deferred<Record<string, number | undefined>>()
      let current: Profile[] = []
      ping = items => { current = items; entered.resolve(undefined); return measurements.promise }
      stop = async () => { measurements.resolve(Object.fromEntries(current.map(profile => [profile.id, 1]))); return true }
      const pending = catalog.verify()
      await entered.promise
      catalog.invalidateNetwork('network-B')
      await pending
      eq(catalog.state.readyCount, 0, 'late in-flight measurement from the previous network is ignored')
    }
    {
      reset()
      const a = 'trojan://same-pass@node.example:443?sni=a.example#A', b = 'trojan://same-pass@node.example:443?sni=b.example#B'
      read = async sources => sources.map(url => ({ url, body: [a, b, a].join('\n') }))
      const { catalog, dir } = make()
      const initial = await catalog.refresh([source])
      eq([initial.total, initial.alive.length], [2, 2], 'exact duplicate merges while different SNI configurations remain independent')
      const bindings = initial.alive.map(node => [node.id, (catalog.node(node.id) as any)?.outbound.tls.server_name]).sort()
      read = async sources => sources.map(url => ({ url, body: b }))
      await catalog.refresh([source])
      eq(catalog.state.total, 2, 'temporary absence from a source does not discard another cached config')
      eq(catalog.state.alive.map(node => [node.id, (catalog.node(node.id) as any)?.outbound.tls.server_name]).sort(), bindings, 'partial source updates cannot rebind existing IDs')
      const contents = readFileSync(join(dir, 'catalog.json'), 'utf8')
      eq(JSON.parse(contents).version, 2, 'reservoir persists in the versioned encrypted cache')
      ok(!contents.includes('same-pass') && !contents.includes('node.example'), 'at-rest file has no plaintext endpoint or credentials')
      const restored = make(() => true, dir).catalog
      eq([restored.state.total, restored.state.readyCount], [2, 0], 'restart retains candidate configs but never restores ready')
      eq(restored.recoveryCandidates().map(node => node.id).sort(), initial.alive.map(node => node.id).sort(), 'historical successes remain bounded recovery options')
      eq(restored.state.cached.map(node => [node.id, (restored.node(node.id) as any)?.outbound.tls.server_name]).sort(), bindings, 'encrypted restart preserves the exact SNI behind each imported ID')
      await restored.verify()
      eq(restored.state.readyCount, 2, 'cached records can be reverified without downloading any source')
    }
    {
      reset()
      const profile = parseLink(body)!
      const legacyId = 'pub-' + createHash('sha256').update('trojan|server.example|443|fixture-password').digest('hex').slice(0, 20)
      profile.id = legacyId
      const { dir } = make()
      const state = { updatedAt: clock, alive: [{ id: legacyId, ping: 20, checkedAt: clock, alive: true }] }
      const old = { nodes: [profile], identities: [[credentialKey(profile), legacyId]], state }
      writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ version: 1, sealed: Buffer.from('enc:' + JSON.stringify(old)).toString('base64') }))
      const migrated = make(() => true, dir).catalog
      eq([migrated.state.total, migrated.state.readyCount, migrated.state.cached[0]?.id], [1, 0, legacyId], 'v1 migration preserves saved IDs without restoring old ready state')
      await migrated.refresh([source], { probe: false })
      eq(migrated.state.cached[0]?.id, legacyId, 'new source ingestion keeps the migrated ID')
      eq(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')).version, 2, 'next successful save atomically upgrades the encrypted cache')
    }
    {
      reset()
      const { catalog, dir } = make()
      const second = source + '?second'
      read = async sources => sources.map(url => ({ url, body }))
      await catalog.refresh([source, second], { probe: false })
      eq(catalog.state.total, 1, 'overlapping sources produce one candidate')
      ok(catalog.state.sources.every(item => item.ok && item.count === 1), 'a duplicate-only source is correctly reported as a successful source')
      read = async sources => sources.map(url => ({ url, error: 'fixture unavailable' }))
      await catalog.refresh([source, second], { probe: false })
      eq(catalog.state.total, 1, 'every source being blocked preserves saved candidates')
      const restored = make(() => true, dir).catalog
      eq(restored.state.total, 1, 'failed source response does not replace the durable pool with an empty list')
      stub.secure = false
      await catalog.refresh([source], { probe: false })
      ok(catalog.state.cacheError, 'unavailable encryption is visible instead of pretending persistence succeeded')
      ok(existsSync(join(dir, 'catalog.json')), 'unavailable encryption never removes the previously encrypted cache')
    }
    {
      reset()
      const { catalog } = make()
      await catalog.refresh([source], { probe: false })
      const cached = catalog.state.cached.map(node => node.id)
      read = async () => { throw new PublicPathCleanupError() }
      const result = await catalog.refresh([source])
      eq([ensured, stopped, result.readyCount], [0, 0, 0], 'fatal loader cleanup cannot fall through into a second native checker')
      eq(result.cached.map(node => node.id), cached, 'fatal loader cleanup preserves cached candidate identities')
      ok(result.sources.some(item => item.error?.includes('Движок загрузки не подтвердил остановку')), 'fatal loader cleanup is reported distinctly from a blocked source')
    }
    {
      reset()
      read = async sources => sources.map(url => ({ url, body: Array.from({ length: 24 }, (_, index) => `trojan://fixture-${index}@node-${index}.example:443#Node-${index}`).join('\n') }))
      const { catalog, dir } = make()
      await catalog.refresh([source], { probe: false })
      const first = catalog.recoveryCandidates(8)
      const restored = make(() => true, dir).catalog
      const second = restored.recoveryCandidates(8)
      ok(second.every(candidate => !first.some(previous => previous.id === candidate.id)), 'Catalog persists recovery progress before another process chooses paths')
      eq([restored.state.total, restored.state.readyCount], [24, 0], 'recovery selection changes neither candidate count nor readiness')
    }
    {
      reset()
      ensure = async () => false
      const { catalog, dir } = make()
      read = async sources => sources.map(url => ({ url, body: Array.from({ length: 250 }, (_, index) => `trojan://fixture-${index}@node-${index}.example:443#Node-${index}`).join('\n') }))
      await catalog.refresh([source])
      eq([catalog.state.total, catalog.state.readyCount, catalog.state.checked], [250, 0, 0], 'missing engine preserves all downloaded candidates without inventing failed measurements')
      const restored = make(() => true, dir).catalog
      eq(restored.state.total, 250, 'persistence stores the candidate reservoir, not only the ready shortlist')
      eq(restored.state.cached.length, 200, 'large cache exposes a bounded renderer shortlist')
    }
    {
      reset()
      const { catalog } = make()
      read = async sources => sources.map(url => ({ url, body: Array.from({ length: 260 }, (_, index) =>
        `trojan://fixture-${index}@node-${index}.example:443#${index % 2 ? 'DE-Germany' : 'JP-Japan'}-${index}`).join('\n') }))
      await catalog.refresh([source], { probe: false })
      const visited = new Set<string>()
      for (let page = 1; page <= 26; page++) {
        const result = catalog.page({ page, pageSize: 10 })
        eq([result.page, result.pages, result.total, result.items.length], [page, 26, 260, 10], 'complete reservoir page ' + page)
        result.items.forEach(node => visited.add(node.id))
      }
      eq(visited.size, 260, 'pagination reaches every cached candidate once, including beyond old 200-item preview')
      const europe = catalog.page({ region: 'eu', pageSize: 100 })
      eq([europe.total, europe.regions.find(item => item.id === 'asia')?.total], [130, 130], 'region filter and facets count the complete pool')
      eq(catalog.page({ query: 'Германия' }).total, 130, 'Russian country search reaches all German candidates')
      eq(catalog.page({ query: 'Japan' }).total, 130, 'English country search reaches all Japanese candidates')
      const selected = catalog.page({ query: 'node-249.example' }).items[0]
      ok(selected, 'search finds a candidate outside the old preview')
      let lastMeasured: string[] = []
      ping = async current => { lastMeasured = current.map(profile => profile.id); return Object.fromEntries(current.map(profile => [profile.id, 12])) }
      eq((await catalog.verifyNode(selected.id)).ok, true, 'click verifies an exact saved candidate without a separate precheck')
      eq(lastMeasured, [selected.id], 'on-demand verification never substitutes another available node')
      eq([catalog.page({ readyOnly: true }).total, catalog.page({ readyOnly: true }).items[0]?.id], [1, selected.id], 'only measured success enters the working-server filter')
      const before = ensured
      eq((await catalog.verifyNode(selected.id)).ok, true, 'fresh evidence can be reused for an immediate second selection')
      eq(ensured, before, 'a fresh ready selection does not start another checker')
      clock += CATALOG_READY_TTL
      ping = async current => Object.fromEntries(current.map(profile => [profile.id, undefined]))
      const failure = await catalog.verifyNode(selected.id)
      eq(failure.ok, false, 'unreachable selected candidate is rejected, not silently imported as working')
      ok(failure.error, 'failed candidate selection gives an actionable reason')
      ping = async current => Object.fromEntries(current.map(profile => [profile.id, 9]))
      eq((await catalog.verifyNode(selected.id)).ok, true, 'an explicit retry may verify a candidate during automatic failure cooldown')
      eq([catalog.page({ page: Infinity, pageSize: 0 }).page, catalog.page({ page: 999999, pageSize: 1000 }).items.length], [1, 60], 'invalid and oversized page inputs are bounded')
      eq((await catalog.verifyNode('missing')).ok, false, 'unknown selected ID cannot start a native check')
    }
    {
      reset()
      const { catalog } = make()
      read = async sources => sources.map(url => ({ url, body: Array.from({ length: 20 }, (_, index) =>
        `trojan://fixture-${index}@node-${index}.example:443#Node-${index}`).join('\n') }))
      await catalog.refresh([source], { probe: false })
      const target = catalog.page({ query: 'node-19.example' }).items[0]
      const entered = deferred<void>(), oldMeasurements = deferred<Record<string, number | undefined>>()
      let first = true, oldIds: string[] = [], selectedIds: string[] = []
      ping = async current => {
        if (first) { first = false; oldIds = current.map(profile => profile.id); entered.resolve(undefined); return oldMeasurements.promise }
        selectedIds = current.map(profile => profile.id)
        return Object.fromEntries(current.map(profile => [profile.id, 17]))
      }
      stop = async () => { oldMeasurements.resolve(Object.fromEntries(oldIds.map(id => [id, 1]))); return true }
      const batch = catalog.verify()
      await entered.promise
      const picked = await catalog.verifyNode(target.id)
      await batch
      eq([picked.ok, selectedIds, catalog.state.readyCount], [true, [target.id], 1], 'a row click preempts a busy pool safely and only publishes the exact selected measurement')
      eq(stopped, 2, 'old batch and selected candidate each confirm isolated checker cleanup')
    }
    {
      reset()
      const { catalog, updates } = make()
      read = async sources => sources.map(url => ({ url, body: Array.from({ length: 20 }, (_, index) =>
        `trojan://fixture-${index}@node-${index}.example:443#Node-${index}`).join('\n') }))
      await catalog.refresh([source], { probe: false })
      const entered = deferred<void>(), remaining = deferred<Record<string, number | undefined>>()
      let round = 0
      ping = async current => {
        if (++round > 1) { entered.resolve(undefined); return remaining.promise }
        return Object.fromEntries(current.map(profile => [profile.id, 11]))
      }
      stop = async () => { if (round > 1) remaining.resolve({}); return true }
      const checking = catalog.verify()
      await entered.promise
      ok(updates.some(state => state.busy && state.checked === 8 && state.readyCount === 8), 'working first batch is visible before the whole pool round finishes')
      await catalog.pause(); await checking
      eq(catalog.state.readyCount, 8, 'cancelling the remaining round retains already cleaned-up real observations')
    }
  } finally {
    Checker.prototype.ensure = original.ensure
    Checker.prototype.pings = original.pings
    Checker.prototype.stop = original.stop
    stub.secure = original.secure
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
  console.log(`catalog.check: ${checks} checks`)
  if (failures) { console.error(`${failures} failed`); process.exit(1) }
})().catch(error => { console.error(error); process.exit(1) })
