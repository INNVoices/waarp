// W3.3 per-network memory (pure). Remembers, per network fingerprint, which targets were restricted on Direct and
// which own paths opened them. Bounded (512 entries per network, LRU), expires (24 h), never stores IPs or public
// nodes. It only ORDERS Auto candidates for a target; it never creates routes, never picks Direct, and an `unclear`
// finding teaches nothing (fail closed on ambiguity).
import type { Finding, Layer } from './evidence'

export const MEM_TTL_MS = 24 * 3600_000, MEM_MAX = 512
export interface MemEntry { layer?: Layer; worked: string[]; at: number }
export type NetMemory = Record<string, Record<string, MemEntry>> // network -> host -> entry

/** learn from one diagnosis; `eligible` = own non-public paths (anything else is dropped) */
export function learn(mem: NetMemory, net: string, host: string, f: Finding, eligible: string[], now: number): NetMemory {
  if (f.kind !== 'restricted_direct' && f.kind !== 'path_only') {
    // direct_ok / site_down clear what we knew; unclear changes nothing
    if (f.kind === 'unclear' || !mem[net]?.[host]) return mem
    const { [host]: _gone, ...rest } = mem[net]
    return { ...mem, [net]: rest }
  }
  const ok = new Set(eligible)
  const worked = f.via.filter(id => ok.has(id))
  if (!worked.length) return mem
  const entries = { ...(mem[net] ?? {}), [host]: { ...(f.kind === 'restricted_direct' ? { layer: f.layer } : {}), worked, at: now } }
  // LRU by `at`, drop expired first
  const live = Object.entries(entries).filter(([, e]) => now - e.at < MEM_TTL_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MEM_MAX)
  return { ...mem, [net]: Object.fromEntries(live) }
}

/** Auto candidate order for a target on this network: paths that worked here first (in their order), then the rest
 *  unchanged. Expired or unknown -> the given order. Only reorders; the set never changes. */
export function orderFor(mem: NetMemory, net: string, host: string, members: string[], now: number): string[] {
  const e = mem[net]?.[host]
  if (!e || now - e.at >= MEM_TTL_MS) return members
  const known = e.worked.filter(id => members.includes(id))
  return [...known, ...members.filter(id => !known.includes(id))]
}

/** ids that carry traffic now: the plan's required profiles, each group's / Auto's picked member, and every route's
 *  effective path when it is a real profile id. Auto standby candidates are NOT "in use". */
export function activeIds(required: string[], picked: Record<string, string> | undefined, effective: (string | undefined)[], profileIds: Set<string>): Set<string> {
  return new Set([...required, ...Object.values(picked ?? {}), ...effective].filter((id): id is string => !!id && profileIds.has(id)))
}

/** drop expired entries in every network bucket (TTL holds on disk too) and empty buckets */
export function pruneMem(mem: NetMemory, now: number): NetMemory {
  const out: NetMemory = {}
  for (const [net, hosts] of Object.entries(mem)) {
    const live = Object.entries(hosts).filter(([, e]) => now - e.at < MEM_TTL_MS).sort((a, b) => b[1].at - a[1].at).slice(0, MEM_MAX)
    if (live.length) out[net] = Object.fromEntries(live)
  }
  return out
}

/** persisted memory is untrusted input: keep only well-formed entries, anything else is ignored */
export function parseMem(raw: unknown): NetMemory {
  const out: NetMemory = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [net, hosts] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-9a-f]{32}$/.test(net) || !hosts || typeof hosts !== 'object' || Array.isArray(hosts)) continue
    const ok: Record<string, MemEntry> = {}
    for (const [host, e] of Object.entries(hosts as Record<string, unknown>)) {
      const v = e as Partial<MemEntry> | null
      if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !v || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue
      if (!Array.isArray(v.worked) || !v.worked.length || v.worked.length > 32 || !v.worked.every(w => typeof w === 'string' && w.length <= 80 && w !== 'direct')) continue
      if (v.layer !== undefined && !['dns', 'tcp', 'tls', 'http'].includes(v.layer)) continue
      ok[host] = { ...(v.layer ? { layer: v.layer } : {}), worked: v.worked, at: v.at }
    }
    if (Object.keys(ok).length) out[net] = ok
  }
  return out
}

/** W3.3b: which own paths one diagnosis checks, in order: known-good for this target on this network first (memory),
 *  then paths in use, then the rest; capped at `budget`. No network fingerprint -> no memory input at all. */
export function diagnosisSet(own: string[], used: Set<string>, mem: NetMemory, net: string | undefined, host: string, now: number, budget: number): string[] {
  const base = [...own.filter(id => used.has(id)), ...own.filter(id => !used.has(id))]
  return (net ? orderFor(mem, net, host, base, now) : base).slice(0, budget)
}
