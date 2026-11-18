import { buildRuntime, liveSwitches, parseConf, planSlots, ruleFileOf, ruleFileWithWitness, CANARY_ZONE } from '../src/main/awg'
import { appKey, appPatterns, dedupeApps, exeHits, routeHits } from '../src/shared/appmatch'
import { migrate } from '../src/main/store-core'
import { Engine } from '../src/main/engine'
import { Lists, parseDomainList } from '../src/main/lists'
import { setListResolver } from '../src/main/awg'
import { checkedPatch } from '../src/main/validate'
import { CANARY_IP } from '../src/main/awg'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { pickPort, waitReady } from '../src/main/tun'
import { waitExit } from '../src/main/stop'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profile, Route, Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const PK = 'gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U='
const PUB = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM='
const conf = (host: string, addr: string) => `[Interface]\nPrivateKey = ${PK}\nAddress = ${addr}\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ${PUB}\nAllowedIPs = 0.0.0.0/0\nEndpoint = ${host}:51820\n`
const a = { ...parseConf(conf('203.0.113.10', '10.8.0.7/32'), 'A'), id: 'pa' } as Profile
const b = { ...parseConf(conf('203.0.113.11', '10.8.0.8/32'), 'B'), id: 'pb' } as Profile
const profiles = [a, b]

const CODEX_OLD = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.917.9434.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
const CODEX_NEW = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1027.6604.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe'
const app = (id: string, exe: string, via = 'pa', extra: Partial<Route> = {}): Route => ({ id: 'app:' + id, kind: 'app', name: id, exe, via, on: true, wholeDir: false, ...extra })
const preset = (id: string, via = 'pa', extra: Partial<Route> = {}): Route => ({ id: 'preset:' + id, kind: 'preset', name: id, preset: id, via, on: true, ...extra })
const custom = (v: string, via = 'pa', extra: Partial<Route> = {}): Route => ({ id: 'custom:' + v, kind: 'custom', name: v, value: v, via, on: true, ...extra })
const S = (routes: Route[], o: Partial<Settings> = {}): Settings => ({ rest: 'direct', groups: [], routes, ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: true, ...o })

// ---- MSIX apps match their package, not one version folder
const exact = appPatterns({ exe: CODEX_OLD, wholeDir: false })
ok(exeHits(exact, CODEX_NEW), 'an MSIX card keeps matching after a Store update')
ok(!exeHits(exact, CODEX_NEW.replace('ChatGPT.exe', 'other.exe')), 'exe-only MSIX card does not take the whole package')
ok(!exeHits(exact, CODEX_NEW.replace('2p2nqsd0c76g0', 'xxxxxxxxxxxxx')), 'another publisher is not matched')
const whole = appPatterns({ exe: CODEX_NEW, wholeDir: true })
ok(exeHits(whole, 'C:\\Users\\Someone\\AppData\\Local\\OpenAI\\Codex\\bin\\b6c7fc9497179c98\\codex.exe'), 'whole MSIX app includes its LocalAppData helpers (codex.exe)')
ok(exeHits(whole, CODEX_NEW.replace('ChatGPT.exe', 'resources\\x.exe')), 'whole MSIX app includes every exe in the package')
eq(appKey({ exe: CODEX_OLD }), appKey({ exe: CODEX_NEW }), 'both Codex versions are one app')
const merged = dedupeApps([app('old', CODEX_OLD), preset('chatgpt'), app('new', CODEX_NEW)])
eq(merged.map(r => r.id), ['app:old', 'preset:chatgpt'], 'duplicate MSIX cards collapse into the first one')
eq(merged[0].exe, CODEX_NEW, 'the kept card points at the newer install')
eq(migrate({ routes: [app('old', CODEX_OLD), app('new', CODEX_NEW)] }).routes.length, 1, 'stored duplicates are merged on load')
ok(exeHits(appPatterns({ exe: 'C:\\Games\\X\\x.exe', matchDir: 'C:\\Games\\X', wholeDir: true }), 'c:\\games\\x\\bin\\y.exe'), 'folder cards still match case-insensitively')
ok(routeHits(app('chrome', 'C:\\Chrome\\chrome.exe'), { exe: 'C:\\Chrome\\chrome.exe', host: 'x.com' }), 'app card attributes by exe')
ok(routeHits(preset('chatgpt'), { exe: '', host: 'ws.chatgpt.com' }), 'preset card attributes by domain')

