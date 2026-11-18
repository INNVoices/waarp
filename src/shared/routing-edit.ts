import type { Settings } from './types'

/** Metadata and disabled records do not participate in the active routing plan.
 * Preserve the order of active rules and group members: both affect precedence.
 * This is an equality fast path, not a substitute for the engine's live apply. */
export function sameEffectiveRouting(before: Settings, after: Settings): boolean {
  const signature = (s: Settings) => {
    const routes = s.routes.filter(r => r.on)
    const referenced = new Set([s.rest, ...routes.flatMap(r => [r.via, r.fallback].filter((v): v is string => !!v))])
    return JSON.stringify({
      rest: s.rest, ruDirect: s.ruDirect, dnsAll: s.dnsAll, lanDirect: s.lanDirect,
      routes: routes.map(({ name: _name, ...rule }) => rule),
      groups: s.groups.filter(g => referenced.has(g.id))
        .map(({ name: _name, ...group }) => group).sort((a, b) => a.id.localeCompare(b.id))
    })
  }
  return signature(before) === signature(after)
}
