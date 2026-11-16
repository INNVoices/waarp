import type { Profile } from '../shared/types'
import { credentialKey } from './discovery'

export type SubscriptionProfile = Extract<Profile, { kind: 'vless' | 'out' }>

/** Credential/transport identity is used only as a unique fallback for profiles saved before subKey existed. */
export function subscriptionCredentialKey(p: SubscriptionProfile): string {
  if (p.kind === 'vless') return `vless|${p.vless.uuid}|${p.vless.network}|${p.vless.security}`
  const o = p.outbound
  const credential = o.uuid ?? o.password ?? o.username
  const transport = o.transport && typeof o.transport === 'object' ? (o.transport as Record<string, unknown>).type ?? '' : ''
  return `${String(o.type)}|${String(credential ?? '')}|${String(transport)}`
}

/** Stored before a user can rename the profile; stable across local rename and provider endpoint rotation. */
export function subscriptionEntryKey(p: SubscriptionProfile): string {
  return `${subscriptionCredentialKey(p)}|${p.name}`
}

/** Merge one successful response without assigning an ambiguous server to an existing route's stable id. */
export function reconcileSubscription(oldProfiles: Profile[], incoming: SubscriptionProfile[], sub: string): { profiles: Profile[]; updated: number; added: number; missing: number } {
  const prior = oldProfiles.flatMap((p, index) => (p.kind === 'vless' || p.kind === 'out') && p.sub === sub ? [{ profile: p, index }] : [])
  const unique = new Map<string, SubscriptionProfile>()
  for (const profile of incoming) {
    const key = credentialKey(profile)
    if (!unique.has(key)) unique.set(key, profile)
  }
  const fresh = [...unique.values()]
  const matches = new Map<number, SubscriptionProfile>()
  const consumed = new Set<SubscriptionProfile>()
  const bucket = <T>(items: T[], keyOf: (value: T) => string): Map<string, T[]> => {
    const result = new Map<string, T[]>()
    for (const value of items) { const key = keyOf(value); result.set(key, [...(result.get(key) ?? []), value]) }
    return result
  }
  const matchUnique = (oldKey: (p: SubscriptionProfile) => string, newKey: (p: SubscriptionProfile) => string, legacyOnly = false) => {
    const oldByKey = bucket(prior.filter(x => !matches.has(x.index)), x => `${x.profile.kind}\0${oldKey(x.profile)}`)
    const newByKey = bucket(fresh.filter(p => !consumed.has(p)), p => `${p.kind}\0${newKey(p)}`)
    for (const [key, old] of oldByKey) {
      const next = newByKey.get(key)
      if (old.length !== 1 || next?.length !== 1 || (legacyOnly && old[0].profile.subKey)) continue
      matches.set(old[0].index, next[0]); consumed.add(next[0])
    }
  }
  // First preserve exact endpoints/configs, even when several nodes share the same provider name and UUID.
  matchUnique(credentialKey, credentialKey)
  // Provider endpoint rotation is safe only for one old entry and one new entry with that stable key.
  matchUnique(p => p.subKey ?? subscriptionEntryKey(p), subscriptionEntryKey)
  // Older saves predate subKey; recover a local rename only when the credential matches uniquely on both sides.
  matchUnique(subscriptionCredentialKey, subscriptionCredentialKey, true)

  let updated = 0, missing = 0
  const profiles = oldProfiles.map((p, index): Profile => {
    if (!((p.kind === 'vless' || p.kind === 'out') && p.sub === sub)) return p
    const next = matches.get(index)
    if (!next || next.kind !== p.kind) { missing++; return { ...p, subMissing: true } }
    updated++
    return { ...next, id: p.id, name: p.name, addedAt: p.addedAt, source: p.source, revoked: p.revoked,
      sub, subKey: subscriptionEntryKey(next), subMissing: false } as Profile // Matching kinds above preserve each kind's source union.
  })
  const identities = new Set(profiles.map(credentialKey))
  let added = 0
  for (const p of fresh) {
    const key = credentialKey(p)
    if (consumed.has(p) || identities.has(key)) continue
    identities.add(key); added++
    profiles.push({ ...p, sub, subKey: subscriptionEntryKey(p), subMissing: false })
  }
  return { profiles, updated, added, missing }
}
