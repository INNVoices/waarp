import { deflateSync } from 'node:zlib'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { appRules, buildConfig, tagOf, usedProfiles, ConfError, createWireGuardProfile, detectVersion, matchDirFor, parseConf, redact, splitCustom, unwrapKey, validateCustom } from '../src/main/awg'
import { conflicts } from '../src/main/guard'
import { peekClip } from '../src/main/clip'
import { parseVless, redactVless, vlessSecrets } from '../src/main/vless'
import { cleanPatch, importRequest, probeTarget, profileName } from '../src/main/validate'
import { catalogLabel, roundRobin, sourceLabel } from '../src/main/catalog-sample'
import type { Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
const throws = (f: () => unknown, msg: string) => { try { f(); ok(false, msg) } catch (e) { ok(e instanceof ConfError, msg + ' (ConfError)') } }

const PK = 'gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U='
const PUB = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM='
const CONF = `[Interface]
PrivateKey = ${PK}
Address = 10.8.0.7/32, fd00::7
DNS = 1.1.1.1, 1.0.0.1
MTU = 1376
Jc = 4
Jmin = 10
Jmax = 50
S1 = 86
S2 = 12
S3 = 30
S4 = 9
H1 = 1020325451-1020325500
H2 = 3288052141
H3 = 1766607858
H4 = 2528465083
I1 = <b 0xc6000000><r 16>

[Peer]
PublicKey = ${PUB}
PresharedKey = ${PUB}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.10:51820
PersistentKeepalive = 25
`

const p = parseConf(CONF, 'Сервер 1')
eq(p.address, ['10.8.0.7/32', 'fd00::7/128'], 'address prefixes')
eq(p.peer, { publicKey: PUB, presharedKey: PUB, host: '203.0.113.10', port: 51820, keepalive: 25 }, 'peer')
eq(p.mtu, 1376, 'mtu')
eq(p.awg.jc, 4, 'jc number')
eq(p.awg.h1, '1020325451-1020325500', 'h1 range')
eq(p.awg.i1, '<b 0xc6000000><r 16>', 'i1 kept')
eq(p.version, 'AmneziaWG 2', 'version v2')
eq(detectVersion({ jc: 3, h1: '1' }), 'AmneziaWG 1', 'version v1')
eq(detectVersion({}), 'WireGuard', 'plain wg')

const crlf = parseConf(CONF.replace(/\n/g, '\r\n').replace('Endpoint = 203.0.113.10:51820', 'Endpoint = [2001:db8::1]:443'))
eq(crlf.peer.host, '2001:db8::1', 'ipv6 endpoint + CRLF')
eq(crlf.peer.port, 443, 'ipv6 port')

throws(() => parseConf('hello'), 'garbage')
throws(() => parseConf(CONF.replace(/PrivateKey.*\n/, '')), 'no private key')
throws(() => parseConf(CONF.replace(/Endpoint.*\n/, '')), 'no endpoint')
throws(() => parseConf(CONF.replace('Jc = 4', 'Jc = x')), 'bad jc')
throws(() => parseConf(CONF.replace(PK, 'not-a-key')), 'invalid private key rejected before connecting')
throws(() => parseConf(CONF.replace('Endpoint = 203.0.113.10:51820', 'Endpoint = 203.0.113.10:70000')), 'invalid endpoint port rejected')
throws(() => parseConf(CONF.replace('Address = 10.8.0.7/32, fd00::7', 'Address = 10.8.0.7/99')), 'invalid address mask rejected')
throws(() => parseConf(CONF.replace('Address = 10.8.0.7/32, fd00::7', 'Address = 10.8.0.7/')), 'empty address mask rejected')
throws(() => parseConf(CONF.replace('MTU = 1376', 'MTU = 99999')), 'unsafe MTU rejected')
throws(() => parseConf(CONF.replace('MTU = 1376', 'PostUp = calc.exe')), 'system hook rejected, never executed or ignored')
throws(() => parseConf(CONF + '\n[Peer]\nPublicKey = ' + PUB + '\nEndpoint = 203.0.113.11:51820\n'), 'multiple peers rejected instead of partially imported')
const made = createWireGuardProfile({ name: 'Мой WG', address: '10.8.0.2/32', endpoint: 'vpn.example.com:51820', serverPublicKey: PUB })
eq(made.profile.version, 'WireGuard', 'generated profile is plain WireGuard')
eq(made.profile.peer.host, 'vpn.example.com', 'generated endpoint')
ok(made.clientPublicKey.length === 44 && made.profile.privateKey.length === 44, 'generated key pair shape')
const seed = Buffer.from(made.profile.privateKey, 'base64')
const imported = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
eq(createPublicKey(imported).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), made.clientPublicKey, 'saved private key matches displayed public key')
ok(createWireGuardProfile({ name: 'Мой WG', address: '10.8.0.2/32', endpoint: 'vpn.example.com:51820', serverPublicKey: PUB }).profile.privateKey !== made.profile.privateKey, 'new profile gets a new key')
throws(() => createWireGuardProfile({ name: 'bad\n[Peer]', address: '10.8.0.2/32', endpoint: 'vpn.example.com:51820', serverPublicKey: PUB }), 'generated config rejects injected lines')
const clip = peekClip(CONF)
eq(clip.kind, 'awg', 'clipboard recognizes AWG config')
ok(!JSON.stringify(clip).includes(PK), 'clipboard preview hides private key')
ok(clip.fingerprint !== peekClip(CONF.replace('10.8.0.7', '10.8.0.8')).fingerprint, 'clipboard recognizes changed config at same host')

