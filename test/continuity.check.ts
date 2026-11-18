import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FlowActivity, FLOW_QUIET_MS, FLOW_SAMPLE_MAX_AGE_MS } from '../src/main/continuity'
import { Engine } from '../src/main/engine'
import { FbTracker } from '../src/main/fallback'

const loaded = new Set(['a', 'b'])
const activity = new FlowActivity()
assert.equal(activity.idle(['a'], 0), false, 'no telemetry is not idle')
for (let t = 0; t <= FLOW_QUIET_MS; t += 1000) activity.observe([], loaded, t)
assert(activity.idle(['a'], FLOW_QUIET_MS), 'continuous known idle may improve a route')
activity.observe([{ via: 'a' }], loaded, 6000)
assert.equal(activity.idle(['a'], 6000), false, 'active TCP/UDP cohort holds the path')
for (let t = 7000; t < 11000; t += 1000) {
  activity.observe([], loaded, t)
  assert.equal(activity.idle(['a'], t), false, 'gap between application channels is not immediately idle')
}
activity.observe([{ via: 'a' }], loaded, 11000)
assert.equal(activity.idle(['a'], 11000), false, 'new channel extends the same quiet interval')
assert(activity.idle(['b'], 11000), 'another path does not inherit the busy path')
assert.equal(activity.idle(['b'], 11000 + FLOW_SAMPLE_MAX_AGE_MS + 1), false, 'stale sample cannot permit a switch')
activity.observe([], loaded, 15000)
assert.equal(activity.idle(['b'], 15000), false, 'a sampling gap restarts idle observation')
activity.invalidate()
activity.observe([], loaded, 16000)
assert.equal(activity.idle(['b'], 16000), false, 'recovered telemetry must establish idle again')
activity.reset()
assert.equal(activity.idle(['b'], 20000), false, 'OFF discards prior-session activity proof')

async function offDuringAutomaticStep(dir: string, kind: 'fallback' | 'group', lateAck: boolean) {
  const e = new Engine(process.execPath, dir, process.execPath) as any
  e.child = {}; e.status.phase = 'on'
  // Exercise the real OFF command and existing serialization owner. The native
  // stop body alone is replaced so this test cannot touch a process or adapter.
  e.relays.stop = async () => true
  const events: string[] = []
  let stopped: Promise<boolean> | undefined
  e.stopNow = async () => { events.push('stopNow'); e.stopping = true; return true }
  e.select = async (tag: string) => {
    events.push('select:' + tag)
    if (!stopped) { events.push('OFF requested'); stopped = e.stop() }
    return lateAck // neither cancelled nor late positive ACK may finish after OFF
  }
  e.fb = new FbTracker([{ tag: 'pair-1', main: 'a', fb: 'b' }, { tag: 'pair-2', main: 'c', fb: 'd' }], 1)
  e.groups = [
    { id: 'g-first', name: 'First', policy: 'first', members: ['a', 'b'] },
    { id: 'g-second', name: 'Second', policy: 'first', members: ['c', 'd'] }
  ]
  e.firstSelected = new Map([['g-first', 'a'], ['g-second', 'c']])
  const health = { a: 'down', b: 'ok', c: 'down', d: 'ok' }
  const pings = { a: undefined, b: 20, c: undefined, d: 20 }
  await e.serialize(async () => {
    if (kind === 'fallback') await e.fbStep(pings, health)
    else await e.groupStep(health, pings)
  })
  assert(stopped, kind + ' fixture actually issued OFF during selection')
  await stopped
  assert.deepEqual(events, [kind === 'fallback' ? 'select:pair-1' : 'select:grp-g-first', 'OFF requested', 'stopNow'],
    kind + ' cannot start another controller PUT after OFF while stopNow is queued')
  assert.deepEqual([...e.firstSelected], [['g-first', 'a'], ['g-second', 'c']], 'cancelled selection never publishes a new group member')
  assert.equal(e.fb.active().length, 0, 'cancelled selection never publishes an active fallback')
}

