import { buildConfig, parseConf, usedProfiles } from '../src/main/awg'
import { peekClip } from '../src/main/clip'
import { parseVless } from '../src/main/vless'
import { dropGroup, dropServer, migrate } from '../src/main/store-core'
import { AUTO_ID, AUTO_BUDGET, autoSample, autoMembers, withAuto, firstAlive, stickyFastest, SLOW_ROUNDS, groupName, isGroupId, liveGroups, newGroupId } from '../src/shared/groups'
import { compilePlan } from '../src/shared/plan'
import { checkedPatch } from '../src/main/validate'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Group, Profile, Route, Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const PK = 'gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U='
const PUB = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM='
const CONF = `[Interface]\nPrivateKey = ${PK}\nAddress = 10.8.0.7/32\nDNS = 1.1.1.1\nJc = 4\nJmin = 10\nJmax = 50\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\n\n[Peer]\nPublicKey = ${PUB}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.10:51820\n`
const UUID = '11111111-2222-3333-4444-555555555555'
const LINK = `vless://${UUID}@198.51.100.7:443?type=tcp&security=reality&pbk=${PUB.slice(0, 43).replace(/[+/]/g, 'a')}&sid=ab12&fp=firefox&sni=www.example.com#Demo`

const a = parseConf(CONF, 'Сервер 1')
const b = parseConf(CONF.replace('203.0.113.10', '203.0.113.11').replace(PK, PUB), 'Сервер 2')
const c = parseVless(LINK, 'Сервер 3')
const profiles: Profile[] = [a, b, c]
const G = (id: string, members: string[], policy: Group['policy'] = 'fastest'): Group => ({ id, name: id, policy, members })
const route = (id: string, via: string, extra: Partial<Route> = {}): Route => ({ id, kind: 'custom', name: id, value: id + '.example.com', via, on: true, ...extra })
const S = (p: Partial<Settings>): Settings => ({ rest: 'direct', groups: [], routes: [], ruDirect: true, dnsAll: false, lanDirect: true, tray: false, autoConnect: false, autostart: false, notify: false, ...p })
const cfg = (s: Settings) => buildConfig(profiles, s, { api: { port: 1, secret: 'x' } }) as any

// ---- groups: ids, names, live set
ok(isGroupId('g-ab12cd34') && !isGroupId(a.id) && newGroupId().startsWith('g-'), 'group ids never collide with tunnel ids')
eq(groupName([]), 'Группа 1', 'first group name')
eq(groupName([{ id: 'g-1', name: 'Группа 2', policy: 'first', members: [] }], 1), 'Группа 1', 'free name picked')
eq(groupName([{ id: 'g-1', name: 'Группа 1', policy: 'first', members: [] }], 1), 'Группа 2', 'taken name skipped')
const g1 = G('g-one', [a.id, c.id])
eq(liveGroups(S({ groups: [g1] }), new Set(profiles.map(p => p.id))), [], 'unused group is not live')
eq(liveGroups(S({ groups: [g1], rest: 'g-one' }), new Set(profiles.map(p => p.id))).map(g => g.members), [[a.id, c.id]], 'group used by global mode is live')
eq(liveGroups(S({ groups: [g1], rest: 'g-one' }), new Set([c.id])).map(g => g.members), [[c.id]], 'members that are gone are dropped')
eq(liveGroups(S({ groups: [g1], rest: 'g-one' }), new Set()).length, 0, 'a group without members is not live')
eq(liveGroups(S({ groups: [g1], routes: [route('x', 'g-one', { on: false })] }), new Set(profiles.map(p => p.id))).length, 0, 'an off card does not make its group live')

