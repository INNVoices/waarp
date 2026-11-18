import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosisRequests, diagnosisCurrent, diagnosisProof, diagnosisRequestScope, type DiagnosisProof } from '../src/main/diagnosis'
import { Engine } from '../src/main/engine'
import { summarizeChecks } from '../src/shared/connection-quality'
import type { OutProfile, Route } from '../src/shared/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function main() {
  const profiles: OutProfile[] = ['a', 'b'].map(id => ({ kind: 'out', id, name: id, version: 'fixture', host: '192.0.2.10', port: 443,
    outbound: { type: 'socks', server: '192.0.2.10', server_port: 443 }, addedAt: 1, source: 'personal' }))
  const route: Route = { id: 'app:fixture', kind: 'app', name: 'Fixture', exe: 'C:\\Apps\\fixture.exe', via: 'a', on: true, connectionUse: 'game' }
  const scope = diagnosisRequestScope('https://target.example/', 'runtime', profiles, route)
  assert.equal(scope, diagnosisRequestScope('https://target.example/', 'runtime', structuredClone(profiles), structuredClone(route)))
  for (const changed of [
    diagnosisRequestScope('https://other.example/', 'runtime', profiles, route),
    diagnosisRequestScope('https://target.example/', 'new-network-session-revision', profiles, route),
    diagnosisRequestScope('https://target.example/', 'runtime', profiles, { ...route, id: 'another-card' }),
    diagnosisRequestScope('https://target.example/', 'runtime', profiles, { ...route, connectionUse: 'web' }),
    diagnosisRequestScope('https://target.example/', 'runtime', [{ ...profiles[0], revoked: true }, profiles[1]], route),
    diagnosisRequestScope('https://target.example/', 'runtime', profiles)
  ]) assert.notEqual(scope, changed, 'target, card, purpose, native context and profile changes cannot join an old request')

  const dir = mkdtempSync(join(tmpdir(), 'waarp-diagnosis-requests-'))
  let probes = 0, operations = 0, ownerVersion = 0, valid = true
  let active: AbortController | undefined, proof: DiagnosisProof | undefined
  const api = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture')
    probes++
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ delay: request.url?.includes('/p-b/') ? 7 : undefined }))
  })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const engine = new Engine(process.execPath, dir, process.execPath), native = engine as any
  native.child = {}; native.ids = ['a', 'b']; native.api = { port: (api.address() as AddressInfo).port, secret: 'fixture' }; engine.status.phase = 'on'
  type Result = { proof: DiagnosisProof | undefined; samples: ReturnType<typeof summarizeChecks> }
  const requests = new DiagnosisRequests<Result>(async () => { ownerVersion++; proof = undefined; active?.abort(); return true })
  const opaque: { parent?: unknown; toJSON: () => never } = { toJSON: () => { throw new Error('native token must not be serialized') } }
  opaque.parent = opaque
  assert.equal(requests.sessionKey(opaque), requests.sessionKey(opaque))
  assert.notEqual(requests.sessionKey(opaque), requests.sessionKey({}), 'different native sessions have distinct scalar identities')
  assert.notEqual(requests.sessionKey(opaque), requests.sessionKey(1), 'ON objects and OFF generations do not collide')
  assert.notEqual(requests.sessionKey(1), requests.sessionKey(2), 'OFF invalidation advances runtime identity')
  const measurement = () => {
    const entered = deferred<void>(), release = deferred<void>()
    return { entered, release, run: async (net: string | undefined): Promise<Result | null> => {
      operations++
      const version = ownerVersion, controller = active = new AbortController()
      const current = () => !controller.signal.aborted && version === ownerVersion && valid
      entered.resolve()
      await release.promise
      if (!current()) return null
      const rounds = []
      for (let i = 0; i < 2 && current(); i++) rounds.push(await engine.probePaths('https://target.example/', ['a', 'b'], controller.signal))
      if (!current()) return null
      proof = diagnosisProof('target.example', { b: 7 }, profiles, net, Date.now(), 'runtime', route)
      return { proof, samples: summarizeChecks(rounds) }
    } }
  }
  const network = async () => 'network-a'
  const current = () => valid
  try {
    const first = measurement(), lateNetwork = deferred<string | undefined>()
    const a = requests.request(scope, network, current, first.run)
    await first.entered.promise
    const b = requests.request(scope, network, current, first.run)
    const c = requests.request(scope, () => lateNetwork.promise, current, first.run)
    first.release.resolve()
    const [ra, rb] = await Promise.all([a, b])
    assert(ra?.proof); assert.equal(ra, rb)
    assert.equal(operations, 1); assert.equal(probes, 4, 'two subscribers use one two-round/two-outbound measurement')
    lateNetwork.resolve('network-a')
    assert.equal(await c, ra, 'a subscriber admitted during the operation may finish its fingerprint after measurement completion')
    const originalProof = ra.proof
    assert(diagnosisCurrent(originalProof, originalProof.token, 'b', profiles, 'network-a', Date.now(), 'runtime', [route]))

    const fresh = measurement()
    fresh.release.resolve()
    const freshResult = await requests.request(scope, network, current, fresh.run)
    assert.equal(operations, 2); assert.equal(probes, 8)
    assert.notEqual(freshResult?.proof?.token, originalProof.token, 'a new explicit check after completion does not reuse a cached proof')

    const old = measurement(), next = measurement(), nextNetwork = deferred<string | undefined>()
    const oldCall = requests.request(scope, network, current, old.run)
    await old.entered.promise
    const oldSignal = active!.signal
    const nextCall = requests.request(scope + ':different-target', () => nextNetwork.promise, current, next.run)
    assert(oldSignal.aborted, 'different target/card/runtime cancels the old owner before its new network read finishes')
    old.release.resolve(); assert.equal(await oldCall, null)
    nextNetwork.resolve('network-a'); await next.entered.promise; next.release.resolve()
    assert((await nextCall)?.proof)

    const beforeNetworkChange = measurement(), changedNetwork = measurement()
    const oldNetCall = requests.request(scope, network, current, beforeNetworkChange.run)
    await beforeNetworkChange.entered.promise
    const oldNetSignal = active!.signal
    const newNetCall = requests.request(scope, async () => 'network-b', current, changedNetwork.run)
    await changedNetwork.entered.promise
    assert(oldNetSignal.aborted, 'same target on a new physical network replaces the old operation')
    beforeNetworkChange.release.resolve(); changedNetwork.release.resolve()
    assert.equal(await oldNetCall, null)
    assert.equal((await newNetCall)?.proof?.net, 'network-b')

    const slowNetwork = deferred<string | undefined>(), newer = measurement(), forbidden = measurement()
    const olderCall = requests.request(scope, () => slowNetwork.promise, current, forbidden.run)
    const newerCall = requests.request(scope, async () => 'network-c', current, newer.run)
    await newer.entered.promise
    const newerSignal = active!.signal, beforeOlder = operations
    slowNetwork.resolve('network-a'); assert.equal(await olderCall, null)
    assert.equal(operations, beforeOlder); assert(!newerSignal.aborted, 'late older fingerprint must not supersede a newer network')
    newer.release.resolve(); assert((await newerCall)?.proof)

    const cancelled = measurement()
    const one = requests.request(scope, network, current, cancelled.run)
    await cancelled.entered.promise
    const two = requests.request(scope, network, current, cancelled.run)
    const pendingNetwork = deferred<string | undefined>()
    let readSignal: AbortSignal | undefined
    const pending = requests.request(scope, signal => { readSignal = signal; return pendingNetwork.promise }, current, forbidden.run)
    await requests.cancel()
    assert(active!.signal.aborted); assert(readSignal?.aborted)
    cancelled.release.resolve(); pendingNetwork.resolve('network-a')
    assert.deepEqual(await Promise.all([one, two, pending]), [null, null, null])
    assert.equal(proof, undefined, 'explicit cancel clears apply authority for all subscribers')
    assert.equal(diagnosisCurrent(proof, originalProof.token, 'b', profiles, 'network-a', Date.now(), 'runtime', [route]), false)

    const stale = measurement()
    const staleCall = requests.request(scope, network, current, stale.run)
    await stale.entered.promise
    valid = false; stale.release.resolve()
    assert.equal(await staleCall, null); assert.equal(proof, undefined, 'context loss cannot publish a late proof')
    valid = true
    const recovered = measurement(); recovered.release.resolve()
    const recoveredResult = await requests.request(scope, network, current, recovered.run)
    assert(recoveredResult?.proof)
    assert.notEqual(recoveredResult.proof.token, originalProof.token)

    const unknownFirst = measurement(), unknownSecond = measurement()
    const unknownA = requests.request(scope, async () => undefined, current, unknownFirst.run)
    await unknownFirst.entered.promise
    const unknownSignal = active!.signal
    const unknownB = requests.request(scope, async () => undefined, current, unknownSecond.run)
    await unknownSecond.entered.promise
    assert(unknownSignal.aborted, 'unidentified networks never share a fingerprint bucket')
    unknownFirst.release.resolve(); unknownSecond.release.resolve()
    assert.equal(await unknownA, null); assert.equal((await unknownB)?.proof, undefined)
    console.log('diagnosis-requests: shared real Engine probes, admission order, changed context/network, explicit cancellation and stale proof fences PASS')
  } finally {
    await requests.cancel()
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
