package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConnectionQualityTest {
    private fun measured(id: String, vararg delays: Long?) = ConnectionQuality.assess(id, delays.map { HttpPathSample(it, 100) })

    @Test fun healthyCurrentWinsEvenWhenAnotherHttpCheckIsMuchFaster() {
        assertNull(ConnectionQuality.recommend("a", listOf(measured("a", 400, 350), measured("b", 10, 11))))
        assertNull(ConnectionQuality.recommend("a", listOf(measured("a", 400, null), measured("b", 10, 11))))
    }
    @Test fun unknownOrOneFailureNeverBecomesAnOutage() {
        assertNull(ConnectionQuality.recommend("missing", listOf(measured("b", 10, 11))))
        assertNull(ConnectionQuality.recommend("a", listOf(measured("a", null), measured("b", 10, 11))))
        assertNull(ConnectionQuality.recommend(null, listOf(measured("a", null, null), measured("b", 10, 11))))
    }
    @Test fun confirmedFailedChecksNeedAConsistentAlternative() {
        val failed = measured("a", null, null)
        assertNull(ConnectionQuality.recommend("a", listOf(failed, measured("b", 10, null))))
        assertEquals("b", ConnectionQuality.recommend("a", listOf(failed, measured("b", 70, 90))))
    }
    @Test fun skippedAndCancelledCallsDoNotBecomeFailedChecks() {
        val row = ConnectionQuality.assess("a", listOf(HttpPathSample(null, 0), HttpPathSample(null, 10)))
        assertEquals(1, row.attempted)
        assertEquals(1, row.noResponse)
        assertFalse(row.consistent)
        assertNull(ConnectionQuality.recommend("a", listOf(row, measured("b", 10, 11))))
    }
    @Test fun latencySummaryIncludesOnlyActualReplies() {
        val row = measured("a", 0, 80, 20, null)
        assertEquals(4, row.attempted)
        assertEquals(3, row.responded)
        assertEquals(20.0, row.medianMs!!, 0.0)
        assertEquals(80L, row.spreadMs)
        assertEquals(1, row.noResponse)
    }
    private fun profile(config: String = "{\"type\":\"socks\"}") = TunnelProfile("p-a", "A", "socks", "192.0.2.1", 1080, config)
    private val context = ConnectionProofContext(4, 8, 2, 99, "ON")
    private fun proof() = ConnectionProof("check-1", "sheet", "route-a", "app", "test.app", "game", "https://example.com",
        context, 1000, mapOf("p-a" to profile().config))

    @Test fun proofExpiresAndEveryNetworkPolicyAndSessionChangeInvalidatesIt() {
        val p = proof()
        assertTrue(p.current(context, 1100, listOf(profile())))
        listOf(context.copy(revision = 5), context.copy(intent = 9), context.copy(nativeSession = 3),
            context.copy(physicalNetwork = 100), context.copy(phase = "OFF"), context.copy(selections = "auto=other")).forEach { changed ->
            assertFalse(p.current(changed, 1100, listOf(profile())))
        }
        assertFalse(p.current(context, 999, listOf(profile())))
        assertFalse(p.current(context, 1001 + ConnectionQuality.PROOF_TTL_MS, listOf(profile())))
        assertFalse(p.current(context, 1100, listOf(profile().copy(revoked = true))))
        assertFalse(p.current(context, 1100, listOf(profile().copy(subscriptionMissing = true))))
        assertFalse(p.current(context, 1100, listOf(profile("changed definition"))))
        assertFalse(p.current(context, 1100, emptyList()))
    }
    @Test fun proofCannotBeAppliedToAnotherDraftOrUnmeasuredPath() {
        val p = proof()
        assertTrue(p.allows("route-a", "app", "test.app", "game", "p-a"))
        assertFalse(p.allows("route-b", "app", "test.app", "game", "p-a"))
        assertFalse(p.allows("route-a", "app", "other.app", "game", "p-a"))
        assertFalse(p.allows("route-a", "custom", "test.app", "game", "p-a"))
        assertFalse(p.allows("route-a", "app", "test.app", "web", "p-a"))
        assertFalse(p.allows("route-a", "app", "test.app", "game", "p-b"))
    }
    @Test fun oldAndUnknownMetadataLoadSafelyAndKnownPurposeRoundTrips() {
        val old = JSONObject("""{"id":"r-1","name":"App","kind":"app","match":"test.app","via":"p-a"}""")
        assertEquals("general", TrafficRoute.fromJson(old).connectionUse)
        assertEquals("general", TrafficRoute.fromJson(old.put("connectionUse", "unknown-future-value")).connectionUse)
        val route = TrafficRoute.fromJson(old.put("connectionUse", "game"))
        assertEquals("game", TrafficRoute.fromJson(route.json()).connectionUse)
        assertEquals("p-a", TrafficRoute.fromJson(route.json()).via)
    }
}
