import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig, checkConfig, ConfError, detectVersion, endpoint, parseConf, redact, tagOf } from '../src/main/awg'
import { DEFAULTS, normalizeProfile } from '../src/main/store-core'
import type { AwgProfile, Profile } from '../src/shared/types'

// Synthetic keys and documentation-only addresses. No user configuration belongs in this fixture.
const key = Buffer.alloc(32, 0x11).toString('base64')
const peerKey = Buffer.alloc(32, 0x22).toString('base64')
const conf = `[Interface]
PrivateKey = ${key}
Address = 10.66.0.2/32
Address = fd00::2
DNS = 10.66.0.1
DNS = 1.1.1.1
ListenPort = 0
Jc = 4
Jmin = 40
Jmax = 200
S1 = 80
S2 = 20
S3 = 35
S4 = 12
H1 = 1000 - 2000
H2 = 3000-4000
H3 = 5000
H4 = 6000-7000
I1 = <b 0xAbCd><r 32>
I2 = <rc 10><rd 5><t>
I3 = <d><ds><dz 2>
I4 = <r 0>
I5 = <b 0x00>
[Peer]
PublicKey = ${peerKey}
AllowedIPs = 10.66.0.0/16
AllowedIPs = 192.0.2.7, 2001:db8::/48
Endpoint = vpn.example:51820 # export comment
PersistentKeepalive = 25
`

let total = 0, failed = 0
const ok = (pass: unknown, label: string) => { total++; if (!pass) { failed++; console.error('FAIL', label) } }
const eq = (a: unknown, b: unknown, label: string) => ok(JSON.stringify(a) === JSON.stringify(b), label)
const rejects = (input: string, field: string, label: string) => {
  try { parseConf(input); ok(false, label) } catch (e) { ok(e instanceof ConfError && e.message.includes(field), label) }
}
const storedRejects = (p: unknown, label: string) => {
  try { normalizeProfile(p as Profile); ok(false, label) } catch { ok(true, label) }
}

const p = parseConf(conf)
eq(p.address, ['10.66.0.2/32', 'fd00::2/128'], 'repeated Address preserves both families')
eq(p.dns, ['10.66.0.1', '1.1.1.1'], 'repeated DNS preserves order')
eq(p.peer.allowedIPs, ['10.66.0.0/16', '192.0.2.7/32', '2001:db8::/48'], 'AllowedIPs preserves restricted routes and expands bare hosts only')
eq(p.peer.host, 'vpn.example', 'inline export comments excluded from endpoint')
eq(p.awg, { jc: 4, jmin: 40, jmax: 200, s1: 80, s2: 20, s3: 35, s4: 12, h1: '1000-2000', h2: '3000-4000', h3: '5000', h4: '6000-7000', i1: '<b 0xAbCd><r 32>', i2: '<rc 10><rd 5><t>', i3: '<d><ds><dz 2>', i4: '<r 0>', i5: '<b 0x00>' }, 'all AWG2 fields survive import with only numeric range canonicalization')
const ep: any = endpoint(p)
eq(ep.peers[0].allowed_ips, p.peer.allowedIPs, 'runtime endpoint does not expand AllowedIPs to default routes')
eq(ep.h1, '1000-2000', 'ranged header remains a string')
eq(ep.h3, 5000, 'single header becomes the engine numeric representation')
eq(ep.i1, '<b 0xAbCd><r 32>', 'CPS packet remains a case-sensitive string')
eq(ep.listen_port, 0, 'explicit ephemeral ListenPort preserved')
eq(endpoint(parseConf(conf.replace('ListenPort = 0', 'ListenPort = 51825'))).listen_port, 51825, 'nonzero ListenPort preserved')
eq(ep.peers[0].persistent_keepalive_interval, 25, 'explicit keepalive preserved')
eq((endpoint(parseConf(conf.replace('PersistentKeepalive = 25\n', ''))) as any).peers[0].persistent_keepalive_interval, 0, 'omitted keepalive uses WireGuard disabled default')
eq((endpoint(parseConf(conf.replace('PersistentKeepalive = 25', 'PersistentKeepalive = off'))) as any).peers[0].persistent_keepalive_interval, 0, 'WireGuard off keepalive accepted')
eq(parseConf(conf.replace('vpn.example:51820', '[2001:db8::7]:51820')).peer.host, '2001:db8::7', 'bracketed IPv6 endpoint accepted')
eq(parseConf(conf.replace('vpn.example:51820', 'пример.рф:51820')).peer.host, 'xn--e1afmkfd.xn--p1ai', 'IDN endpoint converted to DNS ASCII')
eq(detectVersion({ i5: '<r 1>' }), 'AmneziaWG 2', 'I5 alone identifies AWG2')
eq(detectVersion({ h4: '100' }), 'AmneziaWG 1', 'H4 alone identifies AWG1')
eq(parseConf(conf.replace('H3 = 5000', 'H3 = 4294967295')).awg.h3, '4294967295', 'maximum unsigned header accepted without precision loss')

