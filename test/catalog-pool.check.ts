// Offline behavioral checks: no process, network, resolver or system route.
import { createHash } from 'node:crypto'
import { CatalogPool, CATALOG_POOL_LIMIT, CATALOG_READY_TTL, catalogHost } from '../src/main/catalog-pool'
import { parseLink } from '../src/main/links'
import { credentialKey } from '../src/main/discovery'
import type { Profile } from '../src/shared/types'

let checks = 0, failures = 0
const ok = (value: unknown, name: string) => { checks++; if (!value) { failures++; console.error('FAIL', name) } }
const eq = (actual: unknown, expected: unknown, name: string) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
const source = 'https://fixtures.example/list'
const profile = (index: number, host = `node-${index}.example`, scheme = 'trojan'): Profile =>
  parseLink(`${scheme}://fixture-password-${index}@${host}:443#Node-${index}`)!
const inputs = (count: number) => Array.from({ length: count }, (_, index) => ({ profile: profile(index), source }))

{
  let now = 100_000
  const pool = new CatalogPool(() => now)
  pool.ingest(inputs(180))
  const tried = new Set<string>()
  for (let round = 0; round < 3; round++) {
    const batch = pool.plan()
    for (const candidate of batch) {
      tried.add(candidate.name)
      pool.observe(candidate.id, candidate.name === 'Node-179' ? 35 : undefined, pool.context)
    }
    now++ // earlier failures are still cooling down
  }
  eq(tried.size, 180, 'stable source order cannot starve the last candidates behind a failing prefix')
  eq(pool.bestReady()[0]?.profile.name, 'Node-179', 'a working tail entry becomes ready within bounded rounds')
  eq(pool.size, 180, 'failed and untested candidates are not discarded after checking')
  const duringCooldown = pool.plan()
  ok(duringCooldown.every(candidate => candidate.name === 'Node-179'), 'failed candidates respect cooldown instead of consuming every refresh')
  now += 30_000
  ok(pool.plan().some(candidate => candidate.name !== 'Node-179'), 'failed candidates become eligible again after cooldown')
}

{
  const now = 500_000
  const pool = new CatalogPool(() => now)
  pool.ingest(inputs(130))
  for (const candidate of pool.plan()) pool.observe(candidate.id, undefined, pool.context)
  const saved = JSON.parse(JSON.stringify(pool.data()))
  const restored = new CatalogPool(() => now)
  restored.restore(saved)
  eq(restored.plan()[0]?.name, 'Node-64', 'persistent cursor resumes discovery after process restart')
  eq(restored.size, 130, 'the encrypted reservoir can round-trip failures and untried candidates')
}

{
  const pool = new CatalogPool(() => 600_000)
  pool.ingest(inputs(24))
  for (const entry of pool.all().slice(0, 3)) pool.observe(entry.profile.id, 20, pool.context)
  const first = pool.recoveryCandidates(8), second = pool.recoveryCandidates(8)
  eq(first.slice(0, 3).map(candidate => candidate.name), ['Node-0', 'Node-1', 'Node-2'], 'bootstrap keeps a small known-success preference')
  eq(second.slice(0, 3).map(candidate => candidate.name), first.slice(0, 3).map(candidate => candidate.name), 'preferred historical head stays available on the next recovery attempt')
  ok(second.slice(3).every(candidate => !first.some(previous => previous.id === candidate.id)), 'all-failed list recovery progresses beyond the previous top eight without inventing node failures')
  const restored = new CatalogPool(() => 600_000)
  restored.restore(JSON.parse(JSON.stringify(pool.data())))
  const third = restored.recoveryCandidates(8)
  eq(third.slice(3).map(candidate => candidate.name), ['Node-13', 'Node-14', 'Node-15', 'Node-16', 'Node-17'], 'recovery cursor resumes after serialization and restart')
  eq(pool.plan(8).map(candidate => candidate.name), Array.from({ length: 8 }, (_, index) => `Node-${index}`), 'bootstrap rotation does not consume or alter the native probe cursor')
  eq(pool.bestReady().length, 3, 'choosing recovery candidates neither adds failures nor promotes untested nodes')
}

{
  let now = 1_000_000
  const pool = new CatalogPool(() => now)
  pool.ingest(inputs(1))
  const candidate = pool.plan()[0]
  const initialContext = pool.context
  pool.observe(candidate.id, 0, initialContext)
  eq(pool.bestReady().length, 1, 'zero milliseconds is a valid successful measurement')
  const restored = new CatalogPool(() => now)
  restored.restore(JSON.parse(JSON.stringify(pool.data())))
  eq(restored.bestReady().length, 0, 'restart never resurrects even a recent ready result')
  eq(restored.recoveryCandidates()[0]?.id, candidate.id, 'historical successes remain useful recovery candidates after restart')
  eq(restored.status(restored.entry(candidate.id)!), 'cached', 'restored successful history is labeled cached')
  now += CATALOG_READY_TTL
  eq(pool.bestReady().length, 0, 'TTL expiration removes ready without requiring an extra probe')
  pool.observe(candidate.id, 10, pool.context)
  now--
  eq(pool.bestReady().length, 0, 'clock rollback cannot make future-dated observations ready')
  now += 2
  pool.observe(candidate.id, undefined, pool.context)
  eq(pool.bestReady().length, 0, 'a failed recheck immediately invalidates the previous success')
  eq(pool.recoveryCandidates().length, 0, 'current-network failed cooldown is not presented as a recovery path')
  pool.invalidate()
  eq(pool.plan().length, 1, 'network invalidation releases the old network failure cooldown')
  pool.observe(candidate.id, 1, initialContext)
  eq(pool.bestReady().length, 0, 'late results from the prior network cannot restore readiness')
  pool.observe(candidate.id, Number.NaN, pool.context)
  eq(pool.bestReady().length, 0, 'NaN is not accepted as a successful probe')
}

