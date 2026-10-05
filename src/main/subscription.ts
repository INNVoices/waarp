import type { Profile } from '../shared/types'

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