for (const [from, to, field] of [
  ['Jc = 4', 'Jc = -1', 'JC'], ['Jc = 4', 'Jc = 1.5', 'JC'], ['Jc = 4', 'Jc = 4294967296', 'JC'],
  ['Jc = 4', 'Jc = 0x10', 'JC'], ['Jmin = 40', 'Jmin = 201', 'Jmin'],
  ['S4 = 12', 'S4 = 65536', 'S4'], ['H1 = 1000 - 2000', 'H1 = 2000-1000', 'H1'],
  ['H1 = 1000 - 2000', 'H1 = 4294967296', 'H1'], ['H2 = 3000-4000', 'H2 = 2000-4000', 'H1'],
  ['I1 = <b 0xAbCd><r 32>', 'I1 = <b 0xABC>', 'I1'], ['I4 = <r 0>', 'I4 = <r -1>', 'I4'],
  ['I4 = <r 0>', 'I4 = <r 2017>', 'I4'], ['I4 = <r 0>', 'I4 = <R 12>', 'I4'],
  ['I4 = <r 0>', 'I4 = <r 12', 'I4'], ['I4 = <r 0>', 'I4 = 123', 'I4'],
  ['ListenPort = 0', 'ListenPort = 65536', 'ListenPort'], ['PersistentKeepalive = 25', 'PersistentKeepalive = 2.5', 'PersistentKeepalive'],
  ['Address = 10.66.0.2/32', 'Address = 10.66.0.2/32/7', 'Address'],
  ['Address = fd00::2', 'Address = fe80::2%eth0/128', 'Address'],
  ['AllowedIPs = 10.66.0.0/16', 'AllowedIPs = 10.66.0.0/33', 'AllowedIPs'],
  ['vpn.example:51820', '2001:db8::1:51820', 'Endpoint'], ['vpn.example:51820', '[vpn.example]:51820', 'Endpoint'],
  ['vpn.example:51820', 'vpn.example:0', 'Endpoint'], ['vpn.example:51820', 'bad_host.example:51820', 'Endpoint']
]) rejects(conf.replace(from, to), field, `reject incompatible ${to.split('=')[0].trim()} input`)

rejects(conf.replace(/^AllowedIPs = .*\n/gm, ''), 'AllowedIPs', 'missing AllowedIPs fails import instead of inventing unrestricted routes')
rejects(conf.replace(/^AllowedIPs = .*\n/gm, 'AllowedIPs =\n'), 'AllowedIPs', 'empty AllowedIPs rejected before unsupported endpoint creation')
rejects(conf.replace('Jc = 4', 'Jc = 4\nJc = 5'), 'Jc', 'conflicting scalar duplicates rejected')
rejects(conf + '\n[Interface]\nAddress = 10.99.0.1/32\n', '[Interface]', 'second Interface rejected instead of silently dropping it')
rejects(conf.replace('Jc = 4', 'HeaderProtectionKey = do-not-echo-this'), 'HeaderProtectionKey', 'malformed AWG3 header protection key rejected instead of silently weakening config')
try { parseConf(conf.replace('Jc = 4', 'HeaderProtectionKey = do-not-echo-this')); ok(false, 'unknown field error excludes its secret value') }
catch (e) { ok(e instanceof Error && !e.message.includes('do-not-echo-this'), 'unknown field error excludes its secret value') }

