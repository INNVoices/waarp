// Companion routes: a local app holding the bridge token may name one bounded routing target (a descriptor) and an
// intent. The companion never sends a path, tag, key or config; Waarp owns which connection carries the target.
// A companion route is an ordinary Waarp route marked owner 'companion', so the user sees and edits it like any other.
import { AUTO_ID, autoMembers, type AutoSource } from './groups'
import { compilePlan } from './plan'
import { validateCustom } from './route-validation'
import type { RouteEff } from './effective'
import type { Profile, Route, Settings, Via } from './types'

/** what a companion names: `ext:<namespace>:<target>`, a display name and one plain host (no scheme / path / port) */
export interface Target { id: string; name: string; host: string }
export type Intent = 'auto' | 'direct' | 'waarp'
export const COMPANION_ID = /^ext:[a-z0-9][a-z0-9-]{0,23}:[a-z0-9][a-z0-9-]{0,31}$/
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const isIntent = (v: unknown): v is Intent => v === 'auto' || v === 'direct' || v === 'waarp'
/** the validated descriptor, or undefined. Strict: exact keys, bounded, a normalized FQDN the route validator accepts. */
export function parseTarget(v: unknown): Target | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (Object.keys(o).some(k => k !== 'id' && k !== 'name' && k !== 'host')) return undefined
  const { id, name, host } = o
  if (typeof id !== 'string' || !COMPANION_ID.test(id)) return undefined
  if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return undefined
  if (typeof host !== 'string' || !HOST.test(host) || validateCustom(host)) return undefined
  return { id, name, host }
}

/** a route with a reserved ext: id or an owner must be a companion route with a well-formed id */
export const reservedOk = (r: Pick<Route, 'id' | 'kind'> & { owner?: string }): boolean =>
  !(r.id.startsWith('ext:') || r.owner !== undefined) || (r.owner === 'companion' && r.kind === 'custom' && COMPANION_ID.test(r.id))

/** the renderer may change a companion route's path / on state or delete it, never create one or redefine its target */
export function companionEditsOk(next: Route[], prev: Route[]): boolean {
  return next.filter(r => r.owner !== undefined || r.id.startsWith('ext:')).every(r => {
    const p = prev.find(x => x.id === r.id)
    return !!p && p.owner === 'companion' && r.owner === 'companion' && r.kind === p.kind && r.name === p.name && r.value === p.value
  })
}

type Src = { id: string; revoked?: boolean; source?: string; kind?: string }
/** a path companion traffic may use: Direct, Auto (own-only), an own non-public live profile, or a user group whose
 *  every declared member is an own, non-public, live concrete profile. Never public, revoked or missing. */
export function safeVia(via: Via | undefined, s: Pick<Settings, 'groups'>, profiles: Src[]): boolean {
  if (via === undefined) return true
  if (via === 'direct' || via === AUTO_ID) return true
  const own = (id: string) => profiles.some(p => p.id === id && !p.revoked && p.source !== 'public' && p.kind !== 'group')
  const g = (s.groups ?? []).find(x => x.id === via)
  if (!g) return own(via)
  return g.members.length > 0 && g.members.every(own)
}
/** every companion route has a safe primary and a safe (or no) fallback */
export function companionRoutesSafe(s: Pick<Settings, 'routes' | 'groups'>, profiles: Src[]): boolean {
  return s.routes.filter(r => r.owner === 'companion').every(r => reservedOk(r) && safeVia(r.via, s, profiles) && (r.fallback === undefined || (r.fallback !== 'direct' && safeVia(r.fallback, s, profiles))))
}

export const routeFor = (t: Target, via: Via): Route => ({ id: t.id, kind: 'custom', name: t.name, value: t.host, via, on: true, owner: 'companion' })
export const routeOf = (s: Pick<Settings, 'routes'>, id: string): Route | undefined => s.routes.find(r => r.id === id)
/** an existing route under this id must be exactly this companion target (an id can never be redefined) */
export const sameTarget = (r: Route, t: Target): boolean => r.owner === 'companion' && r.kind === 'custom' && r.name === t.name && r.value === t.host
/** how a route reads as an intent: Direct, Auto, or a concrete path chosen in Waarp */
export const intentOf = (r: Route): Intent => (r.via === 'direct' ? 'direct' : r.via === AUTO_ID ? 'auto' : 'waarp')