// ---- slots: toggling, adding, removing and editing a card never changes the engine config
const base = [app('chrome', 'C:\\Chrome\\chrome.exe'), app('codex', CODEX_NEW), preset('chatgpt'), custom('youtube.com'), app('uprof', 'C:\\AMD\\uprof.exe', 'direct')]
const slots = planSlots(S(base))!
eq(slots.app.slice(0, 3), ['app:chrome', 'app:codex', 'app:uprof'], 'app cards take app slots in list order')
eq(slots.dom.slice(0, 2), ['custom:youtube.com', 'preset:chatgpt'], 'custom before preset, as before')
ok(slots.app.length >= 8 && slots.app.length % 8 === 0, 'app pool keeps free slots for new cards')
const opts = (sl: typeof slots, hostV6 = false) => ({ api: { port: 1, secret: 's' }, selfExe: 'C:\\W\\Waarp.exe', selectors: true, slots: sl, ruleDir: 'C:\\rules', hostV6, preload: ['pa', 'pb'] })
const run0 = buildRuntime(profiles, S(base), opts(slots))
const [witnessAck, witnessMiss] = run0.cfg.dns.rules as any[]
eq(witnessAck.rules, [{ domain_suffix: [CANARY_ZONE] }, { rule_set: Object.keys(run0.files), rule_set_ip_cidr_match_source: true }], 'one explicitly AND-gated DNS rule observes every file without deferred CIDR matching')
eq([witnessAck.type, witnessAck.mode, witnessAck.action, witnessMiss.domain_suffix, witnessMiss.action, witnessMiss.rcode], ['logical', 'and', 'predefined', [CANARY_ZONE], 'predefined', 'NXDOMAIN'], 'unloaded file witnesses stop locally before any real DNS resolver')
const emptyFile = JSON.stringify({ version: 3, rules: [] })
const broadFile = JSON.stringify({ version: 3, rules: [{ domain_suffix: [CANARY_ZONE, 'ordinary.example'] }, { ip_cidr: ['192.0.2.0/24'] }] })
const broadWitness = JSON.parse(ruleFileWithWitness(broadFile, `current.0.${CANARY_ZONE}`)).rules
eq(broadWitness[0], { domain: [`current.0.${CANARY_ZONE}`], query_type: ['A'] }, 'each file witness is DNS-only and exact, not a suffix or traffic match')
eq(broadWitness[1].rules, [{ domain_suffix: [CANARY_ZONE], invert: true }, { type: 'logical', mode: 'or', rules: JSON.parse(broadFile).rules }], 'ordinary domain and CIDR alternatives remain OR-ed outside the reserved witness namespace')
const cases: [string, Route[]][] = [
  ['card off', base.map(r => (r.id === 'app:chrome' ? { ...r, on: false } : r))],
  ['card added', [...base, app('tg', 'C:\\TG\\Telegram.exe', 'pb')]],
  ['card removed', base.filter(r => r.id !== 'custom:youtube.com')],
  ['card target changed', base.map(r => (r.id === 'preset:chatgpt' ? { ...r, via: 'pb' } : r))],
  ['card edited', base.map(r => (r.id === 'app:codex' ? { ...r, wholeDir: true } : r))],
  ['card to direct', base.map(r => (r.id === 'app:chrome' ? { ...r, via: 'direct' } : r))],
  ['cards reordered', [base[1], base[0], ...base.slice(2)]],
  ['DPI bypass on a Direct card', base.map(r => (r.id === 'app:uprof' ? { ...r, dpi: true } : r))]
]
for (const [name, routes] of cases) {
  const sl = planSlots(S(routes), slots)
  ok(!!sl, `${name}: fits the running slots`)
  const next = buildRuntime(profiles, S(routes), opts(sl!))
  ok(!!liveSwitches(run0.cfg, next.cfg), `${name}: applied live, no core restart`)
}
const off = planSlots(S(cases[0][1]), slots)!
eq(off, slots, 'switching a card off keeps every slot in place')
const added = planSlots(S(cases[1][1]), slots)!
eq(added.app.slice(0, 4), ['app:chrome', 'app:codex', 'app:uprof', 'app:tg'], 'a new card takes the next free slot')
const removed = planSlots(S(cases[2][1]), slots)!
eq(removed.dom[0], '', 'a removed card frees its slot without moving others')
eq(removed.dom[1], 'preset:chatgpt', 'other cards keep their slot')
const between = planSlots(S([base[0], app('mid', 'C:\\M\\m.exe'), ...base.slice(1)]), slots)!
ok(between.app.indexOf('app:mid') > between.app.indexOf('app:chrome') && between.app.indexOf('app:mid') < between.app.indexOf('app:codex'), 'an inserted card still sits between its neighbours')
eq(planSlots(S(Array.from({ length: 40 }, (_, i) => app('n' + i, `C:\\N\\${i}.exe`))), slots), undefined, 'more cards than slots asks for one restart')