const ipv4 = parseConf(conf.replace(/^AllowedIPs = .*\n/gm, '').replace('[Peer]', '[Peer]\nAllowedIPs = 0.0.0.0/0'))
const built: any = buildConfig([ipv4], { ...DEFAULTS, rest: ipv4.id, lanDirect: false, ruDirect: false }, { api: { port: 19001, secret: 'synthetic-api-secret' } })
eq(built.endpoints[0].peers[0].allowed_ips, ['0.0.0.0/0'], 'IPv4-only config stays IPv4-only even with IPv6 interface address')
ok(built.route.rules.some((r: any) => r.ip_version === 6 && r.action === 'reject'), 'IPv6 cannot escape a path without IPv6 AllowedIPs')
const cc: any = checkConfig([ipv4, { ...p, revoked: true }], { port: 19001, secret: 'synthetic-api-secret' })
eq(cc.route.default_domain_resolver, 'local', 'checker endpoint DNS bootstrap is explicit')
eq(cc.dns, { servers: [{ type: 'local', tag: 'local' }], final: 'local', strategy: 'ipv4_only' }, 'checker target DNS policy matches main IPv4 policy')
eq(cc.endpoints.map((e: any) => [e.tag, e.system, e.peers[0].allowed_ips]), [[tagOf(ipv4.id), false, ['0.0.0.0/0']]], 'checker excludes revoked profiles, preserves routes and needs no system TUN')
ok(!cc.inbounds, 'checker does not take over system traffic')

const legacy: AwgProfile = { ...p, peer: { ...p.peer } }
delete legacy.peer.allowedIPs
eq((endpoint(legacy) as any).peers[0].allowed_ips, ['0.0.0.0/0', '::/0'], 'only old saves retain the historical default route interpretation')
ok(normalizeProfile(legacy) === legacy, 'legacy absent AllowedIPs still loads')
ok(normalizeProfile(p) === p, 'new valid stored profile loads')
for (const allowedIPs of [null, [], '0.0.0.0/0', [42], ['bad/32'], ['::/129'], ['10.0.0.1/32/1'], ['fe80::1%eth0/128']]) {
  storedRejects({ ...p, peer: { ...p.peer, allowedIPs } }, 'invalid saved AllowedIPs rejected without fallback')
}
for (const listenPort of [null, -1, 65536, 1.5, '51820']) storedRejects({ ...p, listenPort }, 'invalid saved ListenPort rejected')

const bomb = 'vpn://' + deflateSync(Buffer.from(JSON.stringify({ config: conf, padding: 'x'.repeat(1024 * 1024) }))).toString('base64')
rejects(bomb, 'vpn://', 'compressed oversized import rejected before expansion can exhaust memory')
rejects(conf + '#'.repeat(1024 * 1024), 'большой', 'plain oversized import rejected')
let nested: unknown = { config: conf }
for (let i = 0; i < 40; i++) nested = { child: nested }
rejects('vpn://' + Buffer.from(JSON.stringify(nested)).toString('base64'), 'конфига', 'deeply nested shared key rejected without stack overflow')

