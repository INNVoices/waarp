import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessConnection, connectionUse, summarizeChecks, summarizedPaths, suggestedProbeTarget } from '../src/shared/connection-quality'
import { sameEffectiveRouting } from '../src/shared/routing-edit'
import { diagnosisCurrent, diagnosisProof, diagnosisSettings } from '../src/main/diagnosis'
import { checkedPatch } from '../src/main/validate'
import { DEFAULTS, migrate } from '../src/main/store-core'
import { backFromDiagnosis, goTo, initialNav, openDiagnosis, openRoute, addEntry } from '../src/renderer/src/lib/flow'
import type { OutProfile, Route, Settings } from '../src/shared/types'
import { Engine } from '../src/main/engine'
import { Checker } from '../src/main/checker'

const route: Route = { id: 'app:fixture', name: 'Fixture', kind: 'app', exe: 'C:\\Apps\\fixture.exe', on: true, via: 'g-auto', connectionUse: 'game' }
const other: Route = { id: 'custom:target.example', name: 'Other target', kind: 'custom', value: 'target.example', via: 'a', on: true }
const settings: Settings = { ...DEFAULTS, rest: 'g-auto', groups: [{ id: 'g-test', name: 'Group', policy: 'first', members: ['a', 'b'] }], routes: [route, other] }
const profile = (id: string): OutProfile => ({ kind: 'out', id, name: id, host: 'example.invalid', port: 443, version: 'Trojan', addedAt: 1, outbound: { type: 'trojan', server: 'example.invalid', server_port: 443, password: id } })
const profiles = [profile('a'), profile('b')]