{
  const pool = new CatalogPool(() => 2_000_000)
  const a = parseLink('trojan://same-pass@same.example:443?sni=a.example#A')!
  const b = parseLink('trojan://same-pass@same.example:443?sni=b.example#B')!
  pool.ingest([{ profile: a, source }, { profile: b, source }, { profile: a, source: source + '-mirror' }])
  eq(pool.size, 2, 'exact duplicates merge, but different effective TLS configurations stay distinct')
  const initial = pool.all().map(entry => [entry.profile.id, entry.profile.name]).sort()
  pool.ingest([{ profile: b, source }, { profile: a, source }])
  eq(pool.all().map(entry => [entry.profile.id, entry.profile.name]).sort(), initial, 'source reordering cannot change configuration IDs')
  eq(pool.all().find(entry => entry.profile.name === 'A')?.sources.length, 2, 'duplicate-source provenance survives global deduplication')
  const legacy = 'pub-' + createHash('sha256').update('trojan|same.example|443|same-pass').digest('hex').slice(0, 20)
  a.id = legacy
  const migrated = new CatalogPool(() => 2_000_000)
  migrated.migrate([a], [[credentialKey(a), legacy]], [{ id: legacy, checkedAt: 1_999_999, ping: 20, alive: true }])
  migrated.ingest([{ profile: b, source }, { profile: a, source }])
  eq(migrated.all().find(entry => entry.profile.name === 'A')?.profile.id, legacy, 'v1 migration keeps an already imported legacy ID')
  ok(migrated.all().find(entry => entry.profile.name === 'B')?.profile.id !== legacy, 'another SNI never takes the migrated legacy ID')
  eq(migrated.bestReady().length, 0, 'v1 migration retains cached history without restoring alive')
}

{
  const pool = new CatalogPool(() => 3_000_000)
  pool.ingest([
    ...Array.from({ length: 8 }, (_, index) => ({ profile: profile(index, 'fast.example'), source })),
    { profile: profile(8, 'other.example', 'hy2'), source: source + '-two' },
    { profile: profile(9, 'third.example'), source: source + '-three' }
  ])
  for (const entry of pool.all()) pool.observe(entry.profile.id, entry.profile.name === 'Node-8' ? 80 : entry.profile.name === 'Node-9' ? 90 : 1, pool.context)
  eq(new Set(pool.bestReady(3).map(entry => catalogHost(entry.profile))).size, 3, 'ready group does not take three credentials on the fastest single host')
  const copy = pool.profile(pool.all()[0].profile.id)!
  copy.name = 'mutated outside'
  ok(pool.all()[0].profile.name !== copy.name, 'importing a candidate cannot mutate the reservoir by reference')
}

{
  let now = 4_000_000
  const pool = new CatalogPool(() => now, 12)
  pool.ingest(inputs(12))
  const keeper = pool.all()[0].profile.id
  pool.observe(keeper, 20, pool.context)
  now++
  pool.ingest(Array.from({ length: 30 }, (_, index) => ({ profile: profile(index + 100), source })))
  eq(pool.size, 12, 'pool size stays bounded as new sources are ingested')
  ok(pool.profile(keeper), 'capacity eviction retains a freshly proven useful candidate')
  eq(pool.bestReady()[0]?.profile.id, keeper, 'capacity eviction preserves current ready state')
  pool.ingest([])
  eq(pool.size, 12, 'an empty/failed update cannot wipe the reservoir')
}

{
  let now = 4_500_000
  const pool = new CatalogPool(() => now, 8)
  pool.ingest(inputs(8))
  for (const entry of pool.all()) pool.observe(entry.profile.id, 20, pool.context)
  now += CATALOG_READY_TTL
  pool.ingest([{ profile: profile(100), source }, { profile: profile(101), source }])
  eq(pool.size, 8, 'history plus discovery remain within the same capacity bound')
  eq(pool.all().filter(entry => ['Node-100', 'Node-101'].includes(entry.profile.name)).length, 2, 'full historical-success pool still admits newly advertised replacements')
}

{
  const pool = new CatalogPool(() => 5_000_000)
  pool.ingest(inputs(CATALOG_POOL_LIMIT + 7))
  eq(pool.size, CATALOG_POOL_LIMIT, 'default storage really retains thousands up to the documented bound')
  const restored = new CatalogPool(() => 5_000_000)
  restored.restore(JSON.parse(JSON.stringify(pool.data())))
  eq(restored.size, CATALOG_POOL_LIMIT, 'large candidate reservoir survives serialization')
  eq(restored.cached().length, 200, 'renderer shortlist stays bounded independently of the reservoir')
  eq(restored.plan().length, 64, 'large reservoir does not expand the per-round measurement budget')
}

console.log(`catalog-pool.check: ${checks} checks`)
if (failures) { console.error(`${failures} failed`); process.exit(1) }