export type EnsureError = 'bad_target' | 'bad_intent' | 'conflict' | 'no_auto' | 'needs_choice' | 'blocked'
type P = Pick<Profile, 'id' | 'revoked'> & AutoSource & { kind?: string }

/** pure: the settings after applying an intent, or a fixed error. Never connects; never picks Direct / public for Auto;
 *  `waarp` never invents a path. `rest` (scope) is not touched. */
export function ensureIntent(s: Settings, profiles: P[], raw: unknown, intent: unknown): { settings: Settings; changed: boolean } | { error: EnsureError } {
  const t = parseTarget(raw)
  if (!t) return { error: 'bad_target' }
  if (!isIntent(intent)) return { error: 'bad_intent' }
  const cur = routeOf(s, t.id)
  if (cur && !sameTarget(cur, t)) return { error: 'conflict' }
  // an intent always clears the fallback: simple and safe (a stale unsafe fallback can never survive)
  const put = (via: Via) => {
    const next = routeFor(t, via)
    const same = !!cur && cur.via === via && cur.on && cur.fallback === undefined
    return { settings: same ? s : { ...s, routes: cur ? s.routes.map(r => (r.id === next.id ? next : r)) : [...s.routes, next] }, changed: !same }
  }
  if (intent === 'direct') return put('direct')
  if (intent === 'auto') return autoMembers(profiles).length ? put(AUTO_ID) : { error: 'no_auto' }
  // waarp: keep the concrete path the user chose in Waarp; without one the companion opens the picker (nothing written)
  if (!cur || cur.via === 'direct' || cur.via === AUTO_ID) return { error: 'needs_choice' }
  if (!safeVia(cur.via, s, profiles) || compilePlan({ ...s, routes: [{ ...cur, on: true }] }, profiles).blockedTargets.includes(cur.via)) return { error: 'blocked' }
  return put(cur.via)
}

/** the concrete paths the picker may offer: own connections and own-only groups (Auto / Direct are other intents) */
export const pickOptions = (s: Pick<Settings, 'groups'>, profiles: (Src & { id: string })[]): Via[] =>
  profiles.filter(p => !p.revoked && p.id !== AUTO_ID && p.id !== 'direct' && safeVia(p.id, s, profiles)).map(p => p.id)

/** the bridge status: a stable, sanitized DTO. No servers, ids, hosts, pings, health internals or engine text. */
export interface BridgeStatus { phase: string; mood: 'ok' | 'recovering' | 'attention'; version: string; since?: number }
export const bridgeStatus = (phase: string, mood: BridgeStatus['mood'], version: string, since?: number): BridgeStatus =>
  ({ phase, mood, version, ...(typeof since === 'number' && Number.isFinite(since) ? { since } : {}) })

/** picker requests from routes.open: bounded, and each expires (a stale one can never be completed later) */
export const PICK_TTL = 120_000
export function createPending(max = 8, ttl = PICK_TTL) {
  const m = new Map<string, { t: Target; until: number }>()
  const sweep = (now: number) => { for (const [k, v] of m) if (v.until <= now) m.delete(k) }
  return {
    put(t: Target, now: number) { sweep(now); m.delete(t.id); m.set(t.id, { t, until: now + ttl }); while (m.size > max) m.delete(m.keys().next().value!) },
    get(id: string, now: number): Target | undefined { sweep(now); return m.get(id)?.t },
    drop(id: string) { m.delete(id) },
    get size() { return m.size },
  }
}

export interface RouteView { id: string; name: string; intent: Intent; on: boolean; state: RouteEff['state'] | 'off'; reason?: RouteEff['reason']; via?: string }
/** safe summary of companion routes: intent + effective state + a display name; no host, IP, tag, key or config */
export function listCompanion(s: Pick<Settings, 'routes'>, eff: Record<string, RouteEff> | undefined, name: (v: Via) => string | undefined): RouteView[] {
  return s.routes.filter(r => r.owner === 'companion').map(r => {
    const e = eff?.[r.id]
    const shown = e?.effective ?? r.via
    const via = shown && shown !== 'direct' ? name(shown) : undefined
    return { id: r.id, name: r.name, intent: intentOf(r), on: r.on, state: e?.state ?? (r.on ? 'idle' : 'off'), ...(e?.reason ? { reason: e.reason } : {}), ...(via ? { via } : {}) }
  })
}