const files = (routes: Route[]) => buildRuntime(profiles, S(routes), opts(planSlots(S(routes), slots)!)).files
const f0 = run0.files
const f1 = files(cases[0][1])
const chromeSlot = 'ra' + slots.app.indexOf('app:chrome')
ok(f0[chromeSlot].includes('chrome.exe'), 'an on card fills its rule file')
eq(JSON.parse(f1[chromeSlot]).rules, [], 'an off card empties its rule file')
ok(f0['dn-p-pa'].includes('chrome.exe'), 'DNS of an app card goes through its own tunnel')
ok(f0['dn-p-pa'].includes('chatgpt.com'), 'DNS of a site card goes through its own tunnel')
ok(f0['dn-direct'].includes('uprof.exe'), 'DNS of a Direct card stays local')
const codexSlot = 'ra' + slots.app.indexOf('app:codex')
ok(f0[codexSlot].includes('windowsapps') && !f0[codexSlot].includes('26.1027'), 'the engine matches Codex by package, not version')
const uprofV6 = 'va' + slots.app.indexOf('app:uprof')
ok(f0[uprofV6].includes('uprof.exe'), 'IPv6 to Direct is refused when the computer has no IPv6')
eq(JSON.parse(buildRuntime(profiles, S(base), opts(slots, true)).files[uprofV6]).rules, [], 'IPv6 to Direct passes when the computer has IPv6')
ok(run0.cfg.route.rules.some((r: any) => r.ip_version === 6 && r.action === 'reject' && r.rule_set?.includes('rest-v6')), 'everything else over IPv6 is refused fast without host IPv6')
ok(run0.cfg.route.rules.some((r: any) => r.outbound === 'direct' && (r.process_path_regex ?? []).some((x: string) => x.includes('ExitLag'))), 'other VPN clients never get tunnelled twice')
eq(run0.cfg.log.level, 'warn', 'engine log is warn by default')
const dpiFiles = files(base.map(r => (r.id === 'app:uprof' ? { ...r, dpi: true } : r.id === 'app:chrome' ? { ...r, dpi: true } : r)))
ok(dpiFiles['fa' + slots.app.indexOf('app:uprof')].includes('uprof.exe'), 'DPI bypass fills the fragment file of that Direct card')
eq(JSON.parse(dpiFiles['fa' + slots.app.indexOf('app:chrome')]).rules, [], 'DPI flag on a tunnelled card does nothing')
eq(JSON.parse(f0['fa' + slots.app.indexOf('app:uprof')]).rules, [], 'without the flag the fragment file stays empty')
ok(run0.cfg.route.rules.some((r: any) => r.action === 'route' && r.tls_record_fragment === true) && run0.cfg.route.rules.some((r: any) => r.network === 'udp' && r.port === 443 && r.action === 'reject' && r.rule_set), 'every slot has a fragment rule and a QUIC refusal tied to its own file')
const blocked = buildRuntime(profiles, S(base.map(r => (r.id === 'app:chrome' ? { ...r, via: 'gone' } : r))), opts(slots)).files
ok(blocked['xa' + slots.app.indexOf('app:chrome')].includes('chrome.exe') && JSON.parse(blocked[chromeSlot]).rules.length === 0, 'a card with a missing tunnel is blocked, never direct')
ok(blocked['dn-block'].includes('chrome.exe'), 'its DNS is refused too')

if (process.platform === 'win32' && existsSync(join(process.cwd(), 'engine', 'sing-box.exe'))) {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-slots-check-'))
  try {
    const rules = join(dir, 'rules')
    mkdirSync(rules)
    const rt = buildRuntime(profiles, S(base), { ...opts(slots), ruleDir: rules })
    Object.entries(rt.files).forEach(([tag, body], i) => writeFileSync(join(rules, ruleFileOf(tag)), ruleFileWithWitness(body, `start.${i}.${CANARY_ZONE}`)))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(rt.cfg))
    const check = spawnSync(join(process.cwd(), 'engine', 'sing-box.exe'), ['check', '-c', file], { encoding: 'utf8', timeout: 15000 })
    ok(check.status === 0, 'pinned engine accepts the slot config and rule files: ' + String(check.stderr).slice(-600))
  } finally { rmSync(dir, { recursive: true, force: true }) }
} else console.log('[SKIP] slots: pinned Windows engine schema check requires Windows and engine/sing-box.exe')

