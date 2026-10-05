import { parseVpnGateCsv } from '../src/main/vpngate'

let n = 0
const ok = (v: unknown, m: string) => { if (!v) throw new Error(m); n++ }
const ovpn = `client\nproto udp\nremote 198.51.100.44 1194\n<ca>\ntest-ca\n</ca>`
const row = ['vpn1.example', '198.51.100.44', '1', '10', '1000', 'Japan', 'JP', '2', '3', '4', '5', '', '', '', Buffer.from(ovpn).toString('base64')].join(',')
const found = parseVpnGateCsv(`#HostName,...\n${row}\n*\n`, 10)
ok(found.length === 1, 'one valid VPN Gate row')
ok(found[0].kind === 'openvpn' && found[0].source === 'public', 'public OpenVPN profile')
ok(found[0].name.startsWith('JP ·'), 'country retained in name')
ok(parseVpnGateCsv(row + '\n' + row, 1).length === 1, 'bounded result')
ok(parseVpnGateCsv('bad,row').length === 0, 'bad row skipped')
console.log(`vpngate.check: ${n} checks`)
