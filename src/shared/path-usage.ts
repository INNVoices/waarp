import type { Settings, Via } from './types'

/** a tunnel or group is gone (C03): its cards get the chosen replacement, or keep pointing at the
 *  missing id -> the config compiles that to BLOCK (never silently direct). A fallback to it is cleared. */
function dropVia(s: Settings, id: string, replace?: Via): Settings {
  const to = (v: Via) => (v === id && replace ? replace : v)
  return {
    ...s,
    rest: to(s.rest),
    serviceVia: s.serviceVia === id && replace && !replace.startsWith('g-') ? replace : s.serviceVia,
    routes: s.routes.map(r => {
      const { fallback, ...rest } = r
      const keep = fallback && fallback !== id ? { fallback } : {}
      return { ...rest, via: to(r.via), ...keep }
    }),
    allVia: s.allVia === id ? (replace && replace !== 'direct' ? replace : undefined) : s.allVia
  }
}

/** cards / "rest" that use this tunnel or group: shown before deleting it */
export function usersOf(s: Settings, id: string): { cards: string[]; rest: boolean; all: boolean; service?: boolean } {
  const affected = new Set([id, ...(s.groups ?? []).filter(g => g.members.includes(id)).map(g => g.id)])
  return {
    cards: s.routes.filter(r => affected.has(r.via) || (!!r.fallback && affected.has(r.fallback))).map(r => r.name),
    rest: affected.has(s.rest),
    all: !!s.allVia && affected.has(s.allVia),
    ...(s.serviceVia === id ? { service: true } : {})
  }
}

/** a tunnel is removed: it leaves every group, a group left without members is removed too */
export function dropServer(s: Settings, id: string, replace?: Via): Settings {
  const groups = (s.groups ?? []).map(g => ({ ...g, members: g.members.filter(m => m !== id) }))
  let out: Settings = { ...dropVia(s, id, replace), groups: groups.filter(g => g.members.length > 0) }
  for (const g of groups.filter(g => g.members.length === 0)) out = dropVia(out, g.id, replace)
  return out
}

export function dropGroup(s: Settings, id: string, replace?: Via): Settings {
  return { ...dropVia(s, id, replace), groups: (s.groups ?? []).filter(g => g.id !== id) }
}
