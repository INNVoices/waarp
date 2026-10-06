// RC2 B/C/H: route select keeps the whole-computer intent; every routing write reports saved vs applied; bridge ids bounded.
import { createApply, onRoutingPatch, selectVia, type ApplyDeps } from '../src/main/apply'
import { okId } from '../src/main/bridge'
import { DEFAULTS } from '../src/main/store-core'
import type { Settings } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import { SerialGate } from '../src/main/serial'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const base: Settings = { ...DEFAULTS, rest: 'p1', routes: [
  { id: 'app:a', kind: 'app', name: 'A', exe: 'C:\A\a.exe', matchDir: 'C:\A', via: 'direct', on: true },
  { id: 'custom:x.org', kind: 'custom', name: 'x.org', value: 'x.org', via: 'p1', fallback: 'p2', on: false }
] } as Settings

function rig(o: { phase?: string; saveFails?: boolean; block?: boolean; startTo?: string; open?: boolean } = {}) {
  let cur = base, phase = o.phase ?? 'off', starts = 0, stops = 0, saves = 0, changed = 0
  const d: ApplyDeps = {
    get: () => cur, set: s => { cur = s },
    save: () => { saves++; if (o.saveFails) throw new Error('disk') },
    phase: () => phase,
    open: o.open === undefined ? undefined : () => !!o.open,
    blocked: async () => !!o.block,
    demandsTunnel: s => s.rest !== 'direct' || s.routes.some(r => r.on && r.via !== 'direct'),
    start: async () => { starts++; phase = o.startTo ?? 'on' },
    stop: async () => { stops++; phase = 'off' },
    changed: () => { changed++ }
  }
  return { apply: createApply(d), get: () => cur, counts: () => ({ starts, stops, saves, changed }) }
}

