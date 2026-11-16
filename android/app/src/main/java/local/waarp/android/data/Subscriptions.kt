// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

data class SubscriptionMerge(val profiles: List<TunnelProfile>, val updated: Int, val added: Int, val missing: Int)

object Subscriptions {
    /** Endpoint rotation preserves a route only for unique identities; ambiguous provider entries never steal IDs. */
    fun reconcile(old: List<TunnelProfile>, incoming: ImportResult, subscription: String): SubscriptionMerge {
        require(incoming.skipped == 0) { "Подписка прочитана не полностью. Сохранённые профили оставлены без изменений." }
        require(incoming.profiles.isNotEmpty()) { "Подписка не вернула поддерживаемых профилей; сохранённые данные оставлены" }
        val prior = old.withIndex().filter { it.value.subscription == subscription }
        val fresh = incoming.profiles.distinctBy(ProfileImporter::identity)
        val matches = mutableMapOf<Int, TunnelProfile>(); val consumed = mutableSetOf<String>()
        fun unique(oldKey: (TunnelProfile) -> String, newKey: (TunnelProfile) -> String, legacyOnly: Boolean = false) {
            val before = prior.filter { it.index !in matches }.groupBy { oldKey(it.value) }
            val after = fresh.filter { it.id !in consumed }.groupBy(newKey)
            before.forEach { (key, records) ->
                val next = after[key]
                if (records.size == 1 && next?.size == 1 && (!legacyOnly || records.single().value.subscriptionKey == null)) {
                    matches[records.single().index] = next.single(); consumed.add(next.single().id)
                }
            }
        }
        unique(ProfileImporter::identity, ProfileImporter::identity)
        unique({ it.subscriptionKey ?: ProfileImporter.subscriptionKey(it) }, ProfileImporter::subscriptionKey)
        unique(ProfileImporter::credentialIdentity, ProfileImporter::credentialIdentity, legacyOnly = true)
        var updated = 0; var missing = 0
        val result = old.mapIndexed { index, before ->
            if (before.subscription != subscription) before
            else matches[index]?.let { next ->
                updated++; next.copy(id = before.id, name = before.name, addedAt = before.addedAt, source = before.source,
                    revoked = before.revoked, subscription = subscription, subscriptionKey = ProfileImporter.subscriptionKey(next), subscriptionMissing = false)
            } ?: before.copy(subscriptionMissing = true).also { missing++ }
        }.toMutableList()
        val known = result.map(ProfileImporter::identity).toMutableSet(); var added = 0
        fresh.filter { it.id !in consumed }.forEach { profile ->
            if (known.add(ProfileImporter.identity(profile))) {
                result.add(profile.copy(subscription = subscription, subscriptionKey = ProfileImporter.subscriptionKey(profile))); added++
            }
        }
        require(result.size <= MAX_PROFILES) { "В подписке слишком много профилей" }
        return SubscriptionMerge(result, updated, added, missing)
    }
}
