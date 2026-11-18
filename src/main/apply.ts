// RC2 C: one result contract for every routing write (renderer route select, companion picker, bridge routes.ensure).
// Saved intent and runtime application are reported separately; a failed restart never rolls the intent back.
import type { Settings } from '../shared/types'

export type ApplyCode = 'save' | 'block' | 'start' | 'restart' | 'rollback'
/** saved: the intent is on disk. applied: the running engine now uses it (false when closed: closed stays closed). */
export type ApplyResult = { saved: boolean; applied: boolean; running: boolean; code?: ApplyCode }

export interface ApplyDeps {
  get: () => Settings
  set: (s: Settings) => void
  save: () => void
  phase: () => string
  /** HOTFIX-RUNTIME-01 E: the master switch's intent; card edits never change it */
  open?: () => boolean
  /** distinguishes a new OPEN after OFF from the operation that the owner cancelled */
  revision?: () => number
  /** Native identity remains valid until the authorized start consumes it. */
  session?: () => unknown
  /** refreshes notices; true when a hard block is active */
  blocked: () => Promise<boolean>
  demandsTunnel: (s: Settings) => boolean
  /** A scope-changing live edit may need a read-only safety check before native writes. */
  validateLive?: (s: Settings) => Promise<boolean>
  start: (s: Settings, current: () => boolean) => Promise<void>
  /** HOTFIX-RUNTIME-01 B2: switch the running core live; true = applied, no scan or restart needed */
  live?: (s: Settings) => Promise<boolean>
  /** Operational live failures keep the previous session; only structural misses restart. */
  liveFailure?: () => string | undefined
  /** Explicit consent is mandatory before a structural change cycles an active TUN. */
  confirmRestart?: () => Promise<boolean>
  stop: () => Promise<unknown>
  changed: () => void
}

export function createApply(d: ApplyDeps): (next: Settings) => Promise<ApplyResult> {
  return async next => {
    const revision = d.revision?.()
    const session = d.session?.(), phase = d.phase()
    const ownerCurrent = () => (!d.open || d.open()) && (!d.revision || d.revision() === revision)
    const current = () => ownerCurrent() && (!d.session || (d.session() === session && d.phase() === phase))
    const previous = d.get()
    d.set(next)
    try { d.save() } catch { d.set(previous); return { saved: false, applied: false, running: isRunning(d.phase()), code: 'save' } }
    const running = isRunning(d.phase())
    const reject = (code: 'block' | 'restart'): ApplyResult => {
      d.set(previous)
      try { d.save(); return { saved: false, applied: false, running, code } }
      catch { return { saved: false, applied: false, running, code: 'rollback' } }
    }
    try {
      // The owner's global close is higher priority than a route write. Save intent, but never live-switch/restart
      // a core that the master is closing; the next explicit open uses the saved settings.
      if (!current()) return { saved: true, applied: false, running }
      // Compare against the acknowledged runtime inside live(), not the last saved
      // intent: that intent may belong to an earlier failed apply which needs retrying.
      // B2: a pick the running core already serves is a selector switch; the periodic watch still guards the session
      if (d.phase() === 'on' && d.live) {
        if (d.validateLive) {
          const allowed = await d.validateLive(next)
          if (!current()) return reject('restart')
          if (!allowed) return reject('block')
        }
        const applied = await d.live(next)
        if (!current()) return applied ? { saved: true, applied: false, running } :
          reject('restart')
        if (applied) return { saved: true, applied: true, running }
        if (d.liveFailure?.()) return { saved: true, applied: false, running, code: 'start' }
      }
      const blocked = await d.blocked()
      if (!current()) return reject('restart')
      if (blocked) return reject('block')
      if (!running) {
        // An open-but-idle master may acquire a TUN only after a second explicit
        // decision: route changes never silently turn the adapter on.
        if (d.phase() === 'off' && d.open?.() && d.demandsTunnel(next)) {
          if (!(await d.confirmRestart?.())) {
            return reject('restart')
          }
          if (!current()) return reject('restart')
          await d.start(next, current)
          return !ownerCurrent() ? { saved: true, applied: false, running } :
            d.phase() === 'on' ? { saved: true, applied: true, running } : { saved: true, applied: false, running, code: 'start' }
        }
        return { saved: true, applied: false, running }
      }
      if (!(await d.confirmRestart?.())) {
        return reject('restart')
      }
      if (!current()) return reject('restart')
      // A running session remains owned by the master even when every card becomes
      // Direct/disabled. Reconcile structural changes without treating a card
      // edit as an implicit global OFF; operational failures returned above.
      await d.start(next, current)
      return !ownerCurrent() ? { saved: true, applied: false, running } : d.phase() === 'on' ? { saved: true, applied: true, running } : { saved: true, applied: false, running, code: 'start' }
    } catch {
      // A failed read/preflight/start is not permission to stop or report the
      // still-running previous configuration as successfully applied.
      return { saved: true, applied: false, running, code: 'start' }
    } finally { d.changed() }
  }
}

const isRunning = (phase: string) => phase === 'on' || phase === 'starting'

/** RC2 B: the card at `at` gets `via`; everything else, `rest` included, stays as it was */
export function selectVia(s: Settings, at: number, via: string): Settings {
  return { ...s, routes: s.routes.map((r, i) => i === at ? { ...r, via, on: true, fallback: undefined } : r) }
}
