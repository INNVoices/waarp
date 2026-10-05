import type { Group, Profile, Route, Settings, Via } from './types'
import { AUTO_ID, withAuto, type AutoSource } from './groups'

export type PlanScope = 'cards' | 'computer'
export type PlanRole = 'primary' | 'standby'

export interface PlannedRoute {
  id: string
  name: string
  kind: Route['kind']
  target: Via
  resolved: boolean
  fallback?: Via
  fallbackResolved: boolean
}

export interface RoutePlan {
  scope: PlanScope
  final: Via
  routes: PlannedRoute[]
  requiredProfiles: string[]
  standbyProfiles: string[]
  liveGroups: string[]
  blockedTargets: string[]
  warnings: string[]
  canStart: boolean
}

/**
 * Authoritative, side-effect-free interpretation of persisted routing state.
 * UI summaries, guards and engine configuration must consume this plan rather
 * than independently walking settings.
 */
export function compilePlan(given: Settings, profiles: (Pick<Profile, 'id' | 'revoked'> & AutoSource)[], opts: { autoLive?: readonly string[] } = {}): RoutePlan {
  // without autoLive: the logical plan (full Auto membership); with it: the runtime plan the core is built from
  const settings = withAuto(given, profiles, opts.autoLive)
  const available = new Set(profiles.filter(p => !p.revoked).map(p => p.id))
  const groups = new Map((settings.groups ?? []).map(g => [g.id, g]))
  const required = new Set<string>()
  const standby = new Set<string>()
  const liveGroups = new Set<string>()
  const blocked = new Set<string>()
  const warnings = new Set<string>()

  const resolve = (via: Via, role: PlanRole): boolean => {
    if (via === 'direct') return true
    if (available.has(via)) {
      ;(role === 'primary' ? required : standby).add(via)
      return true
    }
    const group = groups.get(via)
    if (!group) {
      if (role === 'primary') blocked.add(via)
      else warnings.add(`standby-missing:${via}`)
      return false
    }
    const members = uniqueMembers(group, available)
    if (!members.length) {
      if (role === 'primary') blocked.add(via)
      else warnings.add(`standby-empty:${via}`)
      return false
    }
    liveGroups.add(group.id)
    // Auto members are candidates, not all required at once: the engine probes a bounded sample and the guard
    // must not refuse to start because one candidate key is busy elsewhere
    for (const id of members) (role === 'primary' && group.id !== AUTO_ID ? required : standby).add(id)
    return true
  }

  const scope: PlanScope = settings.rest === 'direct' ? 'cards' : 'computer'
  resolve(settings.rest, 'primary')
  const routes: PlannedRoute[] = settings.routes.filter(r => r.on).map(r => {
    const resolved = resolve(r.via, 'primary')
    let fallback: Via | undefined
    let fallbackResolved = true
    if (r.fallback && r.fallback !== 'direct' && r.fallback !== r.via) {
      fallback = r.fallback
      fallbackResolved = resolve(fallback, 'standby')
    }
    return { id: r.id, name: r.name, kind: r.kind, target: r.via, resolved, fallback, fallbackResolved }
  })

  // A profile cannot be described as standby if another active route needs it now.
  for (const id of required) standby.delete(id)
  const demandsTunnel = settings.rest !== 'direct' || routes.some(r => r.target !== 'direct')
  return {
    scope,
    final: settings.rest,
    routes,
    requiredProfiles: [...required],
    standbyProfiles: [...standby],
    liveGroups: [...liveGroups],
    blockedTargets: [...blocked],
    warnings: [...warnings],
    // Missing protected targets are representable as reject rules, so starting preserves fail-closed behavior.
    canStart: demandsTunnel
  }
}

function uniqueMembers(group: Group, available: Set<string>): string[] {
  return [...new Set(group.members.filter(id => available.has(id)))]
}

export function planProfileIds(plan: RoutePlan, includeStandby = true): string[] {
  return includeStandby ? [...new Set([...plan.requiredProfiles, ...plan.standbyProfiles])] : plan.requiredProfiles
}
