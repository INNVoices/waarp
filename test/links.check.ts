import { parseAny, parseLink } from '../src/main/links'
import { subscriptionCredentialKey, subscriptionEntryKey } from '../src/main/subscription'
let n = 0, bad = 0
const ok = (c: unknown, m: string) => { n++; if (!c) { bad++; console.log('FAIL', m) } }
const b = (s: string) => Buffer.from(s).toString('base64')
const vm = parseLink('vmess://' + b(JSON.stringify({ v: '2', ps: 'VM test', add: '203.0.113.5', port: '443', id: '11111111-2222-3333-4444-555555555555', aid: '0', net: 'ws', path: '/x', host: 'cdn.example.com', tls: 'tls', sni: 'cdn.example.com' }))) as any
ok(vm?.kind === 'out' && vm.outbound.type === 'vmess' && vm.outbound.transport?.type === 'ws' && vm.outbound.tls?.server_name === 'cdn.example.com', 'vmess ws tls')
const tr = parseLink('trojan://pass123@203.0.113.6:443?sni=t.example.com&type=grpc&serviceName=gs#Trojan%20one') as any
ok(tr?.outbound.type === 'trojan' && tr.outbound.password === 'pass123' && tr.outbound.transport?.service_name === 'gs' && tr.name === 'Trojan one', 'trojan grpc')
const movedTr = { ...tr, host: '198.51.100.9', outbound: { ...tr.outbound, server: '198.51.100.9' } }
ok(subscriptionEntryKey(tr) === subscriptionEntryKey(movedTr), 'stored subscription entry identity survives endpoint rotation')
ok(subscriptionCredentialKey(tr) === subscriptionCredentialKey({ ...movedTr, name: 'Renamed locally' }), 'legacy subscription identity can recover one uniquely matching renamed profile')
const s1 = parseLink('ss://' + b('aes-256-gcm:pw') + '@203.0.113.7:8388#SS') as any
ok(s1?.outbound.type === 'shadowsocks' && s1.outbound.method === 'aes-256-gcm' && s1.outbound.password === 'pw' && s1.port === 8388, 'ss sip002')
const s2 = parseLink('ss://' + b('chacha20-ietf-poly1305:p@ss@203.0.113.8:443') + '#old') as any
ok(s2?.outbound.method === 'chacha20-ietf-poly1305' && s2.outbound.password === 'p@ss' && s2.host === '203.0.113.8', 'ss legacy')
const h2 = parseLink('hy2://secret@203.0.113.9:8443?sni=h.example.com&obfs=salamander&obfs-password=o#HY') as any
ok(h2?.outbound.type === 'hysteria2' && h2.outbound.password === 'secret' && h2.outbound.obfs?.type === 'salamander', 'hysteria2')
const tu = parseLink('tuic://11111111-2222-3333-4444-555555555555:pw@203.0.113.10:443?congestion_control=cubic&alpn=h3&sni=u.example.com#TU') as any
ok(tu?.outbound.type === 'tuic' && tu.outbound.congestion_control === 'cubic' && tu.outbound.tls.alpn[0] === 'h3', 'tuic')
ok(parseLink('http://x') === null, 'unknown scheme -> null')
const mixed = parseAny(b(['trojan://p@203.0.113.6:443#a', 'garbage', 'ss://' + b('aes-128-gcm:x') + '@203.0.113.7:1#b', 'trojan://@bad'].join('\n')))
ok(mixed.items.length === 2 && mixed.skipped === 2, 'mixed base64 list: 2 ok, 2 skipped')
let threw = false; try { parseLink('trojan://p@203.0.113.6:99999') } catch { threw = true }
ok(threw, 'bad port rejected')
threw = false; try { parseLink('trojan://p@203.0.113.6:443?allowInsecure=1') } catch { threw = true }
ok(threw, 'TLS certificate verification cannot be disabled silently')
threw = false; try { parseLink('tuic://11111111-2222-3333-4444-555555555555:p@203.0.113.6:443?fp=made-up') } catch { threw = true }
ok(threw, 'unknown TLS fingerprint rejected')
threw = false; try { parseLink('ss://' + b('aes-256-gcm:pw') + '@203.0.113.7:8388?plugin=obfs-local') } catch { threw = true }
ok(threw, 'unsupported Shadowsocks plugin rejected instead of ignored')
threw = false; try { parseLink('hy2://@203.0.113.7:443') } catch { threw = true }
ok(threw, 'Hysteria2 without a credential rejected')
threw = false; try { parseLink('vmess://' + b(JSON.stringify({ add: '203.0.113.5', port: 443, id: 'not-a-uuid' }))) } catch { threw = true }
ok(threw, 'VMess credential shape validated')
console.log(bad ? `${bad}/${n} FAILED` : `all ${n} link checks passed`)
if (bad) process.exit(1)
