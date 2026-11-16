import { outSecrets, parseAny, parseLink } from '../src/main/links'
import { subscriptionCredentialKey, subscriptionEntryKey } from '../src/main/subscription'
let n = 0, bad = 0
const ok = (c: unknown, m: string) => { n++; if (!c) { bad++; console.log('FAIL', m) } }
const b = (s: string) => Buffer.from(s).toString('base64')
const rejected = (link: string, message: string) => { let failed = false; try { parseLink(link) } catch { failed = true }; ok(failed, message) }
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
const withObfsSecret = parseLink('hy2://secret@203.0.113.9:443?obfs=salamander&obfs-password=synthetic-obfs-secret')
ok(withObfsSecret?.kind === 'out' && outSecrets(withObfsSecret).includes('synthetic-obfs-secret'), 'nested obfuscation password is included in log redaction')
ok((parseLink('hysteria2://user:p%40ss%3Aword@203.0.113.9:443') as any).outbound.password === 'user:p@ss:word', 'Hysteria2 userpass preserves both auth parts and percent escapes')
ok((parseLink('hy2://user%3Ap%40ss@203.0.113.9:443') as any).outbound.password === 'user:p@ss', 'Hysteria2 encoded auth is decoded exactly once')
ok((parseLink('hy2://user:@203.0.113.9:443') as any).outbound.password === 'user:', 'Hysteria2 explicit empty userpass suffix is preserved')
const tu = parseLink('tuic://11111111-2222-3333-4444-555555555555:pw@203.0.113.10:443?congestion_control=cubic&alpn=h3&sni=u.example.com#TU') as any
ok(tu?.outbound.type === 'tuic' && tu.outbound.congestion_control === 'cubic' && tu.outbound.tls.alpn[0] === 'h3', 'tuic')
ok(parseLink('http://x') === null, 'unknown scheme -> null')
const upgrade = parseLink('trojan://p@203.0.113.6:443?type=httpupgrade&host=cdn.example.test&path=%2Fupgrade') as any
ok(upgrade.outbound.transport.type === 'httpupgrade' && upgrade.outbound.transport.host === 'cdn.example.test' && upgrade.outbound.transport.path === '/upgrade', 'HTTPUpgrade stays HTTPUpgrade instead of becoming TCP')
rejected('trojan://p@203.0.113.6:443?type=kcp', 'unsupported Trojan transport cannot silently become TCP')
rejected('trojan://p@203.0.113.6:443?security=reality', 'Trojan REALITY cannot silently become ordinary TLS')
rejected('trojan://p@203.0.113.6:443?type=tcp&headerType=http', 'unsupported transport header cannot silently disappear')
rejected('trojan://p@203.0.113.6:443?allowInsecure=0&insecure=TRUE', 'one safe flag cannot conceal another insecure TLS flag')
rejected('hy2://p@203.0.113.6:443?pinSHA256=deadbeef', 'certificate pin is rejected until supported, never dropped')
rejected('hy2://p@203.0.113.6:443?obfs=salamander', 'incomplete obfuscation is rejected before the core starts')
const vmBase = { add: '203.0.113.5', port: 443, id: '11111111-2222-3333-4444-555555555555', net: 'tcp', tls: 'tls' }
const vmLink = (patch: object) => 'vmess://' + b(JSON.stringify({ ...vmBase, ...patch }))
rejected(vmLink({ net: 'kcp' }), 'unsupported VMess transport cannot silently become TCP')
rejected(vmLink({ tls: 'reality' }), 'unsupported VMess security cannot silently disable TLS')
rejected(vmLink({ allowInsecure: true }), 'VMess insecure TLS flag follows the same validation as URI protocols')
rejected(vmLink({ aid: 'broken' }), 'invalid VMess alterId cannot silently become zero')
const vmTls = (parseLink(vmLink({ fp: 'chrome', alpn: 'h2,http/1.1' })) as any).outbound.tls
ok(vmTls.utls.fingerprint === 'chrome' && vmTls.alpn.join(',') === 'h2,http/1.1', 'VMess TLS fingerprint and ALPN survive import')
const mixed = parseAny(b(['trojan://p@203.0.113.6:443#a', 'garbage', 'ss://' + b('aes-128-gcm:x') + '@203.0.113.7:1#b', 'trojan://@bad'].join('\n')))
ok(mixed.items.length === 2 && mixed.skipped === 2, 'mixed base64 list: 2 ok, 2 skipped')
const truncated = parseAny('trojan://p@203.0.113.6:443#a\n\ntrojan://q@203.0.113.7:443#b', 2)
ok(truncated.items.length === 1 && truncated.skipped === 1, 'bounded parser reports a trailing profile instead of accepting it as a single-profile replacement')
ok(parseAny('trojan://p@203.0.113.6:443', 0).items.length === 0, 'zero import limit returns no profile')
let threw = false; try { parseLink('trojan://p@203.0.113.6:99999') } catch { threw = true }
ok(threw, 'bad port rejected')
threw = false; try { parseLink('trojan://p@203.0.113.6:443?allowInsecure=1') } catch { threw = true }
ok(threw, 'TLS certificate verification cannot be disabled silently')
threw = false; try { parseLink('tuic://11111111-2222-3333-4444-555555555555:p@203.0.113.6:443?fp=made-up') } catch { threw = true }
ok(threw, 'unknown TLS fingerprint rejected')
threw = false; try { parseLink('ss://' + b('aes-256-gcm:pw') + '@203.0.113.7:8388?plugin=obfs-local') } catch { threw = true }
ok(threw, 'unsupported Shadowsocks plugin rejected instead of ignored')
rejected('ss://' + b('aes-256-gcm:pw') + '@203.0.113.7:8388?%70lugin=obfs-local', 'encoded Shadowsocks plugin name cannot bypass validation')
rejected('ss://' + b('missing-separator') + '@203.0.113.7:8388', 'Shadowsocks credentials need a real method/password separator')
threw = false; try { parseLink('hy2://@203.0.113.7:443') } catch { threw = true }
ok(threw, 'Hysteria2 without a credential rejected')
threw = false; try { parseLink('vmess://' + b(JSON.stringify({ add: '203.0.113.5', port: 443, id: 'not-a-uuid' }))) } catch { threw = true }
ok(threw, 'VMess credential shape validated')
console.log(bad ? `${bad}/${n} FAILED` : `all ${n} link checks passed`)
if (bad) process.exit(1)