const rulesCheck = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-rules-apply-'))
  try {
    const e = new Engine(process.execPath, dir, process.execPath) as any
    e.child = {}
    const answer = { Status: 0, Answer: [{ type: 1, data: CANARY_IP }] }
    e.req = async () => answer
    eq(await e.writeRules(['ra0'], { ra0: emptyFile }, () => true), true, 'a written rule file applies only after its own witness answers')
    const kept = readFileSync(join(dir, 'rules', ruleFileOf('ra0')), 'utf8')
    const bodies = { rd0: broadFile, 'dn-direct': emptyFile }
    const queries = new Map<string, number>()
    e.req = async (path: string) => {
      const name = new URL(path, 'http://127.0.0.1').searchParams.get('name')!
      const owner = Object.keys(bodies).find(tag => JSON.parse(readFileSync(join(dir, 'rules', ruleFileOf(tag)), 'utf8')).rules[0].domain[0] === name)
      ok(!!owner, 'the controller request addresses a witness inside one of the changed files')
      const times = (queries.get(owner!) ?? 0) + 1
      queries.set(owner!, times)
      return owner === 'dn-direct' && times === 1 ? { Status: 3 } : answer
    }
    eq(await e.writeRules(Object.keys(bodies), bodies, () => true), true, 'the barrier waits for the independently delayed DNS-bucket watcher')
    eq([...queries], [['rd0', 1], ['dn-direct', 2]], 'confirmed files are not probed again while another watcher is pending')
    eq(bodies, { rd0: broadFile, 'dn-direct': emptyFile }, 'random witnesses never enter the canonical files used for delta comparison')
    eq(readFileSync(join(dir, 'rules', ruleFileOf('ra0')), 'utf8'), kept, 'an unchanged file and its witness are not rewritten')

    const realNow = Date.now
    let elapsed = 0, maxTimeout = 0
    try {
      Date.now = () => 10000 + elapsed
      e.req = async (_: string, timeout: number) => { maxTimeout = Math.max(maxTimeout, timeout); elapsed += Math.min(700, timeout); return { Status: 3 } }
      eq(await e.writeRules(Object.keys(bodies), bodies, () => true), false, 'any unconfirmed changed file rejects the complete apply')
      ok(elapsed <= 3000 && maxTimeout <= 1000, 'one three-second budget bounds all files and every controller request')
    } finally { Date.now = realNow }
    writeFileSync(join(dir, 'blocked'), 'x')
    const blocked = new Engine(process.execPath, join(dir, 'blocked'), process.execPath) as any
    blocked.req = async () => answer
    eq(await blocked.writeRules(['ra0'], { ra0: '{}' }, () => true), false, 'a failed rule file write is never reported as applied, even if the canary would answer')
    const silent = new Engine(process.execPath, join(dir, 'silent'), process.execPath) as any
    silent.req = async () => undefined
    eq(await silent.writeRules(['ra0'], { ra0: '{}' }, () => false), false, 'no canary answer means not applied')
    eq(existsSync(join(dir, 'silent', 'rules')), false, 'a cancelled apply never publishes rule files')

    // Model a Windows replacement lock using the real file-writing path. A failed
    // atomic replacement must leave the last complete JSON for the core watcher.
    const fs = require('node:fs') as typeof import('node:fs')
    const rename = fs.renameSync
    const rule = join(dir, 'rules', ruleFileOf('ra0'))
    const previous = readFileSync(rule, 'utf8')
    try {
      fs.renameSync = () => { throw Object.assign(new Error('fixture replacement lock'), { code: 'EBUSY' }) }
      eq(await e.writeRules(['ra0'], { ra0: '{"version":3,"rules":[{"domain":["changed.example"]}]}' }, () => true), false, 'locked atomic replacement requests the existing controlled restart')
      eq(readFileSync(rule, 'utf8'), previous, 'replacement failure never falls back to truncating a watched rule file')
      eq(existsSync(rule + '.tmp'), false, 'failed atomic replacement cleans its temporary file')
    } finally { fs.renameSync = rename }

    let current = true
    e.req = async () => { current = false; return answer }
    eq(await e.writeRules(['ra0'], { ra0: emptyFile }, () => current), false, 'late file-witness response cannot confirm a cancelled apply')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Pinned-core watcher acceptance with no TUN, proxy listeners, or external DNS/network. */
const nativeWitnessCheck = async () => {
  const exe = join(process.cwd(), 'engine', 'sing-box.exe')
  if (process.platform !== 'win32' || !existsSync(exe)) return
  const dir = mkdtempSync(join(tmpdir(), 'waarp-rule-witness-'))
  let child: ReturnType<typeof spawn> | undefined
  let diagnostic = ''
  try {
    const port = await pickPort()
    ok(!!port, 'native witness fixture gets a free loopback controller port')
    if (!port) return
    const ruleDir = join(dir, 'rules')
    mkdirSync(ruleDir)
    const rt = buildRuntime(profiles, S(base), { ...opts(slots), ruleDir })
    const business: Record<string, string> = { ...rt.files, rd0: broadFile }
    Object.entries(business).forEach(([tag, body], i) => writeFileSync(join(ruleDir, ruleFileOf(tag)), ruleFileWithWitness(body, `start.${i}.${CANARY_ZONE}`)))
    // Keep one core watcher on its old file while Engine publishes the new copy.
    // This models a delayed watcher independently of the other completed reloads.
    const frozenTag = 'fa0', frozenFile = join(ruleDir, 'delayed-fa0.json')
    const frozenBefore = readFileSync(join(ruleDir, ruleFileOf(frozenTag)), 'utf8')
    writeFileSync(frozenFile, frozenBefore)
    const api = { port, secret: 'offline-witness-fixture' }
    const cfg = {
      log: { level: 'warn' },
      dns: {
        servers: [{ type: 'hosts', tag: 'offline', predefined: { 'unused.example': ['127.0.0.1'] } }], final: 'offline',
        rules: [...rt.cfg.dns.rules.slice(0, 2),
          { rule_set: ['rd0'], action: 'predefined', answer: ['ordinary.example. IN A 127.0.0.8'] },
          { action: 'predefined', rcode: 'NXDOMAIN' }]
      },
      route: { rule_set: rt.cfg.route.rule_set!.map(set => set.tag === frozenTag ? { ...set, path: frozenFile } : set) },
      outbounds: [{ type: 'direct', tag: 'direct' }],
      experimental: { clash_api: { external_controller: `127.0.0.1:${port}`, secret: api.secret } }
    }
    const configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify(cfg))
    child = spawn(exe, ['run', '-c', configFile, '-D', dir, '--disable-color'], { windowsHide: true, cwd: dir })
    child.stdout?.on('data', data => { diagnostic = (diagnostic + data).slice(-1800) })
    child.stderr?.on('data', data => { diagnostic = (diagnostic + data).slice(-1800) })
    child.on('error', error => { diagnostic += error.message })
    const e = new Engine(exe, dir, process.execPath) as any
    e.child = child
    e.api = api
    const alive = () => child!.exitCode === null && child!.signalCode === null
    const ready = await waitReady({ probe: async () => !!await e.req('/version', 500), alive, budget: 5000, every: 50 })
    ok(ready === 'ready', 'pinned core starts the offline witness fixture: ' + diagnostic)
    if (ready !== 'ready') return
    const query = (name: string) => e.req(`/dns/query?name=${name}&type=A`, 500)
    const answered = async (name: string, ip = CANARY_IP) => {
      const response = await query(name)
      return response?.Status === 0 && response.Answer?.some((rr: any) => rr.type === 1 && rr.data === ip)
    }
    const marker = (file: string): string => JSON.parse(readFileSync(file, 'utf8')).rules[0].domain[0]
    ok((await query(`unpublished.0.${CANARY_ZONE}`))?.Status === 3, 'a broad business suffix cannot forge a missing file witness')
    ok(await answered('ordinary.example', '127.0.0.8'), 'wrapping business rules preserves ordinary DNS matching')

    const pid = child.pid
    eq(await e.writeRules(['ra0', frozenTag], { ra0: business.ra0, [frozenTag]: broadFile }, alive), false, 'one reloaded watcher cannot acknowledge a second stale watcher')
    const first = marker(join(ruleDir, ruleFileOf('ra0'))), delayed = marker(join(ruleDir, ruleFileOf(frozenTag)))
    ok(await answered(first), 'the independently reloaded app file has its own positive witness')
    ok((await query(delayed))?.Status === 3, 'the file still absent from the core returns a local negative witness')
    writeFileSync(frozenFile + '.tmp', readFileSync(join(ruleDir, ruleFileOf(frozenTag)), 'utf8'))
    renameSync(frozenFile + '.tmp', frozenFile)
    const observed = await waitReady({ probe: () => answered(delayed), alive, budget: 3000, every: 50 })
    ok(observed === 'ready', 'the delayed watcher confirms only after its own new domain/CIDR body is loaded: ' + diagnostic)
    ok((await query(JSON.parse(frozenBefore).rules[0].domain[0]))?.Status === 3, 'a previous file generation cannot acknowledge a newer apply')
    eq(await e.writeRules(['rd0', 'dn-direct'], business, alive), true, 'the real barrier confirms every changed domain and DNS-bucket file')
    ok(child.pid === pid && alive(), 'the native watcher fixture keeps the same core process throughout')
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill()
      ok(await waitExit(child, 3000), 'the owned native witness fixture exits')
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

const lifecycleCheck = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-slot-lifecycle-'))
  const fetchBefore = globalThis.fetch
  try {
    const e = new Engine(process.execPath, dir, process.execPath) as any
    e.child = {}
    e.status = { ...e.status, phase: 'on' }
    const settings = S(base)
    const runtime = buildRuntime(profiles, settings, { ...opts(slots), selfExe: process.execPath, ruleDir: join(dir, 'rules') })
    e.api = { port: 1, secret: 's' }
    e.run = { ...runtime, loaded: { profiles: ['pa', 'pb'], groups: [], fbs: [], slots }, autoLive: [], settings, hostV6: false }
    e.select = async () => true
    e.writeRules = async () => true
    e.closeTouched = async () => {
      e.stopVersion++
      e.status = { ...e.status, phase: 'error', error: 'fixture stop did not finish' }
      return { tried: 1, closed: 0 }
    }
    eq(await e.applyLive(profiles, settings), false, 'OFF during connection cleanup supersedes the live apply')
    eq(e.status.error, 'fixture stop did not finish', 'stale live apply preserves the newer stop error')
    eq(e.liveApplies, 0, 'a superseded apply is not counted as successful')

    globalThis.fetch = (async () => { e.stopVersion++; return new Response('', { status: 200 }) }) as typeof fetch
    eq(await e.drop('fixture'), false, 'late successful DELETE belongs to the cancelled core generation')

    const changed = new Engine(process.execPath, dir, process.execPath) as any
    changed.child = {}
    changed.conns = [
      { id: 'first', exe: base[0].exe, host: 'unrelated.example' },
      { id: 'second', exe: base[1].exe, host: 'unrelated.example' },
      { id: 'neighbor', exe: 'C:\\Other\\other.exe', host: 'unrelated.example' }
    ]
    const requested: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      const id = String(url).split('/').at(-1)!
      requested.push(id)
      return new Response('', { status: id === 'second' ? 500 : 200 })
    }) as typeof fetch
    eq(await changed.closeTouched(base, base.map((r, i) => i < 2 ? { ...r, on: false } : r)), { tried: 2, closed: 1 }, 'disabling app rules counts only confirmed DELETE responses')
    eq(requested.sort(), ['first', 'second'], 'unrelated app sessions survive a rule change')
    requested.length = 0
    eq(await changed.closeTouched(base, [base[1], base[0], ...base.slice(2)]), { tried: 0, closed: 0 }, 'reordering nonoverlapping cards preserves the same effective owners')
    eq(await changed.closeTouched(base, [base[2], base[0], base[1], ...base.slice(3)]), { tried: 0, closed: 0 }, 'moving a preset past app cards does not change effective rule priority')
    eq(requested, [], 'visual cross-kind reordering never closes unaffected connections')

    const idle = new Engine(process.execPath, dir, process.execPath) as any
    idle.recordIdlePings({ pa: 10 })
    const firstRound = idle.status.pingRound
    idle.set({ down: 1 })
    eq(idle.status.pingRound, firstRound, 'traffic status retains the current measurement revision')
    idle.recordIdlePings({ pa: 10 })
    eq(idle.status.pingRound, firstRound + 1, 'a second identical OFF sample is a new measurement')
    ok(typeof idle.status.pingAt === 'number', 'OFF sample time is present in the next snapshot')
    idle.status.phase = 'on'
    idle.recordIdlePings({ pa: 999 })
    eq(idle.status.pings.pa, 10, 'a late OFF measurement cannot overwrite running-core health')

    const measuring = new Engine(process.execPath, dir, process.execPath) as any
    measuring.child = {}; measuring.ids = ['pa']
    let probeSignal: AbortSignal | undefined, pollSignal: AbortSignal | undefined
    const pending = new Map<string, (value: Response) => void>()
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init!.signal as AbortSignal
      if (String(url).includes('/delay?')) probeSignal = signal
      else pollSignal = signal
      pending.set(String(url).includes('/delay?') ? 'probe' : 'poll', resolve)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })) as typeof fetch
    const cancel = new AbortController()
    const probe = measuring.probePaths('https://example.org/', ['pa'], cancel.signal)
    const poll = measuring.req('/connections')
    cancel.abort()
    eq(await probe, {}, 'cancelled diagnosis discards the pending controller probe')
    eq([probeSignal?.aborted, pollSignal?.aborted], [true, false], 'diagnosis cancellation preserves unrelated health and traffic requests')
    pending.get('poll')!(new Response('{"connections":[]}', { headers: { 'Content-Type': 'application/json' } }))
    ok(!!(await poll), 'traffic polling still completes after diagnosis cancellation')
    eq(measuring.requests.size, 0, 'cancelled and completed HTTP requests release their controllers')
  } finally { globalThis.fetch = fetchBefore; rmSync(dir, { recursive: true, force: true }) }
}