// ---- a card targets a group
const withGroup = S({ groups: [g1], routes: [route('site', 'g-one')] })
eq(usedProfiles(withGroup, profiles).map(p => p.id).sort(), [a.id, c.id].sort(), 'a group pulls its members into the config, others stay out')
const k1 = cfg(withGroup)
const ut = k1.outbounds.find((o: any) => o.tag === 'grp-g-one')
ok(ut && ut.type === 'selector', 'fastest group = Waarp-driven selector, no urltest ping-chasing')
eq(ut.outbounds, ['p-' + a.id, 'p-' + c.id], 'selector members in order (AWG endpoint + VLESS outbound)')
ok(ut.interrupt_exist_connections === false && ut.default === 'p-' + a.id, 'fastest: an improvement switch does not break established sessions')
ok(!JSON.stringify(k1.outbounds).includes('urltest'), 'no urltest anywhere')
const rule = k1.route.rules.find((r: any) => r.domain_suffix?.includes('site.example.com'))
eq(rule.outbound, 'grp-g-one', 'the card rule goes to the group')
ok(k1.dns.servers.some((d: any) => d.tag === 'dns-g-one' && d.detour === 'grp-g-one'), 'group has its own DNS server through the group')
ok(k1.dns.rules.some((r: any) => r.server === 'dns-g-one'), 'card domains are resolved through the group')
ok(k1.endpoints.length === 1 && k1.outbounds.some((o: any) => o.type === 'vless'), 'both kinds of member are present')
const first = cfg(S({ groups: [G('g-first', [c.id, a.id], 'first')], routes: [route('site', 'g-first')] })).outbounds.find((o: any) => o.tag === 'grp-g-first')
eq([first.type, first.default, first.outbounds[0]], ['selector', 'p-' + c.id, 'p-' + c.id], 'first alive uses an ordered selector')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'ok', [c.id]: 'ok' }), a.id, 'first alive holds the healthy selection')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'degraded', [c.id]: 'ok' }), a.id, 'one failed probe does not switch sessions')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'down', [c.id]: 'ok' }), c.id, 'confirmed failure switches to next healthy member')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'busy', [c.id]: 'ok' }), c.id, 'credential busy in another client switches to an eligible member')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'unknown', [c.id]: 'ok' }), c.id, 'unknown member does not hide a verified healthy member')
eq(firstAlive([a.id, c.id], c.id, { [a.id]: 'ok', [c.id]: 'ok' }), c.id, 'recovered primary does not preempt a healthy session')
eq(firstAlive([a.id, c.id], a.id, { [a.id]: 'down', [c.id]: 'down' }), a.id, 'no healthy member never falls back to direct')
if (process.platform === 'win32' && existsSync(join(process.cwd(), 'engine', 'sing-box.exe'))) {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-config-check-'))
  try {
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(cfg(S({ groups: [G('g-first', [a.id, b.id], 'first')], rest: 'g-first' }))))
    const check = spawnSync(join(process.cwd(), 'engine', 'sing-box.exe'), ['check', '-c', file], { encoding: 'utf8', timeout: 15000 })
    ok(check.status === 0, 'pinned engine accepts first-alive selector and imported UDP DNS: ' + String(check.stderr).slice(-400))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
eq(cfg(S({ groups: [g1], routes: [route('site', 'g-one', { fallback: a.id })] })).outbounds.filter((o: any) => o.type === 'selector' && String(o.tag).startsWith('sel-')).length, 0, 'no fallback selector around a group')
eq(cfg(S({ groups: [g1], routes: [route('site', a.id, { fallback: 'g-one' })] })).outbounds.filter((o: any) => o.type === 'selector').length, 0, 'a group is not a fallback target')
const gone = cfg(S({ groups: [G('g-x', ['nope'])], routes: [route('site', 'g-x')] }))
eq(gone.route.rules.find((r: any) => r.domain_suffix?.includes('site.example.com')).action, 'reject', 'C03: a group with no members is blocked, never direct or a missing tag')
eq(gone.dns.rules.find((r: any) => r.domain_suffix?.includes('site.example.com')).action, 'reject', 'C03: DNS for a missing target is rejected instead of leaking to the local resolver')
ok(!gone.outbounds.some((o: any) => o.type === 'urltest'), 'no empty urltest is written')
if (process.platform === 'win32' && existsSync(join(process.cwd(), 'engine', 'sing-box.exe'))) {
  const dir = mkdtempSync(join(tmpdir(), 'waarp-dns-reject-check-'))
  try {
    const file = join(dir, 'config.json'); writeFileSync(file, JSON.stringify(gone))
    const check = spawnSync(join(process.cwd(), 'engine', 'sing-box.exe'), ['check', '-c', file], { encoding: 'utf8', timeout: 15000 })
    ok(check.status === 0, 'pinned engine accepts fail-closed DNS reject rules: ' + String(check.stderr).slice(-400))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---- global mode: everything through X, cards set to direct are the exceptions
const all = cfg(S({ rest: a.id, routes: [route('keep', 'direct'), route('site', c.id)] }))
eq(all.route.final, 'p-' + a.id, 'everything through a tunnel')
eq(all.route.rules.find((r: any) => r.domain_suffix?.includes('keep.example.com')).outbound, 'direct', 'a direct card is the exception')
eq(all.route.rules.find((r: any) => r.domain_suffix?.includes('site.example.com')).outbound, 'p-' + c.id, 'a card keeps its own tunnel')
eq(all.dns.final, 'dns-' + a.id, 'dns follows the global tunnel')
ok(all.route.rules.some((r: any) => r.outbound === 'direct' && r.domain_suffix?.includes('ru')), 'russian sites stay direct in global mode (ruDirect)')
ok(!cfg(S({ rest: a.id, ruDirect: false, routes: [] })).route.rules.some((r: any) => r.domain_suffix?.includes('ru')), 'ruDirect off removes the russian exception')
ok(all.route.rules.some((r: any) => r.ip_is_private && r.outbound === 'direct') && all.inbounds[0].route_exclude_address?.length > 0, 'LAN bypass is explicit and enabled by default')
const noLanBypass = cfg(S({ rest: a.id, lanDirect: false, routes: [] }))
ok(!noLanBypass.route.rules.some((r: any) => r.ip_is_private) && !('route_exclude_address' in noLanBypass.inbounds[0]), 'LAN bypass can be disabled without a hidden route exclusion')
ok(noLanBypass.inbounds[0].address.some((x: string) => x.includes(':')), 'TUN is dual-stack so literal IPv6 does not bypass routing policy')
const allG = cfg(S({ rest: 'g-one', groups: [g1], routes: [route('keep', 'direct')] }))
eq(allG.route.final, 'grp-g-one', 'everything through a group')
eq(allG.dns.final, 'dns-g-one', 'dns follows the group')
eq(cfg(S({ rest: 'direct' })).route.final, 'direct', 'only the cards: the rest goes as usual')
eq(cfg(S({ rest: 'g-missing' })).route.final, 'direct', 'a missing group never becomes the final tag')
ok(cfg(S({ rest: 'g-missing' })).dns.rules.some((r: any) => r.action === 'reject' && !r.domain_suffix), 'missing global target rejects DNS as well as traffic')

// ---- removing a tunnel / group
const full = S({ rest: 'g-one', allVia: 'g-one', groups: [g1, G('g-two', [c.id])], routes: [route('r1', 'g-two'), route('r2', a.id)] })
const noC = dropServer(full, c.id)
eq(noC.groups.map(g => g.id), ['g-one'], 'a group left without members is removed')
eq(noC.groups[0].members, [a.id], 'the tunnel leaves the other groups')
const r1 = noC.routes.find(r => r.id === 'r1')!
ok(r1.via === 'g-two' && r1.on === true, 'C03: a card of the removed group stays on it (blocked until the user picks another)')
eq(noC.routes.find(r => r.id === 'r2')!.via, a.id, 'other cards are untouched')
const noA = dropServer(noC, a.id)
eq([noA.allVia, noA.groups.length], [undefined, 0], 'C03: the global mode ends when its group disappears; its traffic stays blocked, never direct')
const noG = dropGroup(full, 'g-two')
eq([noG.groups.map(g => g.id), noG.routes.find(r => r.id === 'r1')!.on], [['g-one'], true], 'C03: removing a group keeps its cards on it (blocked), never direct')
eq(migrate({ routes: [], rest: 'direct' }).groups, [], 'settings saved before groups open with none')

// ---- clipboard: what is recognised, and a preview without secrets
const pc = peekClip(CONF)
ok(pc.kind === 'awg' && pc.host === '203.0.113.10' && !!pc.version, 'clipboard: a .conf is recognised with host and protocol')
const pv = peekClip(LINK)
ok(pv.kind === 'vless' && pv.host === '198.51.100.7' && pv.count === 1, 'clipboard: a vless link is recognised')
ok(!JSON.stringify(pc).includes(PK) && !JSON.stringify(pv).includes(UUID) && !JSON.stringify(pv).includes('ab12'), 'clipboard: the preview never carries a key or uuid')
eq(peekClip(LINK + '\n' + LINK.replace('198.51.100.7', '198.51.100.8')).count, 2, 'clipboard: a list of links is counted')
const TROJAN = 'trojan://secret@example.net:443?sni=example.net#Trojan'
eq(peekClip(Buffer.from(TROJAN).toString('base64')).kind, 'other', 'clipboard: a base64 non-VLESS subscription is recognised')
eq(peekClip(JSON.stringify({ url: TROJAN })).host, 'example.net', 'clipboard: a link inside a JSON container is recognised')
eq(peekClip('https://sub.example.com/abc?token=secret').kind, 'sub', 'clipboard: a subscription url')
eq(peekClip('https://sub.example.com/abc?token=secret').host, 'sub.example.com', 'clipboard: only the host of a subscription is shown')
eq(['', '   ', 'hello world', 'password123', 'C:\\Users\\x\\file.txt', '[Interface]\nfoo', 'vless://broken'].map(t => peekClip(t).kind), ['none', 'none', 'none', 'none', 'none', 'none', 'none'], 'clipboard: anything else is not offered')
eq(peekClip('x'.repeat(300_000)).kind, 'none', 'clipboard: a huge text is not parsed')

// ---- authoritative plan: UI, guard and engine share the same profile roles
const operaNl = compilePlan(S({
  rest: 'direct',
  routes: [route('opera', c.id, { fallback: a.id })]
}), profiles)
eq(operaNl.scope, 'cards', 'card selection does not inherit a stale whole-computer scope')
eq(operaNl.requiredProfiles, [c.id], 'only the chosen primary is required')
eq(operaNl.standbyProfiles, [a.id], 'fallback is standby, not active primary')
ok(operaNl.canStart, 'a healthy card route can start independently of its standby')
const staleGlobal = compilePlan(S({ rest: 'missing', routes: [route('opera', c.id)] }), profiles)
eq(staleGlobal.blockedTargets, ['missing'], 'missing whole-computer target is explicit in the plan')
ok(staleGlobal.canStart, 'missing whole-computer target starts the reject policy instead of leaking direct')
const missingFallback = compilePlan(S({ routes: [route('opera', c.id, { fallback: 'gone' })] }), profiles)
ok(missingFallback.canStart && missingFallback.warnings.includes('standby-missing:gone'), 'missing standby warns without blocking a valid primary')

// ---- W2.2 sticky fastest: no ping-chasing
{
  const H = { x: 'ok', y: 'ok' } as const
  let st = { next: 'x', streak: 0 }
  st = stickyFastest(['x', 'y'], 'x', H, { x: 60, y: 55 }, 0); eq(st, { next: 'x', streak: 0 }, '5 ms faster never moves the session')
  st = stickyFastest(['x', 'y'], 'x', H, { x: 160, y: 60 }, 0); eq(st, { next: 'x', streak: 0 }, '100 ms gap under the 150 ms bar: hold')
  let s2 = 0, moved = ''
  for (let i = 1; i <= SLOW_ROUNDS; i++) { const r = stickyFastest(['x', 'y'], 'x', H, { x: 400, y: 60 }, s2); s2 = r.streak; if (r.next !== 'x') moved = r.next + '@' + i }
  eq(moved, 'y@' + SLOW_ROUNDS, 'sustained clear gap moves only after the full streak')
  const one = stickyFastest(['x', 'y'], 'x', H, { x: 60, y: 55 }, SLOW_ROUNDS - 1); eq(one.streak, 0, 'one good round resets the streak')
  eq(stickyFastest(['x', 'y'], 'x', { x: 'degraded', y: 'ok' }, { x: undefined, y: 50 }, 0).next, 'x', 'one failed round holds')
  eq(stickyFastest(['x', 'y'], 'x', { x: 'down', y: 'ok' }, { x: undefined, y: 50 }, 0).next, 'y', 'confirmed down fails over at once')
  eq(stickyFastest(['x', 'y'], 'x', { x: 'down', y: 'down' }, {}, 0).next, 'x', 'nothing alive: keep (never direct)')
  eq(stickyFastest(['x', 'y'], 'x', { x: 'busy', y: 'ok' }, { y: 70 }, 0).next, 'y', 'busy current moves to a working member')
}

// ---- W2.3 Auto: built-in sticky group over own connections
{
  const pub = { ...b, source: 'public' } as unknown as Profile
  const rev = { ...c, revoked: true } as Profile
  eq(autoMembers([a, pub, rev]), [a.id], 'Auto takes own live connections only: no public, no revoked')
  const sa = S({ routes: [route('site', AUTO_ID)] })
  const wa = withAuto(sa, profiles)
  eq(wa.groups.map(g => [g.id, g.policy]), [[AUTO_ID, 'fastest']], 'Auto group synthesized only when used, sticky fastest')
  eq(withAuto(S({ routes: [route('site', a.id)] }), profiles).groups.length, 0, 'unused Auto adds nothing')
  const k = cfg(sa)
  const ag = k.outbounds.find((o: any) => o.tag === 'grp-' + AUTO_ID)
  ok(ag && ag.type === 'selector' && ag.interrupt_exist_connections === false, 'Auto = Waarp-driven selector')
  eq(k.route.rules.find((r: any) => r.domain_suffix?.includes('site.example.com'))?.outbound, 'grp-' + AUTO_ID, 'route goes to Auto')
  ok(!JSON.stringify(ag.outbounds).includes('direct'), 'Auto never contains Direct')
  const none = compilePlan(sa, [pub])
  ok(none.blockedTargets.includes(AUTO_ID), 'Auto with no own connections is blocked (fail closed), not Direct')
  ok(!checkedPatch({ groups: [{ id: AUTO_ID, name: 'x', policy: 'first', members: [a.id] }] }).ok || !(checkedPatch({ groups: [{ id: AUTO_ID, name: 'x', policy: 'first', members: [a.id] }] }) as any).patch.groups, 'a persisted group cannot take the Auto id')
}

// ---- W2 B: Auto probing is bounded, rotates, never switches to an unprobed member
{
  const M = Array.from({ length: 100 }, (_, i) => 'm' + i)
  const seen = new Set<string>()
  let cur = 0, ok1 = true, okCur = true
  for (let round = 0; round < 20; round++) {
    const r = autoSample(M, 'm7', cur); cur = r.cursor
    if (r.probe.length > AUTO_BUDGET) ok1 = false
    if (r.probe[0] !== 'm7') okCur = false
    r.probe.forEach(x => seen.add(x))
  }
  ok(ok1, 'never more than the budget per round with 100 members')
  ok(okCur, 'the current member is always probed')
  eq(seen.size, Math.min(100, 1 + 20 * (AUTO_BUDGET - 1)), 'rotation progresses through the library')
  eq(autoSample(['a', 'b'], 'a', 0).probe, ['a', 'b'], 'small libraries probe everything')
  // unprobed member has no ping: stickyFastest cannot pick it even if current dies
  const health = { m7: 'down', m50: 'ok' } as Record<string, 'ok' | 'down'>
  eq(stickyFastest(M, 'm7', health, { m1: 40 }, 0).next, 'm7', 'no switch to a member without evidence this round')
  eq(stickyFastest(M, 'm7', { m7: 'down', m1: 'ok' }, { m1: 40 }, 0).next, 'm1', 'switch only to a sampled member with evidence')
  // plan: Auto candidates are standby, so a busy candidate key cannot block start
  const plan = compilePlan(S({ routes: [route('site', AUTO_ID)] }), profiles)
  eq(plan.requiredProfiles.length, 0, 'Auto members are not all required')
  ok(plan.standbyProfiles.length === autoMembers(profiles).length && plan.canStart, 'Auto members are candidates (standby) and the plan can start')
}

console.log(fails ? `${fails} of ${n} FAILED` : `all ${n} group checks passed`)
process.exit(fails ? 1 : 0)
