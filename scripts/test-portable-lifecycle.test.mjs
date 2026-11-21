// Guard/receipt unit tests. These do not constitute Windows runtime acceptance.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { assertEncryptedStore, assertIdentity, assertState, inside, ownedProcesses, processTicks, sameProcess } from './test-portable-lifecycle.mjs'

const root = 'C:\\ci\\owned'
const wrapper = { pid: 10, ppid: 1, started: '2026-11-21T10:00:00.0000000Z', exe: root + '\\Waarp-portable.exe' }
const main = { pid: 11, ppid: 10, started: '2026-11-21T10:00:01.0000000Z', exe: root + '\\temp\\bundle\\Waarp.exe' }
const settings = { tray: false, notify: false, autoConnect: false, autostart: false, rest: 'direct', groups: [], routes: [] }
const profile = { id: 'synthetic-id', kind: 'vless', name: 'Portable lifecycle loopback', host: '127.0.0.1', port: 9 }
const state = () => ({ status: { startup: 'ready', phase: 'off', open: false }, settings: structuredClone(settings), profiles: [profile] })
const paths = { temp: root + '\\temp', userData: root + '\\user-data', portable: wrapper.exe, version: '1.0.0' }
const identity = () => ({ pid: main.pid, execPath: main.exe, resourcesPath: root + '\\temp\\bundle\\resources',
  appPath: root + '\\temp\\bundle\\resources\\app.asar', portableFile: wrapper.exe,
  userData: paths.userData, isPackaged: true, encryptionAvailable: true, version: '1.0.0' })

test('Windows directory ownership rejects prefix siblings, traversal and another drive', () => {
  assert(inside(root, 'c:\\CI\\owned\\temp\\Waarp.exe'))
  for (const path of [root, root + '-foreign\\a.exe', root + '\\..\\foreign\\a.exe', 'D:\\ci\\owned\\a.exe', '\\\\host\\share\\a.exe']) assert(!inside(root, path), path)
})

test('a reused PID does not inherit old process ownership', () => {
  const foreign = { ...wrapper, started: '2026-11-21T10:00:30.0000000Z', exe: 'C:\\Windows\\unrelated.exe' }
  assert(!sameProcess(foreign, wrapper))
  assert.deepEqual(ownedProcesses([foreign], root, [wrapper]), [])
})

test('only a live owned parent extends ownership to a system binary', () => {
  const child = { pid: 12, ppid: 11, started: '2026-11-21T10:00:02.0000000Z', exe: 'C:\\Windows\\System32\\ping.exe' }
  assert.deepEqual(ownedProcesses([main, child], root).map(p => p.pid), [11, 12])
  assert.deepEqual(ownedProcesses([child], root, [main]), [])
  assert.deepEqual(ownedProcesses([main, { ...child, started: '2026-11-20T10:00:00Z' }], root).map(p => p.pid), [11])
})

test('sub-millisecond predecessors cannot be attributed to a reused parent PID', () => {
  const parent = { ...wrapper, started: '2026-11-21T10:00:00.5009999Z' }
  const predecessor = { pid: 20, ppid: wrapper.pid, started: '2026-11-21T10:00:00.5000000Z', exe: 'C:\\Windows\\foreign.exe' }
  assert(processTicks(predecessor.started) < processTicks(parent.started))
  assert.equal(Date.parse(predecessor.started), Date.parse(parent.started), 'Fixture covers precision lost by Date.parse')
  assert.deepEqual(ownedProcesses([parent, predecessor], root).map(p => p.pid), [10])
  assert.throws(() => processTicks('2026-02-30T10:00:00Z'))
})

test('read-only main identity requires the actual wrapper, isolated data and packaged ASAR path', () => {
  assert.equal(assertIdentity(identity(), paths, wrapper, [wrapper, main]), main)
  for (const patch of [
    { portableFile: 'C:\\foreign\\Waarp.exe' }, { userData: 'C:\\Users\\real\\AppData\\Roaming\\Waarp' },
    { execPath: 'C:\\other\\Waarp.exe' }, { appPath: root + '\\temp\\bundle\\unpacked' },
    { isPackaged: false }, { encryptionAvailable: false }, { version: '0.4.1' }
  ]) assert.throws(() => assertIdentity({ ...identity(), ...patch }, paths, wrapper, [wrapper, main]))
})

test('main cannot attach to a mismatched/reused portable parent', () => {
  assert.throws(() => assertIdentity(identity(), paths, wrapper, [{ ...wrapper, started: '2026-11-21T10:00:00.5000000Z' }, main]))
  assert.throws(() => assertIdentity(identity(), paths, wrapper, [wrapper, { ...main, ppid: 999 }]))
})

test('restored state must preserve the exact synthetic identity while VPN stays OFF', () => {
  assert.doesNotThrow(() => assertState(state(), profile.id))
  for (const mutate of [
    s => { s.status.phase = 'on' }, s => { s.status.open = true }, s => { s.status.startup = 'failed' },
    s => { s.settings.autoConnect = true }, s => { s.settings.autostart = true },
    s => { s.settings.routes = [{ id: 'unexpected' }] }, s => { s.profiles = [{ ...profile, id: 'changed' }] },
    s => { s.profiles = [{ ...profile, host: 'remote.example' }] }, s => { s.profiles.push(profile) }
  ]) { const s = state(); mutate(s); assert.throws(() => assertState(s, profile.id)) }
})

test('first launch cannot reuse a preexisting profile store', () => {
  assert.throws(() => assertState(state(), undefined))
  assert.doesNotThrow(() => assertState({ ...state(), profiles: [] }, undefined))
})

test('disk receipt rejects plaintext, malformed envelopes and missing settings', () => {
  const disk = () => ({ profiles: ['e:AQIDBA=='], settings: structuredClone(settings) })
  assert.equal(assertEncryptedStore(JSON.stringify(disk())).encryptedEnvelope, true)
  for (const mutate of [
    d => { d.profiles = ['p:{"name":"plaintext"}'] }, d => { d.profiles = ['e:bad!'] },
    d => { d.profiles.push('e:AQIDBA==') }, d => { delete d.settings.notify },
    d => { d.settings.autoConnect = true }, d => { d.extra = '00000000-0000-4000-8000-000000000007' }
  ]) { const d = disk(); mutate(d); assert.throws(() => assertEncryptedStore(JSON.stringify(d))) }
})

test('non-Windows execution emits NOT_RUN and fails without launching an app', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-portable-platform-test-'))
  try {
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/test-portable-lifecycle.mjs'), '--disposable-windows'], { cwd: dir, stdio: 'pipe' }), error => error.status === 1)
    const receipt = JSON.parse(readFileSync(join(dir, 'out/validation/portable-lifecycle.json'), 'utf8'))
    assert.equal(receipt.status, 'NOT_RUN'); assert.equal(receipt.passed, false)
    assert.deepEqual(receipt.launches, [])
    assert(receipt.notRun.every(item => item.status === 'NOT_RUN'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
