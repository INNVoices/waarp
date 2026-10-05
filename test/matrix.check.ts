// Hardening R6: failure-matrix rows that had no direct test yet. Offline: temp folders, a fake engine binary (node
// itself, which exits at once), the electron stub. No TUN, no network change. Build with --alias:electron=./test/stubs/electron.ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Engine } from '../src/main/engine'
import { verifyEngine } from '../src/main/integrity'
import { Store } from '../src/main/store'
import { parseConf } from '../src/main/awg'
import { DEFAULTS } from '../src/main/store-core'
import { stub } from './stubs/electron'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const p = parseConf(`[Interface]\nPrivateKey = gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U=\nAddress = 10.8.0.7/32\n[Peer]\nPublicKey = q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM=\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.10:51820\n`, 'A')
const S = { ...DEFAULTS, rest: p.id, routes: [] }
const ready = (e: Engine) => { (e as any).recoveryOk = true; e.preflightGap = 1; return e }

;(async () => {
  // no engine binary -> one clear error, nothing spawned
  {
    const e = ready(new Engine(join(tmp('waarp-m-'), 'missing', 'sing-box.exe'), tmp('waarp-m-'), 'C:\\W\\Waarp.exe'))
    await e.start([p], S)
    eq([e.status.phase, /движок/i.test(e.status.error ?? ''), !!(e as any).child], ['error', true, false], 'no engine binary -> error, nothing spawned')
  }
  // config write failure (the config path is a folder) -> error, nothing spawned
  {
    const dir = tmp('waarp-m-')
    mkdirSync(join(dir, 'run.json'))
    const e = ready(new Engine(process.execPath, dir, 'C:\\W\\Waarp.exe'))
    await e.start([p], S)
    eq([e.status.phase, /конфиг/i.test(e.status.error ?? ''), !!(e as any).child], ['error', true, false], 'config write failure -> error, nothing spawned')
  }
  // process crash while the UI lives: the core exits before ready -> error, and the read-only residue check runs
  {
    const e = ready(new Engine(process.execPath, tmp('waarp-m-'), 'C:\\W\\Waarp.exe'))
    let checks = 0
    e.preflight = async () => { checks++; return checks === 1 ? { ok: true } : { ok: false, kind: 'tun_stale', text: 'left over' } }
    await e.start([p], S)
    await new Promise(r => setTimeout(r, 300))
    eq([e.status.phase, e.status.engine, !!(e as any).child], ['error', 'down', false], 'core exits early -> error, engine down, child gone')
    ok(checks >= 2, 'after the crash the residue check ran: ' + checks)
    eq(e.status.recovery, 'tun_stale', 'residue after a crash -> recovery set, next start refused by the same check')
    checks = 0
    e.preflight = async () => { checks++; return { ok: false, kind: 'tun_stale', text: 'left over' } }
    await e.start([p], S)
    eq([e.status.phase, !!(e as any).child], ['error', false], 'next start refused while residue remains')
  }
  // corrupt engine hash -> verifyEngine false (main shows a block notice and never starts)
  {
    const dir = tmp('waarp-m-')
    writeFileSync(join(dir, 'sing-box.exe'), 'engine'); writeFileSync(join(dir, 'libcronet.dll'), 'lib')
    const h = (s: string) => createHash('sha256').update(s).digest('hex')
    writeFileSync(join(dir, 'integrity.json'), JSON.stringify({ 'sing-box.exe': h('engine'), 'libcronet.dll': h('lib') }))
    eq(verifyEngine(join(dir, 'sing-box.exe')), true, 'matching hashes -> engine ok')
    writeFileSync(join(dir, 'sing-box.exe'), 'engine-tampered')
    eq(verifyEngine(join(dir, 'sing-box.exe')), false, 'changed engine -> integrity fails')
    writeFileSync(join(dir, 'integrity.json'), '{broken')
    eq(verifyEngine(join(dir, 'sing-box.exe')), false, 'broken manifest -> integrity fails')
  }
  // store unreadable -> copied aside, original never overwritten, nothing saved
  {
    const dir = tmp('waarp-m-')
    writeFileSync(join(dir, 'waarp.json'), '{not json')
    stub.secure = true
    const st = new Store(dir)
    ok(!!st.unreadable && st.unreadableCopy, 'unreadable store -> copied aside')
    st.settings = { ...st.settings, notify: false }
    st.save()
    eq(readFileSync(join(dir, 'waarp.json'), 'utf8'), '{not json', 'unreadable original is never overwritten')
  }
  // DPAPI unavailable -> secureOff, nothing with secrets written
  {
    const dir = tmp('waarp-m-')
    stub.secure = false
    const st = new Store(dir)
    st.profiles = [p as any]
    st.save()
    let wrote = true; try { readFileSync(join(dir, 'waarp.json')) } catch { wrote = false }
    eq([st.secureOff, wrote], [true, false], 'DPAPI unavailable -> secureOff, no file written, no plaintext fallback')
    stub.secure = true
    const ok2 = new Store(dir); ok2.profiles = [p as any]; ok2.save()
    const disk = readFileSync(join(dir, 'waarp.json'), 'utf8')
    ok(!disk.includes('gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U=') || disk.includes('"e:'), 'with DPAPI the profile is sealed (e:), not plaintext')
  }

  console.log(`matrix.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
