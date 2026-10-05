// W2.1: the one effective state per route. Main computes it from the compiled plan + live evidence and ships it in
// Status; the UI only renders it (Home mood, route rows) and never re-derives meaning from raw pings/health.
import { compilePlan } from './plan'
import type { Profile, Settings, Status, TunnelHealth, Via } from './types'
import { withAuto, type AutoSource } from './groups'

export type RouteState = 'ok' | 'fallback' | 'retrying' | 'blocked' | 'direct' | 'idle' | 'off'
/** why a route is not plainly ok; codes, the UI owns the words */
export type RouteReason = 'main_down' | 'path_down' | 'engine_down' | 'missing' | 'busy' | 'waiting'
export interface RouteEff { desired: Via; effective?: Via; state: RouteState; reason?: RouteReason }
/** id `*rest` = the whole-computer exit when scope is computer */
export const REST_ID = '*rest'

type Live = Pick<Status, 'phase' | 'engine' | 'health' | 'fallback'> & Partial<Pick<Status, 'picked'>>

/** health of a path: a profile's own, or a group's best member (a group works while any member works) */
function pathHealth(via: Via, s: Settings, health: Record<string, TunnelHealth>): TunnelHealth {
  const g = (s.groups ?? []).find(x => x.id === via)
  if (!g) return health[via] ?? 'unknown'
  const hs = g.members.map(m => health[m] ?? 'unknown')
  for (const want of ['ok', 'degraded', 'unknown', 'busy'] as TunnelHealth[]) if (hs.includes(want)) return want
  return 'down'
}

export function effectiveRoutes(given: Settings, profiles: (Pick<Profile, 'id' | 'revoked'> & AutoSource)[], live: Live): Record<string, RouteEff> {
  const s = withAuto(given, profiles)
  const plan = compilePlan(s, profiles)
  const blocked = new Set(plan.blockedTargets)
  const health = live.health ?? {}
  const on = live.phase === 'on'
  const one = (id: string, via: Via, enabled: boolean): RouteEff => {
    if (!enabled) return { desired: via, state: 'off' }
    if (via === 'direct') return { desired: via, effective: 'direct', state: 'direct' }
    // a missing target is rejected (fail closed), never quietly sent Direct
    if (blocked.has(via)) return { desired: via, state: 'blocked', reason: 'missing' }
    if (!on) return { desired: via, state: 'idle', reason: 'waiting' }
    const fb = live.fallback?.[id]
    if (fb) return { desired: via, effective: fb, state: 'fallback', reason: 'main_down' }
    if (live.engine === 'down') return { desired: via, state: 'retrying', reason: 'engine_down' }
    const h = pathHealth(via, s, health)
    if (h === 'busy') return { desired: via, state: 'blocked', reason: 'busy' }
    if (h === 'down') return { desired: via, state: 'retrying', reason: 'path_down' }
    // a group (incl. Auto) reports the member it actually uses, so the UI can say "Авто -> Сервер 1"
    return { desired: via, effective: live.picked?.[via] ?? via, state: 'ok' }
  }
  const out: Record<string, RouteEff> = {}
  for (const r of s.routes) out[r.id] = one(r.id, r.via, r.on)
  if (s.rest !== 'direct') out[REST_ID] = one(REST_ID, s.rest, true)
  return out
}

/** global mood from effective impact only (a sick spare never shows here). attention = an enabled route cannot go
 *  at all (missing, revoked, busy key): it will not heal itself, so it outranks recovering (fallback / retrying);
 *  ok = every enabled route has a usable path. Route rows keep each individual reason. */
export type Mood = 'ok' | 'recovering' | 'attention'
export function moodOf(eff: Record<string, RouteEff>): Mood {
  const v = Object.values(eff)
  if (v.some(e => e.state === 'blocked')) return 'attention'
  return v.some(e => e.state === 'fallback' || e.state === 'retrying') ? 'recovering' : 'ok'
}
