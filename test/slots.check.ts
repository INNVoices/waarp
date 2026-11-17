import { buildRuntime, liveSwitches, parseConf, planSlots, ruleFileOf, CANARY, canaryFile } from '../src/main/awg'
import { appKey, appPatterns, dedupeApps, exeHits, routeHits } from '../src/shared/appmatch'
import { migrate } from '../src/main/store-core'
import { Engine } from '../src/main/engine'
import { CANARY_IP } from '../src/main/awg'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
ok(run0.cfg.route.rules.some((r: any) => r.ip_version === 6 && r.action === 'reject' && !r.rule_set), 'everything else over IPv6 is refused fast without host IPv6')
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
    for (const [tag, body] of Object.entries(rt.files)) writeFileSync(join(rules, ruleFileOf(tag)), body)
    writeFileSync(join(rules, ruleFileOf(CANARY)), canaryFile('start.waarp.invalid'))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(rt.cfg))
    const check = spawnSync(join(process.cwd(), 'engine', 'sing-box.exe'), ['check', '-c', file], { encoding: 'utf8', timeout: 15000 })
    ok(check.status === 0, 'pinned engine accepts the slot config and rule files: ' + String(check.stderr).slice(-600))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const rulesCheck = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-rules-apply-'))
  try {
    const e = new Engine(process.execPath, dir, process.execPath) as any
    e.req = async () => ({ Answer: [{ data: CANARY_IP }] })
    eq(await e.writeRules(['ra0'], { ra0: '{"version":3,"rules":[]}' }, () => true), true, 'written rule files with a confirmed canary apply')
    writeFileSync(join(dir, 'blocked'), 'x')
    const blocked = new Engine(process.execPath, join(dir, 'blocked'), process.execPath) as any
    blocked.req = async () => ({ Answer: [{ data: CANARY_IP }] })
    eq(await blocked.writeRules(['ra0'], { ra0: '{}' }, () => true), false, 'a failed rule file write is never reported as applied, even if the canary would answer')
    const silent = new Engine(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-rules-silent-')), process.execPath) as any
    silent.req = async () => undefined
    eq(await silent.writeRules(['ra0'], { ra0: '{}' }, () => false), false, 'no canary answer means not applied')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

void rulesCheck().then(() => {
console.log(`slots: ${n - fails}/${n} passed`)
if (fails) process.exit(1)
})
