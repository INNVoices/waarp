import type { Group, GroupPolicy, Settings, TunnelHealth } from './types'

export const isGroupId = (id: string): boolean => id.startsWith('g-')
export const newGroupId = (): string => 'g-' + Math.random().toString(36).slice(2, 10)
export const grpTag = (id: string): string => 'grp-' + id
export const POLICIES: GroupPolicy[] = ['fastest', 'first']

export interface LiveGroup { id: string; name: string; policy: GroupPolicy; members: string[] }

/** Hold a healthy selection; fail over only after confirmed failure. Never fall back to direct. */
export function firstAlive(members: string[], current: string, health: Record<string, TunnelHealth>): string {
  // `busy` means another client owns this credential, so Waarp cannot use it. `unknown` is not a
  // verified live choice either. Hold only a working/degraded session to avoid needless IP churn.
  if (members.includes(current) && (health[current] === 'ok' || health[current] === 'degraded')) return current
  return members.find(id => health[id] === 'ok') ?? current
}

/** W2.2 anti-flap for 'fastest': a working selection is sticky. Switch only when it stops working, or when another
 *  member is clearly faster (by max(150 ms, 50 %)) for SLOW_ROUNDS probe rounds in a row (~75 s at 15 s rounds).
 *  A few ms of difference never moves a session; never falls back to direct. */
export const SLOW_ROUNDS = 5, SLOW_MS = 150
export function stickyFastest(members: string[], current: string, health: Record<string, TunnelHealth>, pings: Record<string, number | undefined>, streak: number): { next: string; streak: number } {
  const alive = members.filter(id => health[id] === 'ok' && pings[id] !== undefined).sort((a, b) => pings[a]! - pings[b]!)
  const best = alive[0]
  const holding = members.includes(current) && (health[current] === 'ok' || health[current] === 'degraded')
  if (!holding) return { next: best ?? current, streak: 0 }
  const cur = pings[current]
  if (!best || best === current || cur === undefined) return { next: current, streak: 0 }
  const clearlySlower = cur - pings[best]! > Math.max(SLOW_MS, pings[best]! * 0.5)
  const n = clearlySlower ? streak + 1 : 0
  return n >= SLOW_ROUNDS ? { next: best, streak: 0 } : { next: current, streak: n }
}

/** W2.3 Auto: a built-in sticky group over the user's own connections. Never public nodes (low trust), never
 *  revoked ones, never Direct. Picks like 'fastest' (stickyFastest): hold a working member, fail over on confirmed
 *  failure, switch for speed only on a sustained clear gap. Not persisted: synthesized wherever groups are read. */
export const AUTO_ID = 'g-auto'
export type AutoSource = { id: string; revoked?: boolean; source?: string; kind?: string }
export function autoMembers(profiles: AutoSource[]): string[] {
  return profiles.filter(p => !p.revoked && p.source !== 'public' && p.kind !== 'group').map(p => p.id)
}
/** `live` (runtime callers only): the bounded Auto live pool; without it Auto = the full logical membership */
export function withAuto<T extends Pick<Settings, 'rest' | 'routes' | 'groups'>>(s: T, profiles: AutoSource[], live?: readonly string[]): T {
  const used = s.rest === AUTO_ID || s.routes.some(r => r.via === AUTO_ID || r.fallback === AUTO_ID)
  const groups = (s.groups ?? []).filter(g => g.id !== AUTO_ID)
  if (!used) return groups.length === (s.groups ?? []).length ? s : { ...s, groups }
  const all = autoMembers(profiles)
  const members = live ? live.filter(id => all.includes(id)) : all
  return { ...s, groups: [...groups, { id: AUTO_ID, name: 'Авто', policy: 'fastest', members }] }
}

/** R5: the tunnel-closed checker loads at most this many profiles per round: explicitly required first (capped),
 *  then a rotating slice of the rest. Unloaded profiles are unmeasured, never failures. */
export const CHECK_BUDGET = 8
export function checkSample(required: string[], all: string[], cursor: number, budget = CHECK_BUDGET): { ids: string[]; cursor: number } {
  const req = [...new Set(required)].filter(id => all.includes(id)).slice(0, budget)
  const idle = all.filter(id => !req.includes(id))
  const take = Math.min(idle.length, budget - req.length)
  const at = idle.length ? cursor % idle.length : 0
  return { ids: [...req, ...Array.from({ length: take }, (_, i) => idle[(at + i) % idle.length])], cursor: idle.length ? (at + take) % idle.length : 0 }
}

/** R5: how many Auto-only profiles the running core instantiates at most (memory/handles stay bounded). */
export const AUTO_LIVE_MAX = 16
/** R5: the runtime Auto live pool. Logical Auto membership is unchanged; the core gets: the previous in-process Auto
 *  pick (if still eligible), every Auto candidate already live for explicit routing (no extra cost), then up to
 *  `max` Auto-only candidates in stable library order. Deterministic: no random, no rotation on restart/resume. */
export function autoLivePool(profiles: AutoSource[], required: Iterable<string>, prev?: string, max = AUTO_LIVE_MAX): string[] {
  const cands = autoMembers(profiles)
  const req = new Set(required)
  const free = cands.filter(id => req.has(id))
  const extra: string[] = []
  if (prev && cands.includes(prev) && !req.has(prev)) extra.push(prev)
  for (const id of cands) { if (extra.length >= max) break; if (!req.has(id) && !extra.includes(id)) extra.push(id) }
  const head = prev && cands.includes(prev) ? [prev] : []
  return [...new Set([...head, ...free, ...extra])]
}

/** W2 B: Auto probing has a fixed budget per round, not library size. The current member is always probed;
 *  challengers rotate through the rest so the whole library is sampled over rounds. Members outside this round's
 *  sample are simply unmeasured (never failures) and cannot be switched to. */
export const AUTO_BUDGET = 8
export function autoSample(members: string[], current: string | undefined, cursor: number, budget = AUTO_BUDGET): { probe: string[]; cursor: number } {
  const has = !!current && members.includes(current)
  const rest = members.filter(m => m !== current)
  const take = Math.max(0, Math.min(rest.length, budget - (has ? 1 : 0)))
  const at = rest.length ? cursor % rest.length : 0
  const picked = Array.from({ length: take }, (_, i) => rest[(at + i) % rest.length])
  return { probe: [...(has ? [current as string] : []), ...picked], cursor: rest.length ? (at + take) % rest.length : 0 }
}

/** groups used by the settings (global mode or an active card) whose members still exist; `all` = every group with a member */
export function liveGroups(s: Pick<Settings, 'rest' | 'routes' | 'groups'>, have: Set<string>, all = false): LiveGroup[] {
  const want = new Set([s.rest, ...s.routes.filter(r => r.on).map(r => r.via)])
  return (s.groups ?? [])
    .filter(g => all || want.has(g.id))
    .map((g): LiveGroup => ({ id: g.id, name: g.name, policy: g.policy, members: [...new Set(g.members.filter(m => have.has(m)))] }))
    .filter(g => g.members.length > 0)
}

export const groupName = (groups: Group[], n = groups.length + 1): string => {
  const taken = new Set(groups.map(g => g.name))
  let i = n
  while (taken.has('Группа ' + i)) i++
  return 'Группа ' + i
}