async function main() {
  const samples = summarizeChecks([{ a: null, b: 80, invalid: NaN }, { a: null, b: 40 }])
  assert.deepEqual(samples.b, { attempted: 2, responded: 2, noResponse: 0, medianMs: 60, spreadMs: 40 })
  assert(!('invalid' in samples)); assert(!('unmeasured' in samples))
  assert.deepEqual(summarizedPaths(samples), { a: null, b: 60 })
  const suggestion = assessConnection('game', 'a', samples, ['a', 'b'])
  assert.equal(suggestion.recommendedVia, 'b')
  assert.equal(suggestion.applicationVerified, false)
  assert.deepEqual(suggestion.missing, ['udp-response', 'packet-loss', 'jitter', 'application-session'])
  assert.equal(assessConnection('web', 'unknown', samples, ['b']).recommendedVia, undefined, 'unmeasured current path is not a failure')
  assert.equal(assessConnection('web', 'a', summarizeChecks([{ a: null, b: 10 }]), ['b']).recommendedVia, undefined, 'one failed observation cannot force a suggestion')
  assert.equal(assessConnection('general', 'a', summarizeChecks([{ a: 500, b: 1 }, { a: null, b: 1 }]), ['b']).reason, 'current-responded', 'a responding current path stays even when another small sample is faster')
  assert.equal(assessConnection('general', 'a', summarizeChecks([{ a: null, b: 1 }, { a: null, b: null }]), ['b']).recommendedVia, undefined, 'a mixed alternative is not a reliable replacement')
  assert.equal(connectionUse('future-unknown'), 'general')
  assert.equal(suggestedProbeTarget(route), '', 'no endpoint guessed from process name')
  assert.equal(suggestedProbeTarget({ ...route, kind: 'preset', preset: 'discord' }), 'discord.com')
  assert.equal(suggestedProbeTarget({ ...other, value: '192.0.2.0/24' }), '')
  assert.equal(suggestedProbeTarget({ ...other, value: '*.example.com' }), '')
  assert.equal(suggestedProbeTarget({ ...other, value: '2001:db8::1' }), '[2001:db8::1]')

  const changedUse = { ...settings, routes: [{ ...route, connectionUse: 'interactive' as const }, other] }
  assert(sameEffectiveRouting(settings, changedUse), 'diagnostic purpose does not change native routing')
  assert(checkedPatch({ routes: changedUse.routes }).ok)
  assert(!checkedPatch({ routes: [{ ...route, connectionUse: 'invalid' }] }).ok)
  const restored = migrate({ ...settings, routes: [{ ...route, connectionUse: 'future-use' }, other] })
  assert.equal(restored.routes.length, 2, 'unknown stored metadata does not discard a valid route')
  assert.equal(restored.routes[0].connectionUse, undefined)
  assert.equal(migrate(changedUse).routes[0].connectionUse, 'interactive')

  const proof = diagnosisProof('target.example', { b: 60 }, profiles, 'network', 100, 'native-current', route)!
  assert(diagnosisCurrent(proof, proof.token, 'b', profiles, 'network', 101, 'native-current', settings.routes))
  assert.equal(diagnosisCurrent(proof, proof.token, 'b', profiles, 'network', 101, 'native-current', [other]), false, 'removed card cannot turn into a new host card')
  assert.equal(diagnosisCurrent(proof, proof.token, 'b', profiles, 'network', 101, 'native-current', [{ ...route, exe: 'C:\\Apps\\replacement.exe' }, other]), false, 'same ID with a different app invalidates proof')
  assert.equal(diagnosisCurrent(proof, proof.token, 'b', profiles, 'network', 101, 'native-current', changedUse.routes), false, 'changed requirements invalidate old evidence')
  assert.equal(diagnosisCurrent(proof, proof.token, 'b', profiles, 'network', 101, 'another-member', settings.routes), false, 'Auto changing the effective member invalidates prior context')
  const next = diagnosisSettings(proof, 'b', settings)!
  assert.equal(next.routes.length, 2); assert.equal(next.routes[0].id, route.id); assert.equal(next.routes[0].via, 'b')
  assert.equal(next.routes[1], other, 'an existing host card with the tested domain is not touched by an app diagnosis')
  assert.equal(next.rest, settings.rest); assert.equal(next.groups, settings.groups, 'global Auto and other groups are unchanged')
  assert.equal(diagnosisSettings(proof, 'b', changedUse), undefined)
  const legacy = diagnosisProof('new.example', { b: 60 }, profiles, 'network', 100, 'native-current')!
  assert.equal(diagnosisSettings(legacy, 'b', settings)?.routes.at(-1)?.id, 'custom:new.example', 'legacy host-only diagnosis stays supported')

  const origin = openRoute(addEntry(initialNav), route.id)
  const contextual = openDiagnosis(origin, route.id)
  const returned = backFromDiagnosis(contextual)
  assert.equal(returned.page, 'route'); assert.equal(returned.routeId, route.id); assert.equal(returned.libMode, 'catalog'); assert.equal(returned.from, 'lib')
  assert.equal(goTo(contextual, 'an').diagnosisRouteId, undefined, 'rail Diagnostics opens the global view, not a stale app context')

  // Real local API requests through existing Engine and Checker methods: explicit Direct is a native tag,
  // never a default dialer accidentally credited to a personal profile. This is not a native end-to-end test.
  const dir = mkdtempSync(join(tmpdir(), 'waarp-quality-'))
  const requests: string[] = []
  const api = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture')
    requests.push(new URL(request.url!, 'http://localhost').pathname)
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ delay: 7 }))
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  try {
    const apiConfig = { port: (api.address() as AddressInfo).port, secret: 'fixture' }
    const engine = new Engine(process.execPath, dir, process.execPath), nativeEngine = engine as any
    nativeEngine.child = {}; nativeEngine.ids = ['a']; nativeEngine.api = apiConfig; engine.status.phase = 'on'
    const checker = new Checker(process.execPath, dir), nativeChecker = checker as any
    nativeChecker.child = {}; nativeChecker.ids = ['a']; nativeChecker.api = apiConfig
    const methods = [() => engine.probePaths('https://target.example/', ['direct', 'a', 'unloaded', 'direct']), () => checker.probe('https://target.example/', ['direct', 'a', 'unloaded', 'direct'])]
    for (const measure of methods) {
      requests.length = 0
      assert.deepEqual(await measure(), { direct: 7, a: 7 })
      assert.deepEqual(requests.sort(), ['/proxies/direct/delay', '/proxies/p-a/delay'])
    }
    requests.length = 0
    await checker.probe('https://target.example/', ['a'])
    assert.deepEqual(requests, ['/proxies/p-a/delay'], 'Direct adds no background work when not requested')
    const abort = new AbortController(); abort.abort(); requests.length = 0
    assert.deepEqual(await engine.probePaths('https://target.example/', ['direct', 'a'], abort.signal), {})
    assert.equal(requests.length, 0)
  } finally {
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('connection-quality: scoped evidence, conservative assessment, metadata persistence, context navigation and explicit native Direct request tags PASS')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