const affectedConnectionsCheck = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-slot-connections-'))
  try {
    const e = new Engine(process.execPath, dir, process.execPath) as any
    e.child = {}
    const dropped: string[] = []
    e.drop = async (id: string) => { dropped.push(id); return true }
    const neighbor = app('neighbor', 'C:\\Neighbor\\keep.exe', 'pb')
    const list: Route = { id: 'list:fixture', kind: 'list', list: 'fixture', name: 'List', via: 'pa', on: true }
    const routes = [list, neighbor]
    const sl = planSlots(S(routes))!
    let domains = ['removed.example', 'kept.example']
    setListResolver(() => domains)
    const before = buildRuntime(profiles, S(routes), opts(sl))
    domains = ['added.example', 'kept.example']
    const after = buildRuntime(profiles, S(routes), opts(sl))
    e.conns = [
      { id: 'removed', exe: 'C:\\Browser\\browser.exe', host: 'removed.example', route: list.id },
      { id: 'added', exe: 'C:\\Browser\\browser.exe', host: 'added.example', route: '' },
      { id: 'kept', exe: 'C:\\Browser\\browser.exe', host: 'kept.example', route: list.id },
      { id: 'neighbor', exe: neighbor.exe, host: 'removed.example', route: neighbor.id },
      { id: 'untouched', exe: '', host: 'other.example', route: '' }
    ]
    const state = (files: Record<string, string>) => ({ slots: sl, files })
    eq(await e.closeTouched(routes, routes, state(before.files), state(after.files)), { tried: 2, closed: 2 }, 'list refresh reopens only sessions whose effective card changes')
    eq(dropped.sort(), ['added', 'removed'], 'list snapshots preserve unchanged members and the higher-priority app neighbor')
    dropped.length = 0
    const disabled = routes.map(r => r.id === list.id ? { ...r, on: false } : r)
    const off = buildRuntime(profiles, S(disabled), opts(sl))
    eq(await e.closeTouched(routes, disabled, state(before.files), state(off.files)), { tried: 2, closed: 2 }, 'disabling a list matches the old compiled domains after its source has changed')
    eq(dropped.sort(), ['kept', 'removed'], 'disabled list preserves the separately routed app connection')

    dropped.length = 0
    const first = custom('shared.example', 'pa'), second = { ...custom('shared.example', 'pb'), id: 'custom:second' }
    const ordered = [first, second], reordered = [second, first]
    const oldSlots = planSlots(S(ordered))!, newSlots = planSlots(S(reordered), oldSlots)!
    e.conns = [{ id: 'overlap', exe: '', host: 'shared.example', route: first.id }]
    const oldRuntime = buildRuntime(profiles, S(ordered), opts(oldSlots)), newRuntime = buildRuntime(profiles, S(reordered), opts(newSlots))
    eq(await e.closeTouched(ordered, reordered, { slots: oldSlots, files: oldRuntime.files }, { slots: newSlots, files: newRuntime.files }), { tried: 1, closed: 1 }, 'reordering overlapping rules reopens the connection owned by the old first match')

    dropped.length = 0
    const subnet = custom('203.0.113.0/24', 'direct'), subnetRoutes = [subnet, neighbor]
    const subnetSlots = planSlots(S(subnetRoutes))!
    const subnetBefore = buildRuntime(profiles, S(subnetRoutes), opts(subnetSlots))
    const subnetOff = [{ ...subnet, on: false }, neighbor]
    const subnetAfter = buildRuntime(profiles, S(subnetOff), opts(subnetSlots))
    e.conns = [
      { id: 'cidr', exe: '', host: 'named.example', ip: '203.0.113.7', route: subnet.id },
      { id: 'neighbor', exe: neighbor.exe, host: 'named.example', ip: '203.0.113.7', route: neighbor.id }
    ]
    eq(await e.closeTouched(subnetRoutes, subnetOff, { slots: subnetSlots, files: subnetBefore.files }, { slots: subnetSlots, files: subnetAfter.files }), { tried: 1, closed: 1 }, 'CIDR card changes use the destination IP even when the connection also has a hostname')
    eq(dropped, ['cidr'], 'CIDR editing preserves a higher-priority app session')
  } finally { setListResolver(() => []); rmSync(dir, { recursive: true, force: true }) }
}