const json = JSON.stringify({ containers: [{ container: 'amnezia-awg', awg: { last_config: JSON.stringify({ config: CONF }) } }] })
const raw = Buffer.from(json)
const q = Buffer.concat([Buffer.from([0, 0, 0, 0]), deflateSync(raw)])
q.writeUInt32BE(raw.length, 0)
const key = 'vpn://' + q.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
ok(unwrapKey(key).includes(PK), 'vpn:// key unwrap')
eq(parseConf(key).peer.host, '203.0.113.10', 'vpn:// parse')

ok(!redact(`key ${PK} x`).includes(PK), 'redact key')

eq(matchDirFor('C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0.9213\\Discord.exe'), 'C:\\Users\\me\\AppData\\Local\\Discord', 'squirrel dir')
eq(matchDirFor('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'C:\\Program Files\\Google\\Chrome\\Application', 'chrome dir')
eq(matchDirFor('C:\\Windows\\System32\\notepad.exe'), undefined, 'system32 generic')
eq(matchDirFor('C:\\Program Files\\tool.exe'), undefined, 'program files root generic')
eq(matchDirFor('C:\\Users\\me\\AppData\\Local\\Programs\\x.exe'), undefined, 'programs root generic')
eq(matchDirFor('D:\\game.exe'), undefined, 'drive root generic')

const r = appRules([{ exe: 'C:\\A (x86)\\D\\d.exe', matchDir: 'C:\\A (x86)\\D' }, { exe: 'C:\\Windows\\notepad.exe' }])
eq(r.exact, ['C:\\Windows\\notepad.exe'], 'exact rules')
ok(new RegExp(r.regex[0].replace('(?i)', ''), 'i').test('c:\\a (x86)\\d\\sub\\helper.exe'), 'regex matches folder child')
ok(!new RegExp(r.regex[0].replace('(?i)', ''), 'i').test('C:\\A (x86)\\Dx\\d.exe'), 'regex no sibling prefix')

eq(splitCustom(['Example.com', '*.foo.org', '1.2.3.4', '10.0.0.0/8', 'https://bar.net/path', '2001:db8::/32']), { domains: ['example.com', 'foo.org', 'bar.net'], cidrs: ['1.2.3.4/32', '10.0.0.0/8', '2001:db8::/32'] }, 'split custom')
eq(validateCustom('example.com'), null, 'valid domain')
eq(validateCustom('сайт.рф'), null, 'valid idn')
eq(validateCustom('1.2.3.0/24'), null, 'valid cidr')
ok(validateCustom('300.1.1.1') !== null, 'bad ip')
ok(validateCustom('1.2.3.4/40') !== null, 'bad mask')
eq(validateCustom('2001:db8::/48'), null, 'valid ipv6 cidr')
ok(validateCustom('::::/999') !== null && validateCustom('2001:db8::/129') !== null, 'bad ipv6 or mask')
ok(validateCustom('hello') !== null, 'bad word')
eq(importRequest({ file: true }), { file: true, clipboard: false }, 'IPC file import shape')
eq(importRequest({ text: 'vless://sample', name: 'Sample' }), { text: 'vless://sample', name: 'Sample', file: false, clipboard: false }, 'IPC text import shape')
eq(importRequest({ file: true, text: 'x' }), null, 'IPC rejects ambiguous import source')
eq(importRequest({ qrToken: 'a'.repeat(32) }), { file: false, clipboard: false, qrToken: 'a'.repeat(32) }, 'IPC accepts an opaque one-time QR token')
eq(importRequest({ qrToken: 'not-a-token' }), null, 'IPC rejects a malformed QR token')
eq(importRequest({ text: 'x'.repeat(1024 * 1024 + 1) }), null, 'IPC bounds import text')
eq(cleanPatch({ routes: [{ id: 'a', kind: 'app', name: 'A', via: 'direct', on: true, icon: 'https://example.com/track.png' }] }), {}, 'IPC rejects remote app icons')
eq(cleanPatch({ routes: [{ id: 'x', kind: 'custom', name: 'bad', value: '::::/999', via: 'direct', on: true }] }), {}, 'IPC rejects semantically invalid custom routes')
const duplicateRoute = { id: 'same', kind: 'custom' as const, name: 'same', value: 'example.com', via: 'direct', on: true }
eq(cleanPatch({ routes: [duplicateRoute, duplicateRoute] }), {}, 'IPC rejects duplicate route ids instead of creating ambiguous UI/config state')
eq(profileName({ trim: true }), null, 'IPC rejects non-string name')
eq(profileName('  New name  '), 'New name', 'IPC normalizes profile name')
eq(probeTarget('https://user:pass@example.com'), null, 'IPC rejects credentials in probe URL')
eq(probeTarget('javascript:alert(1)'), null, 'IPC rejects invalid probe scheme')
eq(probeTarget('example.com'), 'https://example.com/', 'IPC normalizes probe target')
eq(roundRobin([[1, 2, 3], [4], [5, 6]]), [1, 4, 5, 2, 6, 3], 'catalog samples across sources instead of source order')
eq(catalogLabel('By EbraSha', 'DE', 'example.net'), 'DE · example.net', 'catalog replaces a source credit with country and host')
eq(catalogLabel('Fast node', 'DE', 'example.net'), 'Fast node', 'catalog keeps a useful original name')
eq(sourceLabel('https://www.vpngate.net/api/iphone/'), 'VPN Gate', 'catalog names VPN Gate as its own source')
eq(sourceLabel('https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt'), 'Russia checked', 'catalog exposes region-checked source provenance')

const q2 = parseConf(CONF.replace('203.0.113.10', '198.51.100.3').replace(PK, PUB), 'Сервер 2')
const T = tagOf(p.id), T2 = tagOf(q2.id)
const S: Settings = {
  rest: 'direct', groups: [], ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: false,
  routes: [
    { id: 'a', kind: 'app', name: 'D', exe: 'C:\X\D\d.exe', matchDir: 'C:\X\D', wholeDir: true, via: p.id, on: true },
    { id: 'b', kind: 'app', name: 'N', exe: 'C:\Y\n.exe', matchDir: 'C:\Y', wholeDir: false, via: q2.id, on: true },
    { id: 'c', kind: 'app', name: 'Off', exe: 'C:\Z\z.exe', via: p.id, on: false },
    { id: 'd', kind: 'preset', name: 'Telegram', preset: 'telegram', via: q2.id, on: true },
    { id: 'e', kind: 'custom', name: 'rutracker.org', value: 'rutracker.org', via: p.id, on: true },
    { id: 'f', kind: 'custom', name: '5.6.7.8', value: '5.6.7.8', via: 'direct', on: true }
  ]
}
const c: any = buildConfig([p, q2], S, { api: { port: 19001, secret: 's' }, selfExe: 'C:\F\f.exe' })
const rr = c.route.rules
eq(c.route.final, 'direct', 'rest direct -> final direct')
eq(c.endpoints.map((x: any) => x.tag).sort(), [T, T2].sort(), 'two endpoints')
ok(rr.some((x: any) => x.process_path_regex?.length === 1 && x.outbound === T), 'app D -> server 1 by folder')
ok(rr.some((x: any) => x.process_path?.[0] === 'C:\Y\n.exe' && x.outbound === T2), 'app N -> server 2 exact (wholeDir off)')
ok(!JSON.stringify(rr).includes('z.exe'), 'disabled route ignored')
ok(rr.some((x: any) => x.domain_suffix?.includes('telegram.org') && x.outbound === T2), 'preset -> server 2')
ok(rr.some((x: any) => x.ip_cidr?.includes('149.154.160.0/20') && x.outbound === T2), 'preset cidrs -> server 2')
ok(rr.some((x: any) => x.domain_suffix?.includes('rutracker.org') && x.outbound === T), 'custom -> server 1')
ok(rr.some((x: any) => x.ip_cidr?.includes('5.6.7.8/32') && x.outbound === 'direct'), 'custom direct')
ok(rr.findIndex((x: any) => x.process_path_regex) < rr.findIndex((x: any) => x.domain_suffix?.includes('rutracker.org')), 'explicit apps before destination rules')
ok(rr.findIndex((x: any) => x.ip_is_private) < rr.findIndex((x: any) => x.outbound === T), 'private first')
ok(rr.some((x: any) => x.process_path?.[0] === 'C:\F\f.exe' && x.outbound === 'direct'), 'self direct')
ok(!rr.some((x: any) => x.domain_suffix?.includes('ru')), 'ruDirect skipped when rest is direct')
ok(c.dns.rules.some((x: any) => x.domain_suffix?.includes('telegram.org') && x.server === 'dns-' + q2.id), 'preset dns via server 2')
eq(c.dns.final, 'local', 'dns local')
eq(c.dns.servers.find((x: any) => x.tag === 'dns-' + p.id), { type: 'udp', server: '1.1.1.1', server_port: 53, tag: 'dns-' + p.id, detour: T }, 'imported WireGuard DNS is UDP through its tunnel')
const privateDns = parseConf(CONF.replace('DNS = 1.1.1.1, 1.0.0.1', 'DNS = 10.0.0.53'), 'Private DNS')
const privateDnsConfig: any = buildConfig([privateDns], { ...S, rest: privateDns.id, routes: [] }, { api: { port: 19001, secret: 's' } })
eq(privateDnsConfig.dns.servers.find((x: any) => x.tag === 'dns-' + privateDns.id)?.server, '10.0.0.53', 'private/team resolver is preserved')
const e1 = c.endpoints.find((x: any) => x.tag === T)
eq(e1.h1, '1020325451-1020325500', 'endpoint h1 range string')
eq(e1.h2, 3288052141, 'endpoint h2 number')
eq(e1.mtu, 1376, 'endpoint mtu')
eq(e1.peers[0].pre_shared_key, PUB, 'psk')
eq(c.inbounds[0].strict_route, false, 'never strict route')

const VU = '11111111-2222-3333-4444-555555555555', VK = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3-5cwBM'
const vx = parseVless(`vless://${VU}@9.9.9.9:443?type=xhttp&security=reality&pbk=${VK}&sid=0123abcd&fp=firefox&sni=www.apple.com&path=%2Fxh&mode=stream-one#X`)
const vt = parseVless(`vless://${VU}@8.8.4.4:8443?type=tcp&security=reality&pbk=${VK}&fp=chrome&sni=www.apple.com&flow=xtls-rprx-vision#T`)
const SV: Settings = { ...S, rest: vx.id, routes: [
  { id: 'v1', kind: 'custom', name: 'a.com', value: 'a.com', via: vx.id, on: true },
  { id: 'v2', kind: 'custom', name: 'b.com', value: 'b.com', via: vt.id, on: true },
  { id: 'v3', kind: 'custom', name: 'c.com', value: 'c.com', via: p.id, on: true }
] }
const cv: any = buildConfig([p, vx, vt], SV, { api: { port: 19001, secret: 's' } })
eq(cv.endpoints.map((x: any) => x.tag), [tagOf(p.id)], 'awg stays an endpoint')
eq(cv.outbounds.map((x: any) => x.tag), ['direct', tagOf(vx.id), tagOf(vt.id)], 'vless go to outbounds')
const ox = cv.outbounds[1], ot = cv.outbounds[2]
eq([ox.type, ox.server, ox.server_port, ox.uuid], ['vless', '9.9.9.9', 443, VU], 'reality+xhttp outbound')
eq(ox.tls, { enabled: true, server_name: 'www.apple.com', utls: { enabled: true, fingerprint: 'firefox' }, reality: { enabled: true, public_key: VK, short_id: '0123abcd' } }, 'reality+xhttp tls')
eq(ox.transport, { type: 'xhttp', mode: 'stream-one', path: '/xh' }, 'reality+xhttp transport')
eq([ot.flow, ot.transport, ot.tls.utls.fingerprint, ot.tls.reality.short_id], ['xtls-rprx-vision', undefined, 'chrome', ''], 'reality+tcp outbound')
eq(cv.route.final, tagOf(vx.id), 'rest via vless')
ok(cv.route.rules.some((x: any) => x.domain_suffix?.includes('b.com') && x.outbound === tagOf(vt.id)), 'route via vless profile id')
ok(cv.route.rules.some((x: any) => x.domain_suffix?.includes('c.com') && x.outbound === tagOf(p.id)), 'route via awg unchanged next to vless')
ok(cv.dns.servers.some((x: any) => x.tag === 'dns-' + vx.id && x.detour === tagOf(vx.id)), 'dns detour through vless outbound')
eq(cv.dns.final, 'dns-' + vx.id, 'dns final follows rest')
const cd: any = buildConfig([p, vx], { ...SV, rest: 'direct', routes: [] }, { api: { port: 1, secret: 's' } })
eq([cd.endpoints.length, cd.outbounds.length], [0, 1], 'unused profiles are not built')
eq(conflicts([vx, p], [{ name: 'Wintun', desc: 'x', ipv4: ['10.8.0.7'], fullRoute: false }]).map(x => x.level), ['warn'], 'address clue warns without globally blocking unrelated vless')
eq(conflicts([vx], [{ name: 'Ethernet', desc: 'Realtek', ipv4: ['10.8.0.7'], fullRoute: false }]), [], 'guard with only vless')
const logSecrets = vlessSecrets(vx)
const leaked = redactVless(redact('err uuid ' + VU + ' pbk ' + VK + ' sid 0123abcd key ' + PK), logSecrets)
ok(!leaked.includes(VU) && !leaked.includes(VK) && !leaked.includes('0123abcd') && !leaked.includes(PK), 'redact hides uuid/pbk/sid/awg key together: ' + leaked)

const e: any = buildConfig([p, q2], { ...S, rest: p.id }, { api: { port: 1, secret: 's' } })
eq(e.route.final, T, 'rest server 1 -> final')
ok(e.route.rules.some((x: any) => x.domain_suffix?.includes('ru') && x.outbound === 'direct'), 'ruDirect when rest is server')
eq(e.dns.final, 'dns-' + p.id, 'dns final via rest server')
const gone: any = buildConfig([p], S, { api: { port: 1, secret: 's' } })
ok(gone.route.rules.some((x: any) => x.process_path?.[0] === 'C:\Y\n.exe' && x.action === 'reject' && !x.outbound), 'C03: missing server -> blocked (reject), never direct')
const revoked = { ...p, revoked: true }
const blocked: any = buildConfig([revoked, q2], S, { api: { port: 1, secret: 's' } })
ok(!blocked.endpoints.some((x: any) => x.tag === T), 'revoked tunnel is not started')
ok(blocked.route.rules.some((x: any) => x.domain_suffix?.includes('rutracker.org') && x.action === 'reject'), 'revoked tunnel route is blocked')
eq(usedProfiles(S, [revoked, q2]).map(x => x.id), [q2.id], 'revoked tunnel excluded from active profiles')
const blockedGlobal: any = buildConfig([revoked], { ...S, rest: p.id, routes: [] }, { api: { port: 1, secret: 's' } })
ok(blockedGlobal.route.rules.some((x: any) => x.action === 'reject' && x.network?.includes('tcp')), 'revoked global tunnel rejects traffic')
eq(usedProfiles({ ...S, routes: [] }, [p, q2]).length, 0, 'nothing used')

const ad = [
  { name: 'AmneziaVPN', desc: 'WireGuard Tunnel', ipv4: ['10.8.0.7'], fullRoute: true },
  { name: 'Ethernet 2', desc: 'Realtek Gaming 2.5GbE', ipv4: ['192.168.1.5'], fullRoute: false }
]
eq(conflicts([p], ad).map(x => x.level), ['warn'], 'same address is a warning, not proof of credential ownership')
eq(conflicts([p], [{ ...ad[0], ipv4: ['10.8.0.2'] }, ad[1]]).map(x => x.level), ['block'], 'other full vpn -> block')
eq(conflicts([p], [{ ...ad[0], ipv4: ['10.8.0.2'] }, ad[1]], 'Waarp', true).map(x => x.level), ['warn'], 'other full vpn may be an underlay for app-only routes')
eq(conflicts([p], [{ ...ad[0], ipv4: ['10.8.0.2'], fullRoute: false }]).map(x => x.level), ['info'], 'other split vpn -> info')
eq(conflicts([p], [ad[1]]).length, 0, 'plain lan -> nothing')
eq(conflicts([p], [{ name: 'Waarp', desc: 'sing-tun', ipv4: ['10.8.0.7'], fullRoute: true }]).length, 0, 'own adapter ignored')

;(async () => {
  const { startBridge } = await import('../src/main/bridge')
  const { connect } = await import('node:net')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'fbr-'))
  const { Discovery } = await import('../src/main/discovery')
  writeFileSync(join(dir, 'one.conf'), CONF)
  writeFileSync(join(dir, 'copy.conf'), CONF)
  writeFileSync(join(dir, 'oversize.conf'), CONF + 'x'.repeat(1024 * 1024))
  const discover = new Discovery()
  const found = await discover.scan([{ path: dir, label: 'Fixture' }])
  eq(found.length, 1, 'discovery deduplicates synthetic AWG files')
  ok(!found.some(x => x.source.includes('oversize')), 'discovery ignores oversized files')
  ok(!JSON.stringify(found).includes(PK) && !!discover.profile(found[0]?.id), 'discovery preview omits private key while main retains candidate')
  const { RuntimeJournal } = await import('../src/main/runtime-journal')
  const journal = new RuntimeJournal(dir, 'F:\\fake\\sing-box.exe', 'run.json')
  eq(await journal.recover(), true, 'runtime recovery without a lease leaves all processes alone')
  writeFileSync(join(dir, 'run.json.owner'), JSON.stringify({ version: 1, runId: 'bad', pid: 42, path: 'F:\\fake\\sing-box.exe', started: '2026-01-01T00:00:00Z' }))
  eq(await journal.recover(), false, 'runtime recovery rejects an unowned or malformed lease')
  const srv = startBridge(dir, { version: 't', status: () => ({ phase: 'off' }) }, '\\\\.\\pipe\\waarp-test-' + process.pid)
  const info = JSON.parse(readFileSync(join(dir, 'bridge.json'), 'utf8'))
  const call = (o: object) => new Promise<any>(res => { const c = connect(info.pipe, () => c.write(JSON.stringify(o) + '\n')); c.setEncoding('utf8'); c.on('data', d => { res(JSON.parse(String(d))); c.end() }) })
  await new Promise(r => setTimeout(r, 100))
  eq((await call({ id: 1, method: 'hello' })).error, 'unauthorized', 'bridge needs token')
  eq((await call({ id: 2, token: info.token, method: 'hello' })).result.api, 1, 'bridge hello')
  eq((await call({ id: 3, token: info.token, method: 'status' })).result.phase, 'off', 'bridge status')
  eq((await call({ id: 4, token: info.token, method: 'routes.ensure' })).error, 'not_implemented', 'bridge planned')
  srv.close()
  rmSync(dir, { recursive: true, force: true })
  console.log(fails ? `${fails}/${n} FAILED` : `all ${n} checks passed`)
process.exit(fails ? 1 : 0)
})()
