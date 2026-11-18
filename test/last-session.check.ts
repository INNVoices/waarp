import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Status } from '../src/shared/types'
import { LastSessionEvidence, clearDiagnosticEvidence, errorCategory, lastTransferEvidence, readSavedPayloadReport, safeSessionEvent } from '../src/main/last-session'

const directory = mkdtempSync(join(tmpdir(), 'waarp-session-evidence-'))
const file = join(directory, 'last.json')
const secret = 'secret-token-never-include-in-report'
let now = 1_000
const status = (phase: Status['phase'], error?: string) => ({ phase, error, since: 10, downTotal: 900, upTotal: 200, open: true }) as Status
async function run() {
try {
  const history = new LastSessionEvidence(file, () => now)
  assert(await history.record(status('off'), []))
  assert.deepEqual(history.read().events, [])
  assert(await history.record(status('starting'), []))
  now += 10
  assert(await history.record(status('on'), []))
  now += 10
  assert(await history.record(status('error', `TLS certificate ${secret}`), Array(700).fill(`ERROR DNS ${secret} https://private.example/token`)))
  now += 10
  assert(await history.record(status('off'), []))
  const reopened = new LastSessionEvidence(file, () => now)
  assert(await reopened.record(status('off'), []), 'opening the app offline must preserve the preceding failed session')
  const events = reopened.read().events
  assert.deepEqual(events.map(event => event.phase), ['starting', 'on', 'error', 'off'])
  assert.equal(events[2].errorClass, 'tls')
  assert.equal(events[2].errors.dns, 500)
  const persisted = readFileSync(file, 'utf8')
  for (const denied of [secret, 'private.example', 'TLS certificate', 'ERROR DNS']) assert(!persisted.includes(denied))
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)

  const before = events.length
  await history.record(status('off'), [])
  assert.equal(history.read().events.length, before, 'same-phase telemetry is throttled')
  now += 15_001
  await history.record(status('off'), [])
  assert.equal(history.read().events.length, before + 1)
  for (let i = 0; i < 60; i++) { now += 16_000; await history.record(status(i % 2 ? 'on' : 'off'), []) }
  assert.equal(history.read().events.length, 48)
  assert(statSync(file).size <= 65_536)

  const unsafe = safeSessionEvent({ at: -1, phase: secret, since: Infinity, upBytes: -4, errorClass: secret,
    raw: secret, config: { password: secret }, errors: { dns: 50_000, tls: -1, [secret]: 1 } })
  assert.equal(unsafe.at, 0); assert.equal(unsafe.phase, ''); assert.equal(unsafe.errors.dns, 500)
  assert.equal(unsafe.errors.tls, 0); assert(!JSON.stringify(unsafe).includes(secret))
  writeFileSync(file, JSON.stringify({ schema: 1, raw: secret, events: [{ ...unsafe, raw: secret }] }))
  assert(!JSON.stringify(history.read()).includes(secret), 'read-time allowlist covers data from prior versions')
  writeFileSync(file, 'x'.repeat(65_537))
  assert.equal(history.read().available, false)
  writeFileSync(file, '{')
  assert.equal(history.read().available, false)
  assert(await history.clear()); assert.deepEqual(history.read().events, [])
  const writing = history.record(status('starting'), [])
  const writingNext = history.record(status('error'), [])
  const clearing = history.clear()
  assert(await clearing)
  assert((await Promise.all([writing, writingNext])).every(Boolean))
  assert.deepEqual(history.read().events, [], 'queued writes finish before clear and cannot resurrect deleted evidence')
  const blocked = join(directory, 'not-a-directory')
  writeFileSync(blocked, 'fixture')
  assert.equal(await new LastSessionEvidence(join(blocked, 'last.json')).record(status('error'), []), false,
    'an I/O failure is reported without throwing into VPN control')

  const payload = { profileId: secret, at: now, target: 'rfc6455', endpoint: `https://private.example/${secret}`,
    download: { state: 'pass', bytes: 162067, ms: 500, body: secret },
    upload: { state: 'not_measured', bytes: 0, ms: 0, reason: 'no_endpoint' } }
  writeFileSync(file, JSON.stringify(payload))
  const transfer = lastTransferEvidence(file)!
  assert.equal(transfer.download.state, 'pass'); assert.equal(transfer.upload.state, 'not_measured')
  assert(!JSON.stringify(transfer).includes(secret)); assert(!('profileId' in transfer))
  writeFileSync(file, 'x'.repeat(16_385))
  assert.equal(lastTransferEvidence(file), undefined)
  assert.equal(readSavedPayloadReport(file), undefined, 'UI history reads also reject an oversized saved payload before JSON parsing')
  assert.equal(lastTransferEvidence(file, payload)?.download.bytes, 162067, 'current sanitized evidence is usable after a disk failure')
  const payloadFile = join(directory, 'payload-last.json')
  writeFileSync(payloadFile, JSON.stringify(payload))
  assert(await clearDiagnosticEvidence(history, payloadFile))
  assert.deepEqual(history.read().events, []); assert.equal(readSavedPayloadReport(payloadFile), undefined)
  writeFileSync(payloadFile, JSON.stringify(payload))
  assert.equal(await clearDiagnosticEvidence(new LastSessionEvidence(directory), payloadFile), false)
  assert.equal(readSavedPayloadReport(payloadFile), undefined, 'failure to clear one file does not skip clearing the other')
  assert.equal(errorCategory(`deadline ${secret}`), 'timeout')
  console.log('last-session: offline reopen, failure preservation, bounded retention, throttling, private file, secret allowlist and I/O failure PASS')
} finally { rmSync(directory, { recursive: true, force: true }) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
