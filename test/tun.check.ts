// Hardening R1: TUN service-subnet guard, startup readiness budget, controller port choice, read-only preflight.
// Offline: pure config / fake clock / loopback sockets only. No TUN, no Windows network change.
import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildConfig, parseConf } from '../src/main/awg'
import { Engine } from '../src/main/engine'
import { loopbackFree, pickPort, PORT_RANGE, serviceGuardRule, START_BUDGET_MS, TUN, TUN_SUBNETS, tunPreflight, waitReady, type TunSnapshot } from '../src/main/tun'
import { DEFAULTS } from '../src/main/store-core'
import type { Settings } from '../src/shared/types'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const conf = `[Interface]
PrivateKey = gB5c0VMuG6oZ3FqzJHLqX7RCkv4cC4m23OIlriNib0U=
Address = 10.8.0.7/32
[Peer]
PublicKey = q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM=
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.10:51820
`
const p = parseConf(conf, 'A')
const S = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, rest: p.id, routes: [], ...over })

;(async () => {
  // ---- R1.1 guard rule
  eq(serviceGuardRule(), { ip_cidr: ['172.19.77.0/30', 'fdfe:dcba:9876::/126'], action: 'reject' }, 'guard = exactly the /30 + /126 service subnets, reject')
  for (const lanDirect of [true, false]) {
    const c: any = buildConfig([p], S({ lanDirect }), { api: { port: 19001, secret: 's' }, selfExe: 'C:\\W\\Waarp.exe' })
    const rules: any[] = c.route.rules
    const at = (f: (r: any) => boolean) => rules.findIndex(f)
    const hij = at(r => r.action === 'hijack-dns'), guard = at(r => r.action === 'reject' && JSON.stringify(r.ip_cidr) === JSON.stringify(TUN_SUBNETS))
    const priv = at(r => r.ip_is_private === true), self = at(r => Array.isArray(r.process_path) && r.process_path[0] === 'C:\\W\\Waarp.exe')
    ok(hij >= 0 && guard === hij + 1, `lanDirect=${lanDirect}: guard right after DNS hijack`)
    ok(lanDirect ? priv > guard : priv === -1, `lanDirect=${lanDirect}: private/LAN direct comes after the guard`)
    ok(self > guard, `lanDirect=${lanDirect}: the self-exe direct rule comes after the guard`)
    eq(c.inbounds[0].address, [TUN.v4.addr, TUN.v6.addr], 'TUN addresses come from the constants')
    eq(c.inbounds[0].interface_name, TUN.name, 'TUN name from the constant')
    ok(!rules.some(r => r.action === 'reject' && JSON.stringify(r.ip_cidr ?? []).match(/192\.168|10\.0\.0|fc00/)), 'no ordinary LAN range is rejected')
  }

  // ---- R1.2 readiness budget (fake clock)
  let now = 0
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms } }
  eq(START_BUDGET_MS >= 20_000, true, 'budget is at least 20 s (Windows TUN can need ~15 s to fail)')
  eq(await waitReady({ ...clock, probe: async () => now >= 15_000, alive: () => true }), 'ready', 'a core ready at 15 s is not killed at 8 s')
  now = 0; eq(await waitReady({ ...clock, probe: async () => false, alive: () => true }), 'timeout', 'never ready -> one timeout')
  ok(now >= START_BUDGET_MS && now < START_BUDGET_MS + 1000, 'timeout lands at the budget, not earlier: ' + now)
  now = 0; let alive = true
  eq(await waitReady({ ...clock, probe: async () => { if (now >= 3000) alive = false; return false }, alive: () => alive }), 'exited', 'core exit ends the wait at once')
  ok(now < 4000, 'exit noticed without waiting out the budget')
  let probes = 0; now = 0
  await waitReady({ ...clock, probe: async () => { probes++; return false }, alive: () => true })
  ok(probes > 10 && probes < 100, 'controller probes are bounded: ' + probes)

  // ---- R1.3 port
  eq(await pickPort(async () => false), undefined, 'no free candidate -> undefined (nothing spawned)')
  let asked: number[] = []
  const got = await pickPort(async port => { asked.push(port); return asked.length === 3 })
  ok(got === asked[2] && asked.every(x => x >= PORT_RANGE[0] && x <= PORT_RANGE[1]), 'first free candidate in the broad range wins')
  asked = []; await pickPort(async port => { asked.push(port); return false }, 24)
  ok(asked.length <= 24, 'bounded candidates')
  const busy = createServer(); await new Promise<void>(r => busy.listen({ host: '127.0.0.1', port: 0 }, () => r()))
  const bp = (busy.address() as { port: number }).port
  eq(await loopbackFree(bp), false, 'a taken loopback port is detected')
  busy.close()
  const fp = await pickPort()
  ok(typeof fp === 'number' && await loopbackFree(fp!), 'a picked port is free on loopback')

  // ---- R1.4 preflight (pure)
  const snap = (o: Partial<TunSnapshot> = {}): TunSnapshot => ({ adapters: [], addrs: [], routes: [], ...o })
  eq(tunPreflight(snap({ routes: [{ prefix: '0.0.0.0/0', alias: 'Wi-Fi' }, { prefix: '172.19.0.0/16', alias: 'vEthernet' }, { prefix: '192.168.1.0/24', alias: 'Wi-Fi' }, { prefix: '::/0', alias: 'Wi-Fi' }] })), { ok: true }, 'broad / LAN / default routes are not a collision')
  eq(tunPreflight(undefined).ok === false && (tunPreflight(undefined) as any).kind, 'tun_unknown', 'unreadable system state -> refuse (tun_unknown)')
  eq((tunPreflight(snap({ adapters: [{ name: 'Waarp', status: 'Disconnected' }] })) as any).kind, 'tun_stale', 'leftover exact Waarp adapter -> tun_stale')
  eq(tunPreflight(snap({ adapters: [{ name: 'Waarp 2' }, { name: 'WaarpX' }] })), { ok: true }, 'only the exact name counts')
  eq((tunPreflight(snap({ addrs: [{ ip: '172.19.77.2', alias: 'Other VPN' }] })) as any).kind, 'tun_collision', 'an address inside our /30 -> collision')
  eq((tunPreflight(snap({ addrs: [{ ip: 'fdfe:dcba:9876::2', alias: 'Other' }] })) as any).kind, 'tun_collision', 'an address inside our /126 -> collision')
  eq((tunPreflight(snap({ routes: [{ prefix: '172.19.77.0/30', alias: 'Other' }] })) as any).kind, 'tun_collision', 'a route equal to our subnet -> collision')
  eq((tunPreflight(snap({ routes: [{ prefix: '172.19.77.2/32', alias: 'Other' }] })) as any).kind, 'tun_collision', 'a host route inside our subnet -> collision')
  eq(tunPreflight(snap({ addrs: [{ ip: '172.19.77.9' }, { ip: 'fdfe:dcba:9877::1' }, { ip: 'fe80::1%12' }] })), { ok: true }, 'neighbours outside the subnet are fine')
  ok(/Other VPN/.test((tunPreflight(snap({ addrs: [{ ip: '172.19.77.1', alias: 'Other VPN' }] })) as any).text), 'collision text names the occupant')

  // ---- engine: a refused preflight never spawns; a stale adapter is re-checked boundedly after our own stop
  const e = new Engine(process.execPath, mkdtempSync(join(tmpdir(), 'waarp-tun-')), 'C:\\W\\Waarp.exe')
  ;(e as any).recoveryOk = true
  e.preflightGap = 1
  let checks = 0
  e.preflight = async () => { checks++; return { ok: false, kind: 'tun_stale', text: 'stale' } }
  await e.start([p], S())
  eq([e.status.phase, e.status.recovery, e.status.error, checks, !!(e as any).child], ['error', 'tun_stale', 'stale', 3, false], 'stale: 3 bounded checks, refused, nothing spawned')
  checks = 0
  e.preflight = async () => { checks++; return { ok: false, kind: 'tun_collision', text: 'busy' } }
  await e.start([p], S())
  eq([e.status.recovery, checks, !!(e as any).child], ['tun_collision', 1, false], 'collision: refused at once, nothing spawned')

  console.log(`tun.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
