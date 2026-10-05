// Hardening R4: sleep / resume state machine on a fake clock. No real suspend, no network change.
import { createResume, underlayReady, type ResumeDeps } from '../src/main/resume'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

function rig(o: { on?: boolean; netAt?: number; restartOk?: boolean; restartMs?: number } = {}) {
  let now = 0
  const timers: { at: number; f: () => void; id: number }[] = []
  let id = 0
  const log = { restarts: 0, fails: [] as string[], netChecks: 0, overlap: 0, inRestart: 0 }
  const d: ResumeDeps = {
    isOn: () => o.on ?? true,
    netReady: async () => { log.netChecks++; return now >= (o.netAt ?? 0) },
    restart: async () => {
      log.inRestart++; if (log.inRestart > 1) log.overlap++
      log.restarts++; now += o.restartMs ?? 0
      log.inRestart--
      return o.restartOk ?? true
    },
    fail: async why => { log.fails.push(why) },
    now: () => now,
    sleep: async ms => { now += ms },
    setTimer: (f, ms) => { const t = { at: now + ms, f, id: ++id }; timers.push(t); return t.id },
    clearTimer: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1) },
    settleMs: 2000, budgetMs: 30_000, everyMs: 1000,
  }
  const r = createResume(d)
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift(); now = Math.max(now, t.at); t.f()
      for (let i = 0; i < 50; i++) await Promise.resolve()
    }
    now = Math.max(now, end)
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }
  return { r, log, advance, clock: () => now }
}

;(async () => {
  {
    const { r, log, advance } = rig()
    r.suspend(); r.resume(); await advance(1999)
    eq(log.restarts, 0, 'no restart inside the settle window')
    await advance(10)
    eq([log.restarts, log.fails], [1, []], 'one restart after settle')
  }
  {
    const { r, log, advance } = rig()
    r.suspend(); for (let i = 0; i < 10; i++) { r.resume(); r.suspend(); r.resume() }
    await advance(5000)
    eq(log.restarts, 1, 'a resume storm coalesces into one restart')
  }
  {
    const { r, log, advance } = rig({ on: false })
    r.suspend(); r.resume(); await advance(5000)
    eq(log.restarts, 0, 'tunnel was off before sleep -> stays off')
  }
  {
    const { r, log, advance, clock } = rig({ netAt: 9000 })
    r.suspend(); r.resume(); await advance(20_000)
    eq([log.restarts, log.fails], [1, []], 'waits for the network, then restarts once')
    ok(clock() >= 9000, 'restart only after the network is usable')
  }
  {
    const { r, log, advance } = rig({ netAt: 10 ** 9 })
    r.suspend(); r.resume(); await advance(60_000)
    eq([log.restarts, log.fails], [0, ['no_network']], 'network never back -> no restart, one failure, no loop')
    ok(log.netChecks <= 32, 'bounded network checks: ' + log.netChecks)
  }
  {
    const { r, log, advance } = rig({ restartOk: false })
    r.suspend(); r.resume(); await advance(60_000)
    eq([log.restarts, log.fails], [1, ['restart_failed']], 'restart fails -> stop + one error, no retry')
  }
  {
    const { r, log, advance } = rig({ restartMs: 5000, netAt: 0 })
    r.suspend(); r.resume(); await advance(2100)
    r.resume(); r.suspend(); r.resume()
    await advance(20_000)
    eq([log.overlap, log.restarts <= 2], [0, true], 'resume during a run never overlaps a start')
  }
  {
    const { r, log, advance } = rig()
    r.resume(); await advance(5000)
    eq(log.restarts, 1, 'a resume without a seen suspend still restarts once when the tunnel is on')
  }

  // ---- usable underlay / default-gateway readiness (pure, over a fake route snapshot)
  const R = (alias: string, nextHop: string, up = true) => ({ alias, nextHop, up })
  eq(underlayReady(true, []), false, 'no default route -> not ready')
  eq(underlayReady(true, [R('vEthernet (WSL)', '0.0.0.0')]), false, 'WSL / Hyper-V-like interface without a gateway -> not ready')
  eq(underlayReady(true, [R('Waarp', '0.0.0.0'), R('Waarp', '172.19.77.2')]), false, 'Waarp-only -> not ready')
  eq(underlayReady(true, [R('Other VPN', '0.0.0.0')]), false, 'an on-link VPN default route alone -> not ready')
  eq(underlayReady(true, [R('Wi-Fi', '192.168.1.1', false)]), false, 'gateway on a DOWN interface -> not ready')
  eq(underlayReady(true, [R('Wi-Fi', '192.168.1.1')]), true, 'default gateway back -> ready')
  eq(underlayReady(true, [R('Other VPN', '0.0.0.0'), R('Ethernet', '10.0.0.1')]), true, 'another VPN plus an underlay gateway -> ready (neither touched)')
  eq(underlayReady(false, [R('Wi-Fi', '192.168.1.1')]), false, 'offline -> not ready')
  eq(underlayReady(true, undefined), false, 'unreadable snapshot -> not ready')

  console.log(`resume.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
