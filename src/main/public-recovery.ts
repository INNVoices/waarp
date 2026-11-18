import { localized } from '../shared/localization'
import type { Profile } from '../shared/types'
import { publicSourceForUrl } from '../shared/public-sources'
import { credentialKey } from './discovery'
import { CATALOG_FETCH_LIMITS, type CatalogSourceText } from './catalog-fetch'

export interface PublicServicePath { id: string; profile?: Profile; cached?: boolean }
interface PublicServicePathOptions {
  profiles: Profile[]
  cached: Profile[]
  preferred: string
  recent?: string
  loaded?: readonly string[]
  limit?: number
}

const MAX_PATHS = 8
const missing = (profile: Profile) => (profile.kind === 'vless' || profile.kind === 'out') && profile.subMissing
const hostOf = (profile: Profile): string => (profile.kind === 'awg' ? profile.peer.host
  : profile.kind === 'vless' ? profile.vless.server : profile.host).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()

/** These paths are exclusively for public catalog recovery. They are not a
 * fallback policy for private subscription URLs, user traffic or personal data.
 * Cached candidates remain eligible without being declared healthy. When the
 * core is running, loaded IDs prohibit adding another outbound or restarting it. */
export function publicServicePaths(options: PublicServicePathOptions): PublicServicePath[] {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.min(MAX_PATHS, Math.floor(options.limit!))) : MAX_PATHS
  if (!limit) return []
  const loaded = options.loaded === undefined ? undefined : new Set(options.loaded)
  const savedIds = new Set(options.profiles.map(profile => profile.id))
  const entries = [
    ...options.profiles.map(profile => ({ id: profile.id, profile })),
    ...options.cached.filter(profile => !savedIds.has(profile.id)).map(profile => ({ id: profile.id, profile, cached: true }))
  ]
  const blockedIds = new Set<string>(), blockedKeys = new Set<string>()
  for (const { profile } of entries) {
    if (!profile.revoked && !missing(profile)) continue
    blockedIds.add(profile.id)
    try { blockedKeys.add(credentialKey(profile)) } catch { /* malformed saved data is never a recovery path */ }
  }
  const eligible = entries.filter(entry => entry.id && entry.id !== 'direct' && !blockedIds.has(entry.id) && (!loaded || loaded.has(entry.id)))
  const priorities = [options.preferred, options.recent].filter((id): id is string => !!id && id !== 'direct')
  const ordered = [...priorities.flatMap(id => eligible.filter(entry => entry.id === id)), ...eligible]
  const identities = new Set<string>(), ids = new Set<string>()
  const unique: (PublicServicePath & { profile: Profile })[] = []
  for (const entry of ordered) {
    try {
      const key = credentialKey(entry.profile)
      if (ids.has(entry.id) || identities.has(key) || blockedKeys.has(key) || !hostOf(entry.profile)) continue
      ids.add(entry.id); identities.add(key); unique.push(entry)
    } catch { /* corrupt cached profiles must not prevent other paths from being tried */ }
  }

  const out: PublicServicePath[] = options.preferred === 'direct' ? [{ id: 'direct' }] : []
  const picked = new Set<string>()
  const use = (entry: PublicServicePath) => { if (out.length < limit && !picked.has(entry.id)) { out.push(entry); picked.add(entry.id) } }
  for (const id of priorities) {
    const entry = unique.find(candidate => candidate.id === id)
    if (entry) use(entry)
  }
  // Spread each tier over endpoint hosts. Alternate remaining saved/cache
  // slots so a large personal library cannot permanently crowd out recovery
  // candidates. Explicit preferred/recent paths above always keep priority.
  // Host buckets are a diversity heuristic, not an ASN/ownership claim.
  const groups = new Map<string, { used: number; entries: typeof unique }>()
  for (const entry of unique) {
    const host = hostOf(entry.profile)
    const group = groups.get(host) ?? { used: 0, entries: [] }
    if (picked.has(entry.id)) group.used++
    else group.entries.push(entry)
    groups.set(host, group)
  }
  let preferCached = false
  while (out.length < limit) {
    const available = [...groups.values()].filter(group => group.entries.length)
    const tier = available.filter(group => group.entries.some(entry => !!entry.cached === preferCached))
    const next = (tier.length ? tier : available).sort((a, b) => a.used - b.used)[0]
    if (!next) break
    const preferredIndex = next.entries.findIndex(entry => !!entry.cached === preferCached)
    use(next.entries.splice(preferredIndex < 0 ? 0 : preferredIndex, 1)[0]); next.used++
    preferCached = !preferCached
  }
  return out
}

interface PublicRecoveryOptions {
  budgetMs?: number
  perPathMs?: number
  now?: () => number
  onSuccess?: (id: string) => void
}
type PublicSourceAttempt = (path: PublicServicePath, remainingSources: string[], signal: AbortSignal, budgetMs: number) => Promise<CatalogSourceText[]>

const canonical = (url: string) => publicSourceForUrl(url)?.url ?? url
const boundedMs = (value: number | undefined, fallback: number) => Number.isFinite(value)
  ? Math.max(0, Math.min(fallback, Math.floor(value!))) : fallback

/** Merge independent, already format-validated source responses across public
 * recovery paths. The callback owns its per-path timer/cleanup, must obey signal
 * and budgetMs, and must await verified shutdown before settling. Never race it
 * against cancellation: a still-running owned checker would outlive this task.
 * A path timeout must never abort the caller's shared signal. */
export async function recoverPublicSources(sources: string[], paths: PublicServicePath[], attempt: PublicSourceAttempt,
  signal: AbortSignal, options: PublicRecoveryOptions = {}): Promise<CatalogSourceText[]> {
  signal.throwIfAborted()
  const selected = [...new Set(sources.map(canonical))].slice(0, CATALOG_FETCH_LIMITS.maxSources)
  const wanted = new Set(selected)
  const successful = new Map<string, CatalogSourceText>()
  const failures = new Map<string, CatalogSourceText>()
  const now = options.now ?? (() => performance.now())
  const deadline = now() + boundedMs(options.budgetMs, 90_000)
  const perPath = boundedMs(options.perPathMs, 18_000)
  const tried = new Set<string>()
  for (const path of paths) {
    signal.throwIfAborted()
    if (successful.size === selected.length || tried.size >= MAX_PATHS) break
    if (tried.has(path.id)) continue
    const remainingMs = Math.floor(deadline - now())
    const budgetMs = Math.min(perPath, remainingMs)
    if (budgetMs <= 0) break
    const remaining = selected.filter(url => !successful.has(url))
    tried.add(path.id)
    let rows: CatalogSourceText[]
    try {
      rows = await attempt(path, [...remaining], signal, budgetMs)
    } catch {
      signal.throwIfAborted()
      continue
    }
    signal.throwIfAborted()
    let improved = false
    for (const row of rows) {
      const url = canonical(row.url)
      if (!wanted.has(url) || successful.has(url) || !remaining.includes(url)) continue
      if (typeof row.body === 'string' && row.body.trim()) {
        successful.set(url, { ...row, url }); failures.delete(url); improved = true
      } else failures.set(url, { ...row, url })
    }
    if (improved) {
      try { options.onSuccess?.(path.id) } catch { /* advisory recent-path persistence cannot discard downloaded lists */ }
    }
  }
  signal.throwIfAborted()
  return selected.map(url => successful.get(url) ?? {
    ...failures.get(url), url, error: failures.get(url)?.error ?? localized("winInline.public-recovery.e3ce58d2fbbb")
  })
}
