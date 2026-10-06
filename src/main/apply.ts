// RC2 C: one result contract for every routing write (renderer route select, companion picker, bridge routes.ensure).
// Saved intent and runtime application are reported separately; a failed restart never rolls the intent back.
import type { Settings } from '../shared/types'

export type ApplyCode = 'save' | 'block' | 'start'
/** saved: the intent is on disk. applied: the running engine now uses it (false when closed: closed stays closed). */
export type ApplyResult = { saved: boolean; applied: boolean; running: boolean; code?: ApplyCode }

export interface ApplyDeps {
  get: () => Settings
  set: (s: Settings) => void
  save: () => void
  phase: () => string
  /** HOTFIX-RUNTIME-01 E: the master switch's intent; card edits never change it */
  open?: () => boolean
  /** refreshes notices; true when a hard block is active */
  blocked: () => Promise<boolean>
  demandsTunnel: (s: Settings) => boolean
  start: (s: Settings) => Promise<void>
  /** HOTFIX-RUNTIME-01 B2: switch the running core live; true = applied, no scan or restart needed */
  live?: (s: Settings) => Promise<boolean>
  stop: () => Promise<unknown>
  changed: () => void
}

export function createApply(d: ApplyDeps): (next: Settings) => Promise<ApplyResult> {
  return async next => {
    const previous = d.get()
    d.set(next)
    try { d.save() } catch { d.set(previous); return { saved: false, applied: false, running: isRunning(d.phase()), code: 'save' } }
    const running = isRunning(d.phase())
    try {
      // The owner's global close is higher priority than a route write. Save intent, but never live-switch/restart
      // a core that the master is closing; the next explicit open uses the saved settings.
      if (d.open && !d.open()) return { saved: true, applied: false, running }
      // B2: a pick the running core already serves is a selector switch; the periodic watch still guards the session
      if (d.phase() === 'on' && d.live && d.demandsTunnel(next) && (await d.live(next))) return { saved: true, applied: true, running }
      if (await d.blocked()) { if (running) await d.stop(); return { saved: true, applied: false, running, code: 'block' } }
      if (!running) {
        // E: master open but the core was idle (no card needed it): a card that needs a tunnel starts it, no second master click
        if (d.open?.() && d.demandsTunnel(next)) { await d.start(next); return d.phase() === 'on' ? { saved: true, applied: true, running } : { saved: true, applied: false, running, code: 'start' } }
        return { saved: true, applied: false, running }
      }
      // E: no card needs a tunnel any more: the core stops, the master stays open (the caller keeps its intent)
      if (!d.demandsTunnel(next)) { await d.stop(); return { saved: true, applied: d.phase() === 'off', running, ...(d.phase() === 'off' ? {} : { code: 'start' as const }) } }
      await d.start(next)
      return d.phase() === 'on' ? { saved: true, applied: true, running } : { saved: true, applied: false, running, code: 'start' }
    } finally { d.changed() }
  }
}

const isRunning = (phase: string) => phase === 'on' || phase === 'starting'

/** A routes/rest/groups/ruDirect settings patch does not carry the master open/closed intent.
 * A hard block still forces a stop, but merely turning the last tunnel-demanding card off must
 * not close Waarp: the orb owns that intent. */
export function onRoutingPatch(phase: string, blocked: boolean): 'stop' | 'start' | 'none' {
  if (!isRunning(phase)) return 'none'
  return blocked ? 'stop' : 'start'
}

/** RC2 B: the card at `at` gets `via`; everything else, `rest` included, stays as it was */
export function selectVia(s: Settings, at: number, via: string): Settings {
  return { ...s, routes: s.routes.map((r, i) => i === at ? { ...r, via, on: true, fallback: undefined } : r) }
}
