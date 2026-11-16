import { credentialKey } from '../src/main/discovery'
import { parseLink } from '../src/main/links'
import { parseVless } from '../src/main/vless'
import { reconcileSubscription, subscriptionEntryKey, type SubscriptionProfile } from '../src/main/subscription'

let n = 0
const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); n++ }
const SUB = 'https://subscription.example.test/synthetic-token'
const fresh = (host: string, name = 'Same provider name'): SubscriptionProfile => parseLink(`trojan://synthetic-password@${host}:443?sni=cdn.example.test#${encodeURIComponent(name)}`) as SubscriptionProfile
const saved = (host: string, id: string, localName?: string): SubscriptionProfile => {
  const p = fresh(host)
  return { ...p, id, sub: SUB, subKey: subscriptionEntryKey(p), name: localName ?? p.name, addedAt: 123 }
}
const hostOf = (p: SubscriptionProfile) => p.kind === 'vless' ? p.vless.server : p.host

const a = saved('a.example.test', 'saved-a')
const b = saved('b.example.test', 'saved-b')
const exact = reconcileSubscription([a, b], [fresh('b.example.test'), fresh('a.example.test')], SUB)
ok(exact.updated === 2 && exact.added === 0 && exact.missing === 0, 'equal names/credentials at separate endpoints reconcile without collapsing')
ok(hostOf(exact.profiles[0] as SubscriptionProfile) === 'a.example.test' && hostOf(exact.profiles[1] as SubscriptionProfile) === 'b.example.test', 'both old route ids still refer to the correct endpoint')

const ambiguous = reconcileSubscription([a, b], [fresh('c.example.test'), fresh('d.example.test')], SUB)
ok(ambiguous.updated === 0 && ambiguous.missing === 2 && ambiguous.added === 2 && ambiguous.profiles.length === 4, 'ambiguous replacement keeps both old profiles and exposes both new candidates')
ok((ambiguous.profiles[0] as SubscriptionProfile).subMissing && hostOf(ambiguous.profiles[0] as SubscriptionProfile) === 'a.example.test', 'ambiguous old route is marked missing without overwriting its endpoint')
const oneForTwo = reconcileSubscription([a, b], [fresh('c.example.test')], SUB)
ok(oneForTwo.updated === 0 && oneForTwo.missing === 2 && oneForTwo.added === 1, 'one incoming candidate cannot be consumed by two old profiles')

const partial = reconcileSubscription([a, b], [fresh('a.example.test'), fresh('c.example.test')], SUB)
ok(partial.updated === 2 && hostOf(partial.profiles[1] as SubscriptionProfile) === 'c.example.test', 'exact match disambiguates the remaining single endpoint rotation')
const local = { ...saved('old.example.test', 'local-id', 'My local name'), source: 'public' as const, revoked: true }
const rotated = reconcileSubscription([local], [fresh('new.example.test')], SUB).profiles[0] as SubscriptionProfile
ok(rotated.id === 'local-id' && rotated.name === 'My local name' && rotated.addedAt === 123 && rotated.source === 'public' && rotated.revoked === true, 'rotation preserves local identity, display name and trust/revocation policy')
ok(hostOf(rotated) === 'new.example.test' && !rotated.subMissing, 'unambiguous provider rotation updates the connection')

const legacy = { ...saved('legacy.example.test', 'legacy-id', 'Local rename'), subKey: undefined }
const legacyNext = reconcileSubscription([legacy], [fresh('rotated.example.test', 'Provider renamed')], SUB)
ok(legacyNext.updated === 1 && legacyNext.profiles[0].id === 'legacy-id', 'legacy unique credential recovers the local rename')
const blockedLegacy = reconcileSubscription([legacy, b], [fresh('third.example.test', 'Provider renamed')], SUB)
ok(blockedLegacy.updated === 0 && blockedLegacy.missing === 2, 'legacy recovery does not steal a candidate shared with another unresolved profile')

const manual = { ...fresh('manual.example.test'), id: 'manual', source: 'personal' as const }
const otherSub = { ...a, id: 'other-sub', sub: 'https://other.example.test/sub' }
const isolated = reconcileSubscription([manual, otherSub], [fresh('manual.example.test')], SUB)
ok(isolated.profiles[0] === manual && isolated.profiles[1] === otherSub && isolated.added === 0, 'subscription does not reclassify or duplicate a manual connection or another subscription')
const duplicates = reconcileSubscription([], [fresh('same.example.test', 'Alias A'), fresh('same.example.test', 'Alias B')], SUB)
ok(duplicates.added === 1, 'equivalent incoming configs are deduplicated despite display aliases')
const oldBefore = JSON.stringify([a, b]), input = [fresh('c.example.test')], incomingBefore = JSON.stringify(input)
reconcileSubscription([a, b], input, SUB)
ok(JSON.stringify([a, b]) === oldBefore && JSON.stringify(input) === incomingBefore, 'reconciliation does not mutate caller snapshots')

const uuid = '11111111-2222-3333-4444-555555555555'
const tcp = parseVless(`vless://${uuid}@same.example.test:443?type=tcp&security=tls&sni=cdn.example.test`)
const ws = parseVless(`vless://${uuid}@same.example.test:443?type=ws&security=tls&sni=cdn.example.test&path=%2Fws`)
const differentSni = parseVless(`vless://${uuid}@same.example.test:443?type=tcp&security=tls&sni=other.example.test`)
ok(credentialKey(tcp) !== credentialKey(ws), 'same VLESS endpoint/credential with TCP and WebSocket stays two different connections')
ok(credentialKey(tcp) !== credentialKey(differentSni), 'peer verification settings are part of effective identity')
ok(credentialKey(tcp) === credentialKey({ ...tcp, id: 'other-id', name: 'Renamed', source: 'public', revoked: true }), 'display and trust metadata are excluded from effective identity')
const out = fresh('order.example.test')
if (out.kind !== 'out') throw new Error('fixture type')
ok(credentialKey(out) === credentialKey({ ...out, outbound: Object.fromEntries(Object.entries(out.outbound).reverse()) }), 'JSON property insertion order does not change effective identity')
ok(!credentialKey(out).includes('synthetic-password'), 'deduplication fingerprint does not carry raw credentials')

console.log(`subscription.check: ${n} checks`)
