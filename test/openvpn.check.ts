import { buildConfig, tagOf } from '../src/main/awg'
import { looksLikeOpenVpn, openVpnSecrets, parseOpenVpn } from '../src/main/openvpn'
import type { Settings } from '../src/shared/types'

let n = 0
const ok = (v: unknown, m: string) => { if (!v) throw new Error(m); n++ }
const throws = (fn: () => unknown, m: string) => { try { fn(); throw new Error(m) } catch (e) { if (e instanceof Error && e.message === m) throw e; n++ } }
const CA = '-----BEGIN CERTIFICATE-----\nsynthetic-test-only\n-----END CERTIFICATE-----'
const BASE = `client
dev tun
proto udp
remote 198.51.100.10 1194
remote vpn.example.test 443 tcp-client
remote-cert-tls server
data-ciphers AES-256-GCM:AES-128-GCM
cipher AES-256-CBC
auth SHA256
<ca>
${CA}
</ca>`

ok(looksLikeOpenVpn(BASE), 'recognizes ovpn')
const p = parseOpenVpn(BASE, 'Test')
ok(p.kind === 'openvpn' && p.host === '198.51.100.10' && p.port === 1194, 'profile identity')
ok(Array.isArray(p.endpoint.servers) && (p.endpoint.servers as unknown[]).length === 2, 'multiple remotes preserved')
ok((p.endpoint.tls as any).remote_certificate_tls === 'server', 'server certificate purpose preserved')
ok((p.endpoint.data_ciphers as string[]).length === 2 && p.endpoint.data_ciphers_fallback === 'AES-256-CBC', 'ciphers preserved')
throws(() => parseOpenVpn(BASE + '\nscript-security 2\nup evil.cmd'), 'scripts rejected')
throws(() => parseOpenVpn(BASE.replace(`<ca>\n${CA}\n</ca>`, 'ca secret.pem')), 'external CA rejected')
throws(() => parseOpenVpn(BASE.replace(`<ca>\n${CA}\n</ca>`, '')), 'missing CA rejected')
throws(() => parseOpenVpn(BASE + '\nauth-user-pass passwords.txt'), 'external credentials rejected')
const single = BASE.replace('proto udp\n', '').replace('remote 198.51.100.10 1194\n', '')
ok(parseOpenVpn(single).endpoint.network === 'tcp', 'single remote TCP override survives root endpoint conversion')
ok(parseOpenVpn(single.replace('tcp-client', 'tcp6-client')).endpoint.network === 'tcp6', 'explicit OpenVPN IP family survives import')
throws(() => parseOpenVpn(single.replace('tcp-client', 'broken')), 'unknown remote protocol cannot silently become UDP')
throws(() => parseOpenVpn(BASE.replace('proto udp', 'proto tcp-server')), 'server protocol cannot silently become client TCP')
throws(() => parseOpenVpn(BASE.replace('dev tun', 'dev tap')), 'Ethernet TAP cannot silently become TUN')
throws(() => parseOpenVpn(BASE + '\n--tls-verify verify.cmd'), 'leading-dash verification script is rejected instead of being ignored')
throws(() => parseOpenVpn(BASE + '\ncrl-verify revoked.pem'), 'unsupported revocation check cannot silently disappear')
throws(() => parseOpenVpn(BASE + '\nhttp-proxy proxy.example.test 3128'), 'unsupported proxy cannot silently become a direct dial')
throws(() => parseOpenVpn(BASE + '\n<connection>\nremote other.example.test 443\n</connection>'), 'unsupported connection block is named instead of being discarded')
ok(looksLikeOpenVpn(BASE.replace(/^client/, '--client').replace(/^remote/gm, '--remote')), 'leading-dash OpenVPN file is detected')
const wrapped = BASE + '\n<tls-auth>\nsynthetic-control-key\n</tls-auth>'
ok((parseOpenVpn(wrapped).endpoint.tls as any).control_wrap.direction === undefined, 'directionless tls-auth stays bidirectional')
ok((parseOpenVpn(wrapped + '\nkey-direction 0').endpoint.tls as any).control_wrap.direction === 'server', 'explicit tls-auth server direction is preserved')
ok((parseOpenVpn(wrapped + '\ntls-auth [inline] 1').endpoint.tls as any).control_wrap.direction === 'client', 'inline tls-auth positional direction is preserved')
throws(() => parseOpenVpn(wrapped + '\nkey-direction 2'), 'invalid tls-auth direction rejected')
throws(() => parseOpenVpn(wrapped + '\n<tls-crypt>\nother-key\n</tls-crypt>'), 'conflicting control protection cannot silently overwrite another key')
ok((parseOpenVpn(BASE + '\n<tls-crypt-v2>\nsynthetic-v2-key\n</tls-crypt-v2>').endpoint.tls as any).control_wrap.type === 'tls_crypt_v2', 'tls-crypt-v2 is mapped to the pinned core format')
const credentials = parseOpenVpn(BASE + '\n<auth-user-pass>\n spaced user \n spaced password \n</auth-user-pass>')
ok(credentials.endpoint.username === ' spaced user ' && credentials.endpoint.password === ' spaced password ', 'inline credentials retain meaningful whitespace')
throws(() => parseOpenVpn(BASE + '\n<auth-user-pass>\nusername-only\n</auth-user-pass>'), 'malformed inline credentials fail before connecting anonymously')
const verify = parseOpenVpn(BASE + '\nverify-x509-name "CN=Expected Server"')
ok((verify.endpoint.tls as any).server_name === 'CN=Expected Server' && (verify.endpoint.tls as any).server_name_type === 'subject', 'OpenVPN default subject verification is preserved')
ok((parseOpenVpn(BASE + '\nverify-x509-name Server- name-prefix').endpoint.tls as any).server_name_type === 'name-prefix', 'certificate name-prefix remains a prefix check')
const fingerprint = 'AA:'.repeat(31) + 'AA'
const pinned = parseOpenVpn(BASE.replace(`<ca>\n${CA}\n</ca>`, `peer-fingerprint ${fingerprint}`))
ok((pinned.endpoint.tls as any).peer_fingerprint[0] === 'aa'.repeat(32), 'explicit certificate pin can replace an embedded CA')
throws(() => parseOpenVpn(BASE + '\npeer-fingerprint broken'), 'malformed certificate pin is not ignored')
ok(parseOpenVpn(BASE + '\ndata-ciphers-fallback AES-128-CBC').endpoint.data_ciphers_fallback === 'AES-128-CBC', 'explicit fallback cipher takes precedence over the legacy cipher')
ok(parseOpenVpn(BASE + '\ncomp-lzo no\nallow-compression no').endpoint.allow_compression === 'no', 'explicit compression prohibition is preserved')
const privateProfile = parseOpenVpn(wrapped + '\n<cert>\nsynthetic-cert\n</cert>\n<key>\n-----BEGIN PRIVATE KEY-----\nsynthetic-private-key-line\n-----END PRIVATE KEY-----\n</key>')
ok(openVpnSecrets(privateProfile).includes('synthetic-private-key-line') && openVpnSecrets(privateProfile).includes('synthetic-control-key'), 'inline key arrays and individual log lines are included in redaction')

const settings: Settings = { rest: p.id, groups: [], routes: [], ruDirect: false, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: false }
const cfg: any = buildConfig([p], settings, { api: { port: 19001, secret: 'x' } })
ok(cfg.endpoints[0].type === 'openvpn-client' && cfg.endpoints[0].tag === tagOf(p.id), 'OpenVPN is an endpoint')
ok(!cfg.outbounds.some((x: any) => x.tag === tagOf(p.id)), 'OpenVPN is not misrepresented as an outbound')

console.log(`openvpn.check: ${n} checks`)
