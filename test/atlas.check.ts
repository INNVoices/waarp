import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATLAS_UNKNOWN, atlasCountry, countryAnchor, countryCodes, profileAtlas, projectAtlas } from '../src/shared/atlas'
import type { ProfileView, Status } from '../src/shared/types'
import { Catalog } from '../src/main/catalog'
import { stub } from './stubs/electron'

const candidates = Array.from({ length: 10000 }, (_, i) => ({ country: ['DE', 'JP', 'SG', undefined][i % 4],
  status: ['ready', 'cached', 'failed', 'unverified'][i % 4], host: `private-${i}.invalid`, secret: 'must-not-cross-the-map-boundary' }))
const started = performance.now()
const projection = projectAtlas(candidates)
assert.equal(projection.total, 10000)
assert.equal(projection.countries.length, 4)
assert.equal(projection.unknown, 2500)
assert.deepEqual(projection.countries.find(item => item.country === 'JP'), { country: 'JP', total: 2500, ready: 0, failed: 0 })
assert.equal(JSON.stringify(projection).includes('private-'), false)
assert.equal(JSON.stringify(projection).includes('secret'), false)
assert.ok(performance.now() - started < 1000, '10k node aggregation has a bounded one-second CPU budget')
assert.equal(countryAnchor(ATLAS_UNKNOWN), undefined, 'unknown has no fabricated coordinate')
assert.equal(atlasCountry('__proto__'), ATLAS_UNKNOWN)
assert.equal(atlasCountry('ZZ'), ATLAS_UNKNOWN)
assert.equal(atlasCountry(' sg '), 'SG', 'small-region anchors are available')
assert.equal(countryCodes().length, 238)
for (const code of countryCodes()) {
  const anchor = countryAnchor(code)!
  assert.ok(Math.abs(anchor.longitude) <= 180 && Math.abs(anchor.latitude) <= 90)
}
const profiles: ProfileView[] = ['a', 'b'].map((id, index) => ({ id, kind: 'out', name: id, host: '', port: 443,
  address: [], version: 'Trojan', country: index ? undefined : 'DE' }))
const status: Status = { phase: 'off', open: false, pings: { a: 10 }, fallback: {}, health: { a: 'ok', b: 'down' },
  down: 0, up: 0, downTotal: 0, upTotal: 0 }
assert.equal(profileAtlas(profiles, status).countries.some(item => item.ready || item.failed), false, 'stopped-engine observations do not turn markers healthy')
assert.equal(profileAtlas(profiles, { ...status, phase: 'on' }).countries.find(item => item.country === 'DE')?.ready, 1)

async function catalogueProjection() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-atlas-check-'))
  const secure = stub.secure
  let downloads = 0
  try {
    stub.secure = true
    const body = Array.from({ length: 301 }, (_, i) => `trojan://fixture@node-${i}.invalid:443#${encodeURIComponent((i === 300 ? 'Unknown' : i % 2 ? 'JP' : 'DE') + ' fixture ' + i)}`).join('\n')
    const catalog = new Catalog(dir, join(dir, 'missing-engine.exe'), () => {}, () => false,
      async sources => { downloads++; return sources.map(url => ({ url, body })) }, () => 1_800_000_000_000)
    await catalog.refresh(['https://example.invalid/fixture'], { probe: false })
    const all = catalog.page({ page: 99, pageSize: 12 })
    assert.equal(all.atlas.total, 301, 'aggregate covers the full pool rather than the 200-row event sample')
    assert.equal(all.atlas.unknown, 1)
    assert.equal(all.page, 26)
    assert.equal(all.items.length, 1)
    const japan = catalog.page({ country: 'JP', page: 2, pageSize: 12 })
    assert.equal(japan.total, 150)
    assert.equal(japan.page, 2)
    assert.ok(japan.items.every(item => item.country === 'JP'))
    assert.deepEqual(japan.atlas, all.atlas, 'choosing a country does not erase other map markers')
    const unknown = catalog.page({ country: ATLAS_UNKNOWN })
    assert.equal(unknown.total, 1)
    assert.equal(unknown.items[0].country, '??')
    const query = catalog.page({ query: 'node-299.', country: 'JP' })
    assert.equal(query.total, 1)
    assert.equal(query.atlas.total, 1, 'search is shared by map and rows')
    const ready = catalog.page({ readyOnly: true })
    assert.equal(ready.atlas.total, 0, 'downloaded geography is never a successful connection check')
    const europe = catalog.page({ region: 'eu' })
    assert.equal(europe.atlas.total, 150)
    assert.equal(downloads, 1, 'paging, search and map projection do not fetch or probe')
  } finally { stub.secure = secure; rmSync(dir, { recursive: true, force: true }) }
}
void catalogueProjection().then(() => console.log('Atlas: 10k projection, privacy boundary, unknown geography, health truth and catalogue page integration passed'))
  .catch(error => { console.error(error); process.exitCode = 1 })
