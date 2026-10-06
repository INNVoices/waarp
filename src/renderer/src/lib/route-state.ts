import type { Route, Status } from '../../../shared/types'
import type { RouteEff } from '../../../shared/effective'

/**
 * Owner-facing route state. Global master intent is separate from the transient core phase:
 * a Direct rule stays Direct while the core is off, and an internal reapply is "applying",
 * never "waiting for Waarp to be turned on".
 */
export function routeStateKey(route: Pick<Route, 'on' | 'via'>, status: Pick<Status, 'open' | 'phase'>, eff?: RouteEff, draft = false): string {
  if (!route.on) return draft ? 'route.st.draft' : 'route.st.off'
  if (eff?.state === 'fallback') return 'route.st.fb'
  if (eff?.state === 'blocked' || eff?.state === 'retrying') return 'route.st.' + eff.reason
  if (route.via === 'direct' || eff?.state === 'direct') return 'route.st.direct'
  if (eff?.state === 'ok') return 'route.st.ok'
  if (status.open === true && (eff?.state === 'idle' || status.phase === 'starting' || status.phase === 'stopping' || status.phase === 'off'))
    return 'route.st.applying'
  return 'route.st.idle'
}

export function routeSchemeHintKey(route: Pick<Route, 'via'>, status: Pick<Status, 'open' | 'phase'>): string | undefined {
  if (route.via === 'direct' || status.phase === 'on') return undefined
  return status.open === true ? 'route.scheme.applying' : 'route.scheme.off'
}
