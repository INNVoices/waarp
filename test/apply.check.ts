// RC2 B/C/H: route select keeps the whole-computer intent; every routing write reports saved vs applied; bridge ids bounded.
import { createApply, selectVia, type ApplyDeps } from '../src/main/apply'
import { okId } from '../src/main/bridge'
import { DEFAULTS } from '../src/main/store-core'
import type { Settings } from '../src/shared/types'
import { readFileSync } from 'node:fs'
import { SerialGate } from '../src/main/serial'
import { compilePlan, requiresCore } from '../src/shared/plan'

let fails = 0, n = 0
const ok = (c: unknown, msg: string) => { n++; if (!c) { fails++; console.error('FAIL', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)

const base: Settings = { ...DEFAULTS, rest: 'p1', routes: [
  { id: 'app:a', kind: 'app', name: 'A', exe: 'C:\A\a.exe', matchDir: 'C:\A', via: 'direct', on: true },
  { id: 'custom:x.org', kind: 'custom', name: 'x.org', value: 'x.org', via: 'p1', fallback: 'p2', on: false }
] } as Settings

function rig(o: { phase?: string; saveFails?: boolean; block?: boolean; startTo?: string; open?: boolean; confirm?: boolean } = {}) {
  let cur = base, phase = o.phase ?? 'off', starts = 0, stops = 0, saves = 0, changed = 0
  const d: ApplyDeps = {
    get: () => cur, set: s => { cur = s },
    save: () => { saves++; if (o.saveFails) throw new Error('disk') },
    phase: () => phase,
    open: o.open === undefined ? undefined : () => !!o.open,
    blocked: async () => !!o.block,
    demandsTunnel: requiresCore,
    start: async () => { starts++; phase = o.startTo ?? 'on' },
    stop: async () => { stops++; phase = 'off' },
    confirmRestart: async () => o.confirm !== false,
    changed: () => { changed++ }
  }
  return { apply: createApply(d), get: () => cur, counts: () => ({ starts, stops, saves, changed }) }
}

;(async () => {
  const dpi: Settings = { ...DEFAULTS, rest: 'direct', routes: [{ id: 'custom:example.org', kind: 'custom', name: 'example.org', value: 'example.org', via: 'direct', on: true, dpi: true }] }
  ok(compilePlan(dpi, []).canStart, 'Direct+DPI needs the core even with no personal tunnels')
  {
    const r = rig({ open: true, confirm: false })
    const a = await r.apply(dpi)
    eq([a.applied, r.counts().starts], [false, 0], 'unapproved edit cannot start an idle TUN')
    eq(a.code, 'restart', 'idle master asks for explicit approval')
  }
  {
    const r = rig({ open: true, confirm: true })
    const a = await r.apply(dpi)
    eq([a.applied, r.counts().starts], [true, 1], 'explicit approval may activate idle TUN')
  }
  {
    const r = rig({ phase: 'on', open: true })
    const a = await r.apply(dpi)
    eq([a.applied, r.counts().stops], [true, 0], 'last tunnel card becoming Direct+DPI keeps a required core')
  }
  ok(!requiresCore({ ...dpi, routes: dpi.routes.map(r => ({ ...r, dpi: false })) }), 'plain Direct can remain idle')
  ok(!requiresCore({ ...dpi, routes: dpi.routes.map(r => ({ ...r, on: false })) }), 'disabled DPI card does not start a core')
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
  // An invalid edit or rejected consent must preserve both the old route and TUN.
  { const r = rig({ phase: 'on', block: true }); const a = await r.apply(sel); eq(a, { saved: false, applied: false, running: true, code: 'block' }, 'blocked edit rejected'); eq(r.get(), base, 'blocked edit rolled back'); eq([r.counts().starts, r.counts().stops], [0, 0], 'blocked edit did not stop TUN') }
  { const r = rig({ phase: 'on', confirm: false }); const a = await r.apply(sel); eq(a, { saved: false, applied: false, running: true, code: 'restart' }, 'restart requires consent'); eq(r.get(), base, 'denial restored previous route'); eq([r.counts().starts, r.counts().stops], [0, 0], 'denial cannot cycle TUN') }
  // C4: save failure -> not saved, previous restored, runtime untouched
  {
    let saved = base, saves = 0, nativeWrites = 0
    const result = await createApply({
      get: () => saved, set: next => { saved = next }, save: () => { if (++saves > 1) throw new Error('disk refused rollback') },
      phase: () => 'on', open: () => true, blocked: async () => false, demandsTunnel: () => true,
      confirmRestart: async () => false, start: async () => { nativeWrites++ }, stop: async () => { nativeWrites++ }, changed: () => {}
    })(sel)
    eq([result.saved, result.code, saved, nativeWrites], [false, 'rollback', base, 0],
      'failed cancellation persistence retains previous in-memory intent and reports the disk error without native changes')
  }
  { const r = rig({ phase: 'on', saveFails: true }); const a = await r.apply(sel); eq(a, { saved: false, applied: false, running: true, code: 'save' }, 'save failure: not saved'); eq(r.get(), base, 'save failure restores previous'); eq([r.counts().starts, r.counts().stops], [0, 0], 'save failure: runtime untouched') }
  {
    let saved = base, writes = 0
    const result = await createApply({
      get: () => saved, set: next => { saved = next }, save: () => {}, phase: () => 'on', open: () => true,
      validateLive: async () => false, live: async () => { writes++; return true }, blocked: async () => false,
      demandsTunnel: () => true, start: async () => { writes++ }, stop: async () => { writes++ }, changed: () => {}
    })(sel)
    eq([result.saved, result.code, saved, writes], [false, 'block', base, 0], 'blocked scope change is rolled back before any native write')
  }
  {
    let saved = base
    const result = await createApply({
      get: () => saved, set: next => { saved = next }, save: () => {}, phase: () => 'on', open: () => true,
      blocked: async () => false, demandsTunnel: () => true, confirmRestart: async () => true,
      start: async () => { throw new Error('preflight failed while previous core stays on') }, stop: async () => { throw new Error('unexpected OFF') }, changed: () => {}
    })(sel)
    eq([result.saved, result.applied, result.code], [true, false, 'start'], 'failed start preflight cannot report old running TUN as a successfully applied edit')
  }
  // C: snapshot pushed for every saved write
  { const r = rig({ phase: 'on', startTo: 'error' }); await r.apply(sel); eq(r.counts().changed, 1, 'snapshot sent once') }

  // owner OFF wins over an in-flight/queued route apply: save intent, but never resurrect/switch the core
  {
    const r = rig({ phase: 'on', open: false })
    const a = await r.apply(sel)
    eq(a, { saved: true, applied: false, running: true }, 'master closed during route apply: intent saved, runtime untouched')
    eq([r.counts().starts, r.counts().stops], [0, 0], 'master closed: route apply does not restart or stop behind owner action')
  }

  // OFF during the asynchronous scan (and OFF/ON while the scan is pending) invalidates the old apply.
  for (const reopen of [false, true]) {
    let current = base, phase = 'on', open = true, revision = 1, starts = 0, changed = 0
    let release!: (blocked: boolean) => void
    const pending = new Promise<boolean>(r => { release = r })
    const apply = createApply({
      get: () => current, set: s => { current = s }, save: () => undefined, phase: () => phase,
      open: () => open, revision: () => revision, blocked: () => pending,
      demandsTunnel: () => true, start: async () => { starts++; phase = 'on' },
      stop: async () => { phase = 'off' }, changed: () => { changed++ }
    })
    const result = apply(sel)
    open = false; revision++
    if (reopen) { open = true; revision++ }
    release(false)
    eq(await result, { saved: false, applied: false, running: true, code: 'restart' }, `cancelled scan rejects the unapproved proposal (reopen=${reopen})`)
    eq([starts, current, changed], [0, base, 1], 'cancelled apply restores the proposal before a newer ON reads it')
  }
  {
    let current = base, open = true, starts = 0
    let release!: (applied: boolean) => void
    const result = createApply({
      get: () => current, set: s => { current = s }, save: () => undefined, phase: () => 'on', open: () => open,
      live: () => new Promise(r => { release = r }), blocked: async () => false,
      demandsTunnel: () => true, start: async () => { starts++ }, stop: async () => undefined, changed: () => undefined
    })(sel)
    open = false; release(false)
    const applied = await result
    eq([applied.saved, applied.applied, starts], [false, false, 0], 'OFF during a failed live switch rejects the unapplied proposal without restarting')
  }

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
  // Owner cancellation is exercised above with deferred live/scan operations. The master connect/disconnect
  // state machine has its own behavioral suite; do not bind this test to historical main-process source spellings.


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
