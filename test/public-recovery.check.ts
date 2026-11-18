import assert from 'node:assert/strict'
import type { OutProfile, Profile } from '../src/shared/types'
import { PUBLIC_SOURCES } from '../src/shared/public-sources'
import { publicServicePaths, recoverPublicSources, type PublicServicePath } from '../src/main/public-recovery'

const profile = (id: string, host = id + '.example', password = 'synthetic-' + id): OutProfile => ({
  kind: 'out', id, name: id, host, port: 443, version: 'Trojan', addedAt: 1,
  outbound: { type: 'trojan', server: host, server_port: 443, password, tls: { enabled: true, server_name: host } }
})
const signal = () => new AbortController().signal
const body = 'trojan://synthetic-fixture-password@relay.example:443#Fixture'
const sourceA = PUBLIC_SOURCES[0].url, sourceB = PUBLIC_SOURCES[1].url, sourceC = PUBLIC_SOURCES[2].url

async function main() {
  const own = profile('own'), previous = profile('previous')
  const stale = { ...profile('cached'), source: 'public' as const }
  const revoked = { ...profile('revoked'), revoked: true }
  const missing = { ...profile('missing'), subMissing: true }
  const rows = publicServicePaths({ profiles: [own, revoked, missing, previous], cached: [stale], preferred: own.id, recent: previous.id })
  assert.deepEqual(rows.map(row => row.id), ['own', 'previous', 'cached'])
  assert.equal(rows[2].cached, true, 'stale catalog records remain eligible candidates without a health claim')
  assert(!rows.some(row => row.id === 'direct'), 'choosing a personal service path never permits silent Direct recovery')
  assert.deepEqual(publicServicePaths({ profiles: [own], cached: [stale], preferred: 'deleted-personal', recent: 'direct' }).map(row => row.id), ['own', 'cached'])
  assert.deepEqual(publicServicePaths({ profiles: [own], cached: [stale], preferred: 'direct', recent: own.id }).map(row => row.id), ['direct', 'own', 'cached'])

  const loaded = publicServicePaths({ profiles: [own, previous], cached: [stale], preferred: own.id, recent: previous.id, loaded: ['previous', 'cached'] })
  assert.deepEqual(loaded.map(row => row.id), ['previous', 'cached'], 'ON recovery can only select already loaded IDs')
  assert.deepEqual(publicServicePaths({ profiles: [own], cached: [stale], preferred: 'direct', loaded: [] }), [{ id: 'direct' }])
  assert.deepEqual(publicServicePaths({ profiles: [own], cached: [stale], preferred: own.id, loaded: [] }), [])

  const duplicate = { ...own, id: 'duplicate', name: 'Renamed copy' }
  const distinctSni = { ...own, id: 'different-sni', outbound: { ...own.outbound, tls: { enabled: true, server_name: 'other.example' } } }
  const dedup = publicServicePaths({ profiles: [own, duplicate, distinctSni], cached: [{ ...own, id: 'cached-copy' }], preferred: duplicate.id })
  assert.deepEqual(dedup.map(row => row.id), ['duplicate', 'different-sni'], 'full effective credential identity deduplicates names but preserves different SNI')
  const revokedAlias = publicServicePaths({ profiles: [revoked], cached: [{ ...revoked, id: 'stale-alias', revoked: false }], preferred: 'direct' })
  assert.deepEqual(revokedAlias, [{ id: 'direct' }], 'cached aliases cannot revive a revoked effective configuration')
  assert.deepEqual(publicServicePaths({ profiles: [missing], cached: [{ ...missing, subMissing: false }], preferred: missing.id }), [],
    'a stale snapshot cannot override the saved missing-subscription state')
  const overridden = publicServicePaths({ profiles: [own], cached: [{ ...own, revoked: true }], preferred: own.id })
  assert.deepEqual(overridden.map(row => row.id), ['own'], 'saved profile state takes precedence over the same cached ID')

  const sameHost = Array.from({ length: 10 }, (_, index) => profile('same-' + index, 'shared.example'))
  const otherHosts = [profile('separate-a'), profile('separate-b'), profile('separate-c')]
  const diverse = publicServicePaths({ profiles: [...sameHost, ...otherHosts], cached: [], preferred: sameHost[0].id })
  assert.equal(diverse.length, 8)
  assert.deepEqual(diverse.slice(0, 4).map(row => row.id), ['same-0', 'separate-a', 'separate-b', 'separate-c'],
    'different credentials at the same host cannot occupy the whole first recovery round')
  assert.equal(publicServicePaths({ profiles: [...sameHost, ...otherHosts], cached: [], preferred: 'direct', limit: 100 }).length, 8)
  assert.equal(publicServicePaths({ profiles: [own, previous], cached: [stale], preferred: 'direct', limit: 2 }).length, 2)
  assert.deepEqual(publicServicePaths({ profiles: [own], cached: [], preferred: 'direct', limit: 0 }), [])
  assert.doesNotThrow(() => publicServicePaths({ profiles: [{ kind: 'vless', id: 'broken' } as Profile, own], cached: [], preferred: own.id }))
  const manySaved = Array.from({ length: 100 }, (_, index) => profile('saved-' + index))
  const recoveryCache = Array.from({ length: 8 }, (_, index) => ({ ...profile('cached-' + index), source: 'public' as const }))
  const fair = publicServicePaths({ profiles: manySaved, cached: recoveryCache, preferred: manySaved[0].id, recent: manySaved[1].id })
  assert.deepEqual(fair.slice(0, 2).map(row => row.id), ['saved-0', 'saved-1'])
  assert.equal(fair.length, 8)
  assert.equal(fair.filter(row => row.cached).length, 3, 'remaining saved/cache slots alternate despite a large saved-profile library')
  assert(!fair.some(row => row.id === 'direct'))
  const cacheOnly = publicServicePaths({ profiles: [], cached: recoveryCache, preferred: 'missing-personal' })
  assert.equal(cacheOnly.length, 8, 'unused saved slots are available to cached candidates')

  const paths: PublicServicePath[] = [{ id: 'first', profile: own }, { id: 'second', profile: previous }, { id: 'third', profile: stale, cached: true }]
  const calls: { id: string; sources: string[]; budget: number }[] = [], successes: string[] = []
  let clock = 0
  const recovered = await recoverPublicSources([sourceA, sourceB, sourceC], paths, async (path, sources, _signal, budget) => {
    calls.push({ id: path.id, sources, budget }); clock += 10
    if (path.id === 'first') return [{ url: sourceA, body }, { url: sourceB, error: 'synthetic failure' }]
    if (path.id === 'second') throw new Error('synthetic path failure')
    return [{ url: sourceB, body }, { url: sourceC, body }, { url: sourceA, body: 'must not overwrite success' }, { url: 'https://unrequested.example/', body }]
  }, signal(), { budgetMs: 90, perPathMs: 18, now: () => clock, onSuccess: id => successes.push(id) })
  assert.deepEqual(calls.map(call => call.sources), [[sourceA, sourceB, sourceC], [sourceB, sourceC], [sourceB, sourceC]])
  assert.deepEqual(calls.map(call => call.budget), [18, 18, 18])
  assert.deepEqual(recovered.map(row => [row.url, row.body]), [[sourceA, body], [sourceB, body], [sourceC, body]])
  assert.deepEqual(successes, ['first', 'third'], 'only a path that supplies new valid sources is remembered')

  const igareck = PUBLIC_SOURCES.find(row => row.id === 'igareck-vless')!
  const mirror = await recoverPublicSources([igareck.url, igareck.mirrors[0]], paths, async (_path, sources) => {
    assert.deepEqual(sources, [igareck.url]); return [{ url: igareck.mirrors[1], body }]
  }, signal())
  assert.deepEqual(mirror.map(row => row.url), [igareck.url], 'mirror aliases merge as one canonical source')

  clock = 0
  const budgets: number[] = []
  const deadline = await recoverPublicSources([sourceA, sourceB], paths, async (_path, _sources, _signal, budget) => {
    budgets.push(budget); clock += budget
    return budgets.length === 1 ? [{ url: sourceA, body }] : []
  }, signal(), { budgetMs: 25, perPathMs: 18, now: () => clock })
  assert.deepEqual(budgets, [18, 7], 'remaining global budget caps the next path and prevents a third attempt')
  assert.equal(deadline[0].body, body); assert(deadline[1].error)

  const aborted = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let attempts = 0
  let finishCleanup!: () => void
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
  let cleanupDone = false, settled = false
  const waiting = recoverPublicSources([sourceA], paths, async (_path, _sources, taskSignal) => {
    attempts++
    const cancelled = new Promise<void>(resolve => taskSignal.addEventListener('abort', () => resolve(), { once: true }))
    entered(); await cancelled
    await cleanup; cleanupDone = true
    throw new Error('callback cancelled after verified cleanup')
  }, aborted.signal)
  void waiting.then(() => { settled = true }, () => { settled = true })
  await started; aborted.abort(new Error('synthetic external cancellation'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'cancellation cannot let the recovery task outlive owned checker cleanup')
  finishCleanup()
  await assert.rejects(waiting, /synthetic external cancellation/)
  assert(cleanupDone)
  assert.equal(attempts, 1, 'external cancellation never falls through to another path')
  await assert.rejects(recoverPublicSources([sourceA], paths, async () => { attempts++; return [] }, aborted.signal), /synthetic external cancellation/)
  assert.equal(attempts, 1)

  attempts = 0
  const allFailed = await recoverPublicSources([sourceA], [...paths, paths[0]], async () => { attempts++; throw new Error('failure') }, signal())
  assert.equal(attempts, 3, 'duplicate recovery path IDs are not retried')
  assert(allFailed[0].error && !allFailed[0].body)
  const noBudget = await recoverPublicSources([sourceA], paths, async () => { throw new Error('must not run') }, signal(), { budgetMs: 0 })
  assert(noBudget[0].error)
  const bookkeeping = await recoverPublicSources([sourceA], paths, async () => [{ url: sourceA, body }], signal(), {
    onSuccess() { throw new Error('optional persistence unavailable') }
  })
  assert.equal(bookkeeping[0].body, body, 'advisory bookkeeping failure preserves a validated response')

  console.log('public-recovery: explicit Direct policy, loaded-only paths, stale cache eligibility, revocation, full config deduplication, host diversity, partial merge, deadline budgets and external cancellation PASS')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
