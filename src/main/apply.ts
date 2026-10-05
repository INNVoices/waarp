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
  /** refreshes notices; true when a hard block is active */
  blocked: () => Promise<boolean>
  demandsTunnel: (s: Settings) => boolean
  start: (s: Settings) => Promise<void>
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
      if (await d.blocked()) { if (running) await d.stop(); return { saved: true, applied: false, running, code: 'block' } }
      if (!running) return { saved: true, applied: false, running }
      if (!d.demandsTunnel(next)) { await d.stop(); return { saved: true, applied: d.phase() === 'off', running, ...(d.phase() === 'off' ? {} : { code: 'start' as const }) } }
      await d.start(next)
      return d.phase() === 'on' ? { saved: true, applied: true, running } : { saved: true, applied: false, running, code: 'start' }
    } finally { d.changed() }
  }
}

const isRunning = (phase: string) => phase === 'on' || phase === 'starting'

/** RC2 B: the card at `at` gets `via`; everything else, `rest` included, stays as it was */
export function selectVia(s: Settings, at: number, via: string): Settings {
  return { ...s, routes: s.routes.map((r, i) => i === at ? { ...r, via, on: true, fallback: undefined } : r) }
}