const listCheck = async () => {
  const parsed = parseDomainList('# comment\nExample.org\n*.cdn.example.net\n.short.io\ndomain:a.example\n// x\n')
  eq(parsed.domains, ['example.org', 'cdn.example.net', 'short.io', 'a.example'], 'domain list: comments, prefixes, lower case')
  eq(parsed.skipped, 0, 'a complete accepted domain list contains no discarded records')
  let mixed = ''; try { parseDomainList('good.example\ncom\nnot a domain\n') } catch (e) { mixed = (e as Error).message }
  eq(mixed, 'invalid', 'a partly invalid update is rejected instead of publishing a partial list')
  let exact = ''; try { parseDomainList('good.example\nfull:exact.example\n') } catch (e) { exact = (e as Error).message }
  eq(exact, 'invalid', 'unsupported full: entries are never silently broadened into suffix rules')
  let threw = ''; try { parseDomainList('# only comments\n') } catch (e) { threw = (e as Error).message }
  eq(threw, 'empty', 'an empty list is an error, not an empty route')
  const dir = mkdtempSync(join(tmpdir(), 'waarp-lists-'))
  try {
    const store = new Lists(dir)
    const src = store.add('Test', 'https://lists.example.org/a.txt')
    const ok200 = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    eq(await store.refresh(src.id, { fetchImpl: ok200('a.example\nb.example\n') }), true, 'list downloads')
    eq(store.domains(src.id), ['a.example', 'b.example'], 'domains are kept')
    eq(await store.refresh(src.id, { fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch }), false, 'failed download reports failure')
    eq(store.domains(src.id), ['a.example', 'b.example'], 'a failed download keeps the last good list')
    eq(await store.refresh(src.id, { fetchImpl: ok200('nothing here') }), false, 'garbage is refused')
    eq([store.domains(src.id).length, store.data[0].error], [2, 'empty'], 'garbage never replaces the list')
    eq(await store.refresh(src.id, { fetchImpl: ok200('replacement.example\nnot a domain') }), false, 'mixed valid/invalid source is refused as a whole')
    eq(store.domains(src.id), ['a.example', 'b.example'], 'partly invalid content preserves every previous domain')
    store.save()
    eq(new Lists(dir).domains(src.id), ['a.example', 'b.example'], 'restart without network keeps the list')
    const saved = readFileSync(join(dir, 'lists.json'), 'utf8')
    const fs = require('node:fs') as typeof import('node:fs'), rename = fs.renameSync
    let saveFailed = false
    try {
      fs.renameSync = () => { throw new Error('fixture locked list file') }
      store.replace(store.data.map(l => ({ ...l, domains: ['uncommitted.example'] })))
    } catch { saveFailed = true } finally { fs.renameSync = rename }
    eq(saveFailed, true, 'atomic list replacement reports a disk failure')
    eq(store.domains(src.id), ['a.example', 'b.example'], 'failed persistence cannot expose new domains to the running compiler')
    eq(readFileSync(join(dir, 'lists.json'), 'utf8'), saved, 'failed list persistence retains the previous offline snapshot')
    eq(existsSync(join(dir, 'lists.json.tmp')), false, 'failed list persistence cleans the staging file')

    let answer!: (value: Response) => void
    const earlier = store.download(src.id, { fetchImpl: (() => new Promise<Response>(r => { answer = r })) as typeof fetch })
    const latest = await store.download(src.id, { fetchImpl: ok200('new.example') })
    answer(new Response('late.example'))
    const late = await earlier
    eq(store.updated(late!), undefined, 'an older download cannot replace a newer completed request')
    store.patch(src.id, { enabled: false })
    store.replace(store.updated(latest!)!)
    eq(store.data[0].enabled, false, 'refresh completion preserves a source disabled during download')
    eq(store.domains(src.id), [], 'a disabled list routes nothing')
    eq(new Lists(dir).data[0].enabled, false, 'disabled source remains disabled after an offline restart')
    let bad = ''; try { store.add('x', 'http://plain.example/') } catch (e) { bad = (e as Error).message }
    eq(bad, 'url', 'only https sources')
    bad = ''; try { store.add('x', 'https://user:fixture@example.org/list') } catch (e) { bad = (e as Error).message }
    eq(bad, 'url', 'credential-bearing URL is rejected before it enters persisted source settings')
    const removed = store.add('Remove', 'https://lists.example.org/remove')
    const pendingRemoval = await store.download(removed.id, { fetchImpl: ok200('removed.example') })
    store.remove(removed.id)
    eq(store.updated(pendingRemoval!), undefined, 'a late source result cannot resurrect a deleted list')
    writeFileSync(join(dir, 'lists.json'), JSON.stringify([{ ...store.data[0], enabled: true, domains: ['*'] }]))
    eq(new Lists(dir).domains(src.id), [], 'invalid cached selectors are refused before route compilation')

    const listId = src.id
    let doms = ['a.example']
    setListResolver(id => (id === listId ? doms : []))
    const withList = [...base, { id: 'list:' + listId, kind: 'list' as const, name: 'L', list: listId, via: 'pa', on: true }]
    const sl = planSlots(S(withList), slots)!
    const before = buildRuntime(profiles, S(withList), opts(sl))
    const lslot = 'rd' + sl.dom.indexOf('list:' + listId)
    ok(before.files[lslot].includes('a.example'), 'a list card fills its slot from the list snapshot')
    doms = ['a.example', 'z.example']
    const after = buildRuntime(profiles, S(withList), opts(sl))
    ok(!!liveSwitches(before.cfg, after.cfg) && after.files[lslot].includes('z.example'), 'a list update is a live rule-file change, not a restart')
    ok(after.files['dn-p-pa'].includes('z.example'), 'list domains resolve DNS through the card tunnel')
    const patch = checkedPatch({ routes: withList })
    ok(patch.ok, 'settings accept a list card')
    ok(!checkedPatch({ routes: [{ id: 'list:x', kind: 'list', name: 'L', list: '../evil', via: 'pa', on: true }] }).ok, 'a malformed list id is refused')
  } finally { rmSync(dir, { recursive: true, force: true }); setListResolver(() => []) }
}

void rulesCheck().then(nativeWitnessCheck).then(lifecycleCheck).then(affectedConnectionsCheck).then(listCheck).then(() => {
console.log(`slots: ${n - fails}/${n} passed`)
if (fails) process.exit(1)
})
