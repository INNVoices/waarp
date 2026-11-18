import countries from './atlas-countries.json'
import type { ProfileView, Status } from './types'

/** These are Natural Earth label anchors for regions, never endpoint/IP locations. */
export interface CountryAnchor { name: string; longitude: number; latitude: number }
const anchors: Readonly<Record<string, CountryAnchor>> = countries
export const ATLAS_UNKNOWN = '??'

export interface AtlasCountry {
  country: string
  total: number
  ready: number
  failed: number
}
export interface AtlasProjection { countries: AtlasCountry[]; total: number; unknown: number }
export interface AtlasCandidate { country?: string; status?: string }

export function atlasCountry(value: unknown): string {
  if (typeof value !== 'string') return ATLAS_UNKNOWN
  const code = value.trim().toUpperCase()
  return Object.hasOwn(anchors, code) ? code : ATLAS_UNKNOWN
}
export function countryAnchor(value: unknown): CountryAnchor | undefined {
  return anchors[atlasCountry(value)]
}
export const countryCodes = (): string[] => Object.keys(anchors)

/** O(n) input, at most one item per region. No endpoint or credential reaches map data. */
export function projectAtlas(nodes: readonly AtlasCandidate[]): AtlasProjection {
  const groups = new Map<string, AtlasCountry>()
  for (const node of nodes) {
    const country = atlasCountry(node.country)
    const item = groups.get(country) ?? { country, total: 0, ready: 0, failed: 0 }
    item.total++
    if (node.status === 'ready') item.ready++
    else if (node.status === 'failed') item.failed++
    groups.set(country, item)
  }
  return { countries: [...groups.values()].sort((a, b) => a.country.localeCompare(b.country)),
    total: nodes.length, unknown: groups.get(ATLAS_UNKNOWN)?.total ?? 0 }
}

/** A stopped engine's old pings are not current availability. Groups have no location. */
export function profileAtlas(profiles: readonly ProfileView[], status: Status): AtlasProjection {
  return projectAtlas(profiles.map(profile => ({ country: profile.kind === 'group' ? undefined : profile.country,
    status: status.phase === 'on' && !profile.revoked && status.health?.[profile.id] === 'ok' ? 'ready'
      : status.phase === 'on' && status.health?.[profile.id] === 'down' ? 'failed' : 'unverified' })))
}
