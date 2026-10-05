import { buildConfig, tagOf } from '../src/main/awg'
import { looksLikeOpenVpn, parseOpenVpn } from '../src/main/openvpn'
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

const settings: Settings = { rest: p.id, groups: [], routes: [], ruDirect: false, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: false }
const cfg: any = buildConfig([p], settings, { api: { port: 19001, secret: 'x' } })
ok(cfg.endpoints[0].type === 'openvpn-client' && cfg.endpoints[0].tag === tagOf(p.id), 'OpenVPN is an endpoint')
ok(!cfg.outbounds.some((x: any) => x.tag === tagOf(p.id)), 'OpenVPN is not misrepresented as an outbound')

console.log(`openvpn.check: ${n} checks`)
