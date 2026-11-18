// W2.1: the one effective state per route. Main computes it from the compiled plan + live evidence and ships it in
// Status; the UI only renders it (Home mood, route rows) and never re-derives meaning from raw pings/health.
import { compilePlan } from './plan'
import { EXITLAG_VIA } from './exitlag'
import type { Profile, Settings, Status, TunnelHealth, Via } from './types'
import { withAuto, type AutoSource } from './groups'
import { sameEffectiveRouting } from './routing-edit'

export type RouteState = 'ok' | 'fallback' | 'retrying' | 'blocked' | 'direct' | 'idle' | 'off' | 'external'
/** why a route is not plainly ok; codes, the UI owns the words */
export type RouteReason = 'main_down' | 'path_down' | 'engine_down' | 'missing' | 'busy' | 'waiting'
export interface RouteEff { desired: Via; effective?: Via; state: RouteState; reason?: RouteReason }
/** id `*rest` = the whole-computer exit when scope is computer */
export const REST_ID = '*rest'

type Live = Pick<Status, 'phase' | 'engine' | 'health' | 'fallback'> & Partial<Pick<Status, 'picked'>>

/** A healthy spare is not evidence that the selected path carries traffic. */
function pathHealth(via: Via, s: Settings, health: Record<string, TunnelHealth>, picked: Record<string, string>): TunnelHealth {
  const g = (s.groups ?? []).find(x => x.id === via)
  if (!g) return health[via] ?? 'unknown'
  const selected = picked[via]
  return selected && g.members.includes(selected) ? health[selected] ?? 'unknown' : 'unknown'
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
    // External interception happens upstream of TUN. We cannot claim network success from Waarp.
    if (via === EXITLAG_VIA) return { desired: via, state: 'external' }
    // a missing target is rejected (fail closed), never quietly sent Direct
    if (blocked.has(via)) return { desired: via, state: 'blocked', reason: 'missing' }
    if (!on) return { desired: via, state: 'idle', reason: 'waiting' }
    if (live.engine === 'down') return { desired: via, state: 'retrying', reason: 'engine_down' }
    const fb = live.fallback?.[id]
    const path = fb ?? via
    const h = pathHealth(path, s, health, live.picked ?? {})
    if (h === 'busy') return { desired: via, state: 'blocked', reason: 'busy' }
    if (h === 'down') return { desired: via, state: 'retrying', reason: 'path_down' }
    if (h === 'unknown') return { desired: via, state: 'retrying', reason: 'waiting' }
    if (fb) return { desired: via, effective: live.picked?.[fb] ?? fb, state: 'fallback', reason: 'main_down' }
    // a group (incl. Auto) reports the member it actually uses, so the UI can say "Авто -> Сервер 1"
    return { desired: via, effective: live.picked?.[via] ?? via, state: 'ok' }
  }
  const out: Record<string, RouteEff> = {}
  for (const r of s.routes) out[r.id] = one(r.id, r.via, r.on)
  if (s.rest !== 'direct') out[REST_ID] = one(REST_ID, s.rest, true)
  return out
}

/** A saved edit is not native confirmation. Keep unaffected route evidence, and
 * show waiting for changed intent after a failed transaction instead of declaring
 * its newly selected profile healthy merely because that profile has a ping. */
export function confirmedRoutes(desired: Settings, profiles: (Pick<Profile, 'id' | 'revoked'> & AutoSource)[], live: Live,
  acknowledged?: Settings, guarded = false): Record<string, RouteEff> {
  if (!acknowledged || live.phase !== 'on' || (!guarded && sameEffectiveRouting(acknowledged, desired))) return effectiveRoutes(desired, profiles, live)
  const previous = effectiveRoutes(acknowledged, profiles, live)
  const before = acknowledged.routes.filter(r => r.on), after = desired.routes.filter(r => r.on)
  const stable = (route: Settings['routes'][number] | undefined) => { if (!route) return ''; const { name: _name, ...value } = route; return JSON.stringify(value) }
  const global = guarded || acknowledged.rest !== desired.rest || acknowledged.ruDirect !== desired.ruDirect || acknowledged.lanDirect !== desired.lanDirect || acknowledged.dnsAll !== desired.dnsAll
  const states = Object.fromEntries(desired.routes.map(route => {
    const old = acknowledged.routes.find(r => r.id === route.id)
    const group = (settings: Settings) => settings.groups.find(g => g.id === route.via)
    const changed = global || stable(old) !== stable(route) || before.findIndex(r => r.id === route.id) !== after.findIndex(r => r.id === route.id) || JSON.stringify(group(acknowledged)) !== JSON.stringify(group(desired))
    return [route.id, changed ? { desired: route.via, state: 'retrying' as const, reason: 'waiting' as const,
      ...(!guarded && previous[route.id]?.effective ? { effective: previous[route.id].effective } : {}) } : previous[route.id]]
  })) as Record<string, RouteEff>
  if (desired.rest !== 'direct' || acknowledged.rest !== 'direct') states[REST_ID] = global
    ? { desired: desired.rest, state: 'retrying', reason: 'waiting', ...(!guarded && previous[REST_ID]?.effective ? { effective: previous[REST_ID].effective } : {}) }
    : previous[REST_ID] ?? { desired: desired.rest, state: 'direct', effective: 'direct' }
  return states
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
