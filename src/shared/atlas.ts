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
  /** Fastest fresh HTTP response in this region, never a geographical distance. */
  bestPing?: number
}
export interface AtlasProjection { countries: AtlasCountry[]; total: number; unknown: number }
export interface AtlasCandidate { country?: string; status?: string; ping?: number }

export function atlasCountry(value: unknown): string {
  if (typeof value !== 'string') return ATLAS_UNKNOWN
  const code = value.trim().toUpperCase()
  return Object.hasOwn(anchors, code) ? code : ATLAS_UNKNOWN
}
export function countryAnchor(value: unknown): CountryAnchor | undefined {
  return anchors[atlasCountry(value)]
}
export const countryCodes = (): string[] => Object.keys(anchors)

const countryNames = ['ru', 'en'].flatMap(locale => {
  const names = new Intl.DisplayNames([locale], { type: 'region' })
  return countryCodes().map(code => [names.of(code)?.toLocaleLowerCase() ?? '', code] as [string, string])
}).concat(Object.entries({ usa: 'US', america: 'US', england: 'GB', britain: 'GB', deutschland: 'DE', holland: 'NL',
  'hong kong': 'HK', korea: 'KR', uae: 'AE', czech: 'CZ', 'türkiye': 'TR' })).sort((a, b) => b[0].length - a[0].length)

const nameCountries = new Map<string, string>()
/** Source labels only. No IP lookup and no invented location for arbitrary names.
 * Catalogue progress reprojects thousands of identical labels; cache bounded,
 * short labels so that the main process does not repeat all language lookups. */
export function countryFromName(name: string): string {
  const cached = nameCountries.get(name)
  if (cached !== undefined) return cached
  const result = inferCountry(name)
  if (name.length <= 256) {
    if (nameCountries.size >= 20_000) nameCountries.delete(nameCountries.keys().next().value!)
    nameCountries.set(name, result)
  }
  return result
}

function inferCountry(name: string): string {
  const flag = /[\u{1F1E6}-\u{1F1FF}]{2}/u.exec(name)?.[0]
  if (flag) {
    const code = [...flag].map(letter => String.fromCharCode(letter.codePointAt(0)! - 0x1f1e6 + 65)).join('')
    if (atlasCountry(code) !== ATLAS_UNKNOWN) return code
  }
  const lower = name.toLocaleLowerCase()
  for (const [label, code] of countryNames) {
    if (!label) continue
    const index = lower.indexOf(label)
    if (index >= 0 && !/[\p{L}\p{N}]/u.test(lower[index - 1] ?? '') && !/[\p{L}\p{N}]/u.test(lower[index + label.length] ?? '')) return code
  }
  // Avoid a random two-letter substring in a hostname. Codes must be separate,
  // uppercase source labels; a prefix such as DE-123 is common in subscriptions.
  for (const match of name.matchAll(/(?:^|[\s|_\-([【])([A-Z]{2})(?=$|[\s|_\-)\]】\d])/g)) {
    if (atlasCountry(match[1]) !== ATLAS_UNKNOWN) return match[1]
  }
  return ATLAS_UNKNOWN
}

export function profileCountry(profile: { kind: string; name: string; country?: string }): string {
  if (profile.kind === 'group') return ATLAS_UNKNOWN
  const code = atlasCountry(profile.country)
  return code === ATLAS_UNKNOWN ? countryFromName(profile.name) : code
}

/** O(n) input, at most one item per region. No endpoint or credential reaches map data. */
export function projectAtlas(nodes: readonly AtlasCandidate[]): AtlasProjection {
  const groups = new Map<string, AtlasCountry>()
  for (const node of nodes) {
    const country = atlasCountry(node.country)
    const item = groups.get(country) ?? { country, total: 0, ready: 0, failed: 0 }
    item.total++
    if (node.status === 'ready') {
      item.ready++
      if (typeof node.ping === 'number' && Number.isFinite(node.ping) && node.ping >= 0)
        item.bestPing = Math.min(item.bestPing ?? Infinity, node.ping)
    }
    else if (node.status === 'failed') item.failed++
    groups.set(country, item)
  }
  return { countries: [...groups.values()].sort((a, b) => a.country.localeCompare(b.country)),
    total: nodes.length, unknown: groups.get(ATLAS_UNKNOWN)?.total ?? 0 }
}

/** A stopped engine's old pings are not current availability. Groups have no location. */
export function profileAtlas(profiles: readonly ProfileView[], status: Status): AtlasProjection {
  return projectAtlas(profiles.map(profile => ({ country: profileCountry(profile), ping: status.pings[profile.id],
    status: status.phase === 'on' && !profile.revoked && status.health?.[profile.id] === 'ok' ? 'ready'
      : status.phase === 'on' && status.health?.[profile.id] === 'down' ? 'failed' : 'unverified' })))
}