// ---- E4 AmneziaWG 3.x client fields
{
  const hpk = Buffer.alloc(32, 0x33).toString('base64')
  const v3 = (extra: string) => `[Interface]\nPrivateKey = ${key}\nAddress = 10.8.0.9/32\nJc = 4\nJmin = 10\nJmax = 50\nS1 = 20\nS2 = 30\nS3 = 16\nS4 = 12\nH1 = 100-200\nH2 = 300-400\nH3 = 500-600\nH4 = 700-800\n${extra}\n\n[Peer]\nPublicKey = ${peerKey}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.10:51820\n`
  const p = parseConf(v3(`HeaderProtectionKey = ${hpk}\nRandomTrailers = true\nDisableCookies = 1`))
  ok(p.awg.header_protection_key === hpk && p.awg.random_trailers === true && p.awg.disable_cookies === true, 'AWG 3 fields are read')
  eq(detectVersion(p.awg), 'AmneziaWG 3', 'version label shows AmneziaWG 3')
  const ep = endpoint(p) as Record<string, unknown>
  ok(ep.header_protection_key === hpk && ep.random_trailers === true && ep.disable_cookies === true, 'engine endpoint carries the AWG 3 fields')
  const restored = normalizeProfile(JSON.parse(JSON.stringify(p))) as AwgProfile
  eq(restored.awg, p.awg, 'AWG 3 parameters survive stored-profile reload')
  ok(!redact(`header_protection_key=${hpk}`).includes(hpk), 'AWG 3 header protection key cannot appear in engine logs')
  const disabled = parseConf(v3('RandomTrailers = false\nDisableCookies = 0'))
  ok(disabled.awg.random_trailers === false && disabled.awg.disable_cookies === false, 'explicitly disabled AWG 3 flags survive import')
  const disabledEndpoint = endpoint(disabled) as Record<string, unknown>
  ok(disabledEndpoint.random_trailers === false && disabledEndpoint.disable_cookies === false, 'disabled AWG 3 flags survive endpoint compilation')
  rejects(v3('HeaderProtectionKey ='), 'HeaderProtectionKey', 'an explicit empty header protection key cannot silently disappear')
  rejects(v3(`HeaderProtectionKey = ${Buffer.alloc(32).toString('base64')}`), 'HeaderProtectionKey', 'all-zero header protection key is rejected like the pinned engine')
  let msg = ''
  try { parseConf(v3('HeaderProtectionKey = c2hvcnQ=')) } catch (e) { msg = String((e as Error).message) }
  ok(/32/.test(msg), 'a wrong-length header protection key is refused with a clear reason')
  msg = ''
  try { parseConf(v3(`HeaderProtectionKey = ${hpk}`).replace('S4 = 12', 'S4 = 8')) } catch (e) { msg = String((e as Error).message) }
  ok(/S1–S4/.test(msg), 'header protection with S below 12 is refused')
  msg = ''
  try { parseConf(v3('RandomTrailers = maybe')) } catch (e) { msg = String((e as Error).message) }
  ok(/RandomTrailers/.test(msg), 'a malformed flag is refused')
  msg = ''
  try { parseConf(v3('ContentPaddingAddition = 10-20')) } catch (e) { msg = String((e as Error).message) }
  ok(/contentpaddingaddition/i.test(msg), 'an unsupported AWG 3 field is named, never silently dropped')
  const exe = join(process.cwd(), 'engine', 'sing-box.exe')
  if (process.platform === 'win32' && existsSync(exe)) {
    const dir = mkdtempSync(join(tmpdir(), 'waarp-awg3-'))
    try {
      const file = join(dir, 'c.json')
      writeFileSync(file, JSON.stringify({ log: { level: 'warn' }, endpoints: [{ ...ep, tag: 'p' }] }))
      const r = spawnSync(exe, ['check', '-c', file], { encoding: 'utf8', timeout: 15000 })
      ok(r.status === 0, 'pinned engine accepts the AWG 3 endpoint: ' + String(r.stderr).slice(-300))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } else console.log('[SKIP] pinned AWG 3 engine check requires the verified Windows binary')
}

console.log(`AWG import: ${total - failed}/${total} passed`)
if (failed) process.exitCode = 1