async function malformedTelemetry(dir: string) {
  const e = new Engine(process.execPath, dir, process.execPath) as any
  e.child = {}; e.run = { loaded: { profiles: ['a', 'b'] } }
  const valid = { id: 'valid', metadata: { network: 'tcp', processPath: 'C:\\Apps\\fixture.exe', host: 'target.example', destinationPort: '443' },
    chains: ['p-a', 'grp-g-test', 'rt-a0'], download: 0, upload: 0, start: new Date().toISOString() }
  const seedIdle = () => {
    e.flowActivity.reset()
    const now = performance.now(), paths = new Set(['a', 'b', 'direct'])
    for (let t = now - FLOW_QUIET_MS - 1000; t <= now; t += 1000) e.flowActivity.observe([], paths, t)
    assert(e.flowActivity.idle(['a']), 'fixture begins with fresh proven idle')
  }
  const malformed: [string, unknown][] = [
    ['null response', null], ['missing list', {}], ['non-array list', { connections: 'bad' }],
    ['null connection', { connections: [null] }],
    ['null metadata', { connections: [{ ...valid, metadata: null }] }],
    ['invalid metadata field', { connections: [{ ...valid, metadata: { network: 123 } }] }],
    ['non-array chains', { connections: [{ ...valid, chains: 'p-a' }] }],
    ['non-string chain tag', { connections: [{ ...valid, chains: [123] }] }],
    ['empty chain', { connections: [{ ...valid, chains: [] }] }],
    ['unknown chain', { connections: [{ ...valid, chains: ['unexpected-native-tag'] }] }],
    ['unloaded profile chain', { connections: [{ ...valid, chains: ['p-removed'] }] }]
  ]
  for (const [name, response] of malformed) {
    seedIdle(); e.req = async () => response
    await assert.doesNotReject(() => e.poll(), name + ' cannot escape the timer as an unhandled rejection')
    assert.equal(e.flowActivity.idle(['a']), false, name + ' cannot preserve proof that a path is idle')
    assert.equal(e.polling, undefined, name + ' releases the polling owner')
    e.req = async () => ({ connections: [] })
    await e.poll()
    assert.equal(e.flowActivity.idle(['a']), false, 'recovery after ' + name + ' must establish a new quiet interval')
  }
  seedIdle(); e.req = async () => ({ connections: [valid, { ...valid, id: 'unattributed', chains: [] }] })
  await assert.doesNotReject(() => e.poll())
  assert(e.conns.some((connection: { id: string; via: string }) => connection.id === 'valid' && connection.via === 'a'),
    'valid traffic remains visible when another connection cannot be attributed')
  assert.equal(e.flowActivity.idle(['b']), false, 'one unattributed connection prevents inferred idle on other paths')

  seedIdle(); e.req = async () => ({ connections: [valid] })
  await e.poll()
  assert.equal(e.conns[0].via, 'a', 'native physical profile in a selector chain identifies the active path')
  assert.equal(e.flowActivity.idle(['a']), false, 'known active path stays pinned')
  assert.equal(e.flowActivity.idle(['b']), true, 'valid telemetry does not unnecessarily hold an unrelated idle path')
  seedIdle(); e.req = async () => ({ connections: [{ ...valid, chains: ['direct', 'rt-a0'] }] })
  await e.poll()
  assert.equal(e.conns[0].via, 'direct', 'Direct attribution requires its explicit native tag')
  assert.equal(e.flowActivity.idle(['direct']), false)
  assert.equal(e.flowActivity.idle(['a']), true, 'explicit Direct traffic does not invent activity on a tunnel')
  seedIdle(); e.req = async () => ({ connections: null })
  await e.poll()
  assert.equal(e.flowActivity.idle(['a']), true, 'native null Go-list is a valid empty snapshot, unlike a null entry')
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-continuity-'))
  try {
    const engine = new Engine(process.execPath, dir, process.execPath)
    const e = engine as any
    e.child = {}; e.status.phase = 'on'
    const switches: { tag: string; to: string }[] = []
    e.select = async (tag: string, to: string) => { switches.push({ tag, to }); return true }
    let idle = false
    e.flowActivity = { idle: () => idle, reset() {} }
    e.groups = [{ id: 'g-test', name: 'Test', policy: 'fastest', members: ['a', 'b'] }]
    e.firstSelected.set('g-test', 'a')
    for (let i = 0; i < 8; i++) await e.groupStep({ a: 'ok', b: 'ok' }, { a: 900, b: 10 })
    assert.equal(switches.length, 0, 'a huge HTTP advantage does not interrupt active or unknown sessions')
    await e.groupStep({ b: 'ok' }, { b: 10 })
    assert.equal(switches.length, 0, 'unmeasured current member is not a confirmed failure')
    idle = true
    for (let i = 0; i < 5; i++) await e.groupStep({ a: 'ok', b: 'ok' }, { a: 900, b: 10 })
    assert.equal(switches.length, 1, 'sustained improvement may select after known idle')
    assert.equal(e.firstSelected.get('g-test'), 'b')
    idle = false
    await e.groupStep({ a: 'ok', b: 'down' }, { a: 10, b: undefined })
    assert.equal(switches.length, 2, 'confirmed failure can recover despite old active flows')
    e.pendingLive = { guard: 'owned' }
    await e.groupStep({ a: 'down', b: 'ok' }, { a: undefined, b: 10 })
    assert.equal(switches.length, 2, 'automatic selection respects the explicit edit barrier')
    e.pendingLive = undefined

    e.groups = [{ id: 'g-test', name: 'Test', policy: 'first', members: ['a', 'b'] }]
    e.firstSelected.set('g-test', 'a')
    await e.groupStep({ b: 'ok' }, { b: 10 })
    assert.equal(e.firstSelected.get('g-test'), 'a', 'first policy also holds an unmeasured active member')
    e.groups[0].members = ['b']
    await e.groupStep({ a: 'ok', b: 'ok' }, { a: 20, b: 10 })
    assert.equal(e.firstSelected.get('g-test'), 'b', 'removal from allowed group overrides soft hold')

    const pair = { tag: 'fallback-pair', main: 'a', fb: 'b' }
    e.fb = new FbTracker([pair], 1)
    await e.fbStep({ a: undefined, b: 20 }, { a: 'down', b: 'ok' })
    assert.equal(e.fb.active().length, 1)
    for (let i = 0; i < 4; i++) await e.fbStep({ a: 10, b: 20 }, { a: 'ok', b: 'ok' })
    assert.equal(e.fb.active().length, 1, 'healthy reserve stays while its app session is active')
    idle = true
    await e.fbStep({ a: 10, b: 20 }, { a: 'ok', b: 'ok' })
    assert.equal(e.fb.active().length, 0, 'known idle allows return to recovered primary')
    idle = false
    await e.fbStep({ a: undefined, b: 20 }, { a: 'down', b: 'ok' })
    await e.fbStep({ a: 10, b: undefined }, { a: 'ok', b: 'down' })
    assert.equal(e.fb.active().length, 0, 'failed reserve can recover to a healthy primary without waiting idle')
    for (const lateAck of [false, true]) {
      await offDuringAutomaticStep(dir, 'fallback', lateAck)
      await offDuringAutomaticStep(dir, 'group', lateAck)
    }
    await malformedTelemetry(dir)
    console.log('continuity.check: known idle, invalid telemetry, multi-channel hold, OFF precedence, failure and explicit-edit precedence PASS')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