;(async () => {
  // B: selecting one card never changes rest
  const sel = selectVia(base, 0, 'p2')
  eq(sel.rest, 'p1', 'select keeps rest (whole-computer intent)')
  eq([sel.routes[0].via, sel.routes[0].on], ['p2', true], 'selected card gets the path')
  eq(sel.routes[1], base.routes[1], 'other cards untouched')
  eq(selectVia(base, 1, 'direct').routes[1].fallback, undefined, 'new path clears the fallback')

  // C1: closed stays closed -> saved, not applied, no start
  { const r = rig(); const a = await r.apply(sel); eq(a, { saved: true, applied: false, running: false }, 'closed: saved only'); eq(r.counts().starts, 0, 'closed: no start') }
  // C2: running + good restart -> saved + applied
  { const r = rig({ phase: 'on' }); const a = await r.apply(sel); eq(a, { saved: true, applied: true, running: true }, 'running: saved and applied'); eq(r.counts().starts, 1, 'running: one restart') }
  // C3a: running + failed restart -> saved, not applied, intent kept
  { const r = rig({ phase: 'on', startTo: 'error' }); const a = await r.apply(sel); eq(a, { saved: true, applied: false, running: true, code: 'start' }, 'failed restart: saved, not applied'); eq(r.get(), sel, 'failed restart keeps the intent') }
  // C3b: running + block -> saved, not applied, stopped
  { const r = rig({ phase: 'on', block: true }); const a = await r.apply(sel); eq(a, { saved: true, applied: false, running: true, code: 'block' }, 'block: saved, not applied'); eq([r.counts().starts, r.counts().stops], [0, 1], 'block: stopped, not started') }
  // C4: save failure -> not saved, previous restored, runtime untouched
  { const r = rig({ phase: 'on', saveFails: true }); const a = await r.apply(sel); eq(a, { saved: false, applied: false, running: true, code: 'save' }, 'save failure: not saved'); eq(r.get(), base, 'save failure restores previous'); eq([r.counts().starts, r.counts().stops], [0, 0], 'save failure: runtime untouched') }
  // C: snapshot pushed for every saved write
  { const r = rig({ phase: 'on', startTo: 'error' }); await r.apply(sel); eq(r.counts().changed, 1, 'snapshot sent once') }

  // owner OFF wins over an in-flight/queued route apply: save intent, but never resurrect/switch the core
  {
    const r = rig({ phase: 'on', open: false })
    const a = await r.apply(sel)
    eq(a, { saved: true, applied: false, running: true }, 'master closed during route apply: intent saved, runtime untouched')
    eq([r.counts().starts, r.counts().stops], [0, 0], 'master closed: route apply does not restart or stop behind owner action')
  }

  // card toggles never carry the master open/closed intent; only a hard block may stop a running core
  eq(onRoutingPatch('off', false), 'none', 'routing patch while closed: no-op')
  eq(onRoutingPatch('off', true), 'none', 'routing patch while closed, even if blocked: no-op')
  eq(onRoutingPatch('on', false), 'start', 'last card turned off while running: engine remains under master intent')
  eq(onRoutingPatch('starting', false), 'start', 'routing patch mid-start: reapply, not a master stop')
  eq(onRoutingPatch('on', true), 'stop', 'hard block while running: fail-closed stop preserved')
  eq(onRoutingPatch('starting', true), 'stop', 'hard block mid-start: fail-closed stop preserved')

  // Routing intent may arrive from renderer and the companion bridge at the same time.
  // The main-process gate, not only UI disabled states, is the correctness boundary.
  {
    const gate = new SerialGate()
    const order: string[] = []
    let release!: () => void
    const hold = new Promise<void>(r => { release = r })
    const first = gate.run(async () => { order.push('first:start'); await hold; order.push('first:end'); return 1 })
    const second = gate.run(async () => { order.push('second:start'); order.push('second:end'); return 2 })
    await Promise.resolve()
    eq(order, ['first:start'], 'serial gate does not overlap intent writes')
    release()
    eq(await Promise.all([first, second]), [1, 2], 'serial gate preserves results')
    eq(order, ['first:start', 'first:end', 'second:start', 'second:end'], 'serial gate is FIFO')
    await gate.run(async () => { throw new Error('expected') }).catch(() => undefined)
    const afterFailure = await gate.run(async () => 3)
    eq(afterFailure, 3, 'failed intent write does not poison the queue')
  }

  const main = readFileSync('src/main/index.ts', 'utf8')
  ok(main.includes("secureHandle('toggle'") && main.includes("secureIntentHandle('settings'") && main.includes("secureIntentHandle('route:select'")
    && main.includes("secureIntentHandle('companion:choose'") && main.includes("secureIntentHandle('profile:remove'")
    && main.includes('ensure: (target, intent) => intentWrites.run')
    && main.includes("click: () => void toggle()"), 'routing mutations share FIFO while master toggle stays immediate')
  ok(main.includes("isOn: () => masterOpen &&") && main.includes("restart: () => intentWrites.run(async () =>")
    && main.includes("if (!masterOpen) return true") && main.includes("fail: why => intentWrites.run(async () =>")
    && main.includes("setMaster(false)") && main.includes("if (!masterOpen) { updateTray(); send('snapshot', snapshot()); return snapshot() }")
    && main.includes("if (wasOn && masterOpen)")
    && main.includes("if (!masterOpen) setMaster(true)")
    && main.includes("if (!masterOpen) return { ok: false, error: 'Подключение отменено' }")
    && !main.includes("if (up) setMaster(true)"), 'owner close wins over connect/resume/settings/profile reconnect and terminal resume failure closes its intent')

  // H: bridge request ids
  for (const v of [undefined, null, 0, 1, -5, 2.5, Number.MAX_SAFE_INTEGER, '', 'abc', 'x'.repeat(128)]) ok(okId(v), 'id ok: ' + String(v).slice(0, 20))
  for (const v of [NaN, Infinity, 1e300, 'x'.repeat(129), {}, [], true]) ok(!okId(v), 'id rejected: ' + JSON.stringify(v)?.slice(0, 20))

  // RC2 P1.2: closing the add dialog (first-run Escape) stays where it is, never jumps to an empty library
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const close = /onClose=\{\(\) => \{([^}]*)\}\}/.exec(app.slice(app.indexOf('<AddTunnel')))?.[1] ?? ''
  ok(close.includes('setAdding(false)') && !close.includes('go('), 'add dialog close does not navigate: ' + close.trim())

  console.log(`apply.check: ${n} checks`)
  if (fails) { console.error(`${fails} failed`); process.exit(1) }
})()
