package local.waarp.android.data

import org.junit.Assert.*
import org.junit.Test

class SubscriptionsTest {
    private val subscription = "https://provider.example.test/subscription/test-only"
    private val credential = "11111111-2222-3333-4444-555555555555"
    private fun profile(host: String, name: String = "Provider node", tls: Boolean = true): TunnelProfile =
        ProfileImporter.link("vless://$credential@$host:443?security=${if (tls) "tls" else "none"}#${name.replace(" ", "%20")}")
    private fun reconcile(old: List<TunnelProfile>, incoming: List<TunnelProfile>, url: String) =
        Subscriptions.reconcile(old, ImportResult(incoming), url)
    private fun subscribed(profile: TunnelProfile, id: String = "stable-id", legacy: Boolean = false) = profile.copy(
        id = id, subscription = subscription, subscriptionKey = if (legacy) null else ProfileImporter.subscriptionKey(profile), addedAt = 42)

    @Test fun uniqueEndpointRotationPreservesRouteIdentityAndLocalName() {
        val old = subscribed(profile("192.0.2.1")).copy(name = "Locally renamed", source = "managed", revoked = true)
        val fresh = profile("192.0.2.2")
        val merge = reconcile(listOf(old), listOf(fresh), subscription)
        val result = merge.profiles.single()
        assertEquals("stable-id", result.id)
        assertEquals("Locally renamed", result.name)
        assertEquals(42L, result.addedAt)
        assertEquals("managed", result.source)
        assertTrue(result.revoked)
        assertFalse(result.subscriptionMissing)
        assertEquals("192.0.2.2", result.host)
        assertEquals(1, merge.updated)
        assertEquals(0, merge.added)
    }

    @Test fun exactEndpointsWinBeforeAmbiguousSharedProviderNames() {
        val a = subscribed(profile("192.0.2.1"), "a")
        val b = subscribed(profile("192.0.2.2"), "b")
        val merge = reconcile(listOf(a, b), listOf(profile("192.0.2.2"), profile("192.0.2.1")), subscription)
        assertEquals(2, merge.updated)
        assertEquals("192.0.2.1", merge.profiles.single { it.id == "a" }.host)
        assertEquals("192.0.2.2", merge.profiles.single { it.id == "b" }.host)
    }

    @Test fun ambiguousRotationDoesNotStealExistingRouteIds() {
        val old = listOf(subscribed(profile("192.0.2.1"), "a"), subscribed(profile("192.0.2.2"), "b"))
        val merge = reconcile(old, listOf(profile("192.0.2.3"), profile("192.0.2.4")), subscription)
        assertEquals(0, merge.updated)
        assertEquals(2, merge.missing)
        assertEquals(2, merge.added)
        assertTrue(merge.profiles.filter { it.id in setOf("a", "b") }.all { it.subscriptionMissing })
        assertEquals("192.0.2.1", merge.profiles.single { it.id == "a" }.host)
    }

    @Test fun tlsDowngradeCannotReuseTlsRouteIdentity() {
        val old = subscribed(profile("192.0.2.1", tls = true))
        val plaintext = profile("192.0.2.2", tls = false)
        assertNotEquals(ProfileImporter.credentialIdentity(old), ProfileImporter.credentialIdentity(plaintext))
        val merge = reconcile(listOf(old), listOf(plaintext), subscription)
        assertEquals(0, merge.updated)
        assertEquals(1, merge.missing)
        assertEquals(1, merge.added)
        assertTrue(merge.profiles.single { it.id == old.id }.subscriptionMissing)
    }

    @Test fun legacyUniqueCredentialCanRecoverLocalRenameButNotTlsDowngrade() {
        val old = subscribed(profile("192.0.2.1"), legacy = true).copy(name = "My renamed node")
        val valid = reconcile(listOf(old), listOf(profile("192.0.2.2")), subscription)
        assertEquals(old.id, valid.profiles.single().id)
        assertEquals("My renamed node", valid.profiles.single().name)
        val downgrade = reconcile(listOf(old), listOf(profile("192.0.2.2", tls = false)), subscription)
        assertEquals(0, downgrade.updated)
    }

    @Test fun unrelatedSubscriptionsAndPersonalProfilesRemainUntouched() {
        val personal = profile("192.0.2.100", "Personal")
        val other = subscribed(profile("192.0.2.101", "Other"), "other").copy(subscription = "https://other.example.test/sub")
        val old = subscribed(profile("192.0.2.1"))
        val result = reconcile(listOf(personal, other, old), listOf(profile("192.0.2.2")), subscription)
        assertEquals(personal, result.profiles[0])
        assertEquals(other, result.profiles[1])
    }

    @Test fun failedEmptyResponseDoesNotMutateOrEraseTheSavedSubscription() {
        val old = listOf(subscribed(profile("192.0.2.1")))
        assertThrows(RuntimeException::class.java) { reconcile(old, emptyList(), subscription) }
        assertEquals(1, old.size)
        assertFalse(old.single().subscriptionMissing)
    }

    @Test fun partialRefreshCannotMarkUnparsedProfilesMissingThroughEitherImportEntryPoint() {
        val old = listOf(subscribed(profile("192.0.2.1"), "a"), subscribed(profile("192.0.2.2"), "b"))
        val partial = ImportResult(listOf(profile("192.0.2.1")), skipped = 1)
        assertThrows(RuntimeException::class.java) { Subscriptions.reconcile(old, partial, subscription) }
        assertTrue(old.none { it.subscriptionMissing })
        assertEquals(setOf("a", "b"), old.map { it.id }.toSet())
    }

    @Test fun duplicateIncomingEndpointsAreAddedOnlyOnce() {
        val first = profile("192.0.2.1")
        val second = profile("192.0.2.1")
        val result = reconcile(emptyList(), listOf(first, second), subscription)
        assertEquals(1, result.added)
        assertEquals(1, result.profiles.size)
        assertNotNull(result.profiles.single().subscriptionKey)
    }
}
