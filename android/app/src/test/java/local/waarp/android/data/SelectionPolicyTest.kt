package local.waarp.android.data

import org.junit.Assert.*
import org.junit.Test

class SelectionPolicyTest {
    private val group = TunnelGroup("g-test", "Test", "fastest", listOf("current", "challenger"))
    private val health = mapOf("current" to ProbeHealth().measured(1000, 100), "challenger" to ProbeHealth().measured(100, 100))

    @Test fun twoFailuresAreRequiredAndZeroMillisecondsIsSuccessful() {
        val success = ProbeHealth().measured(0, 100)
        assertTrue(success.healthy)
        val first = success.measured(null, 200)
        assertTrue(first.holding)
        assertFalse(first.down)
        val second = first.measured(null, 300)
        assertTrue(second.down)
        assertFalse(second.holding)
        assertEquals("current", SelectionPolicy.select(group, "current", health + ("current" to first)).next)
        assertEquals("challenger", SelectionPolicy.select(group, "current", health + ("current" to second)).next)
        assertTrue(second.measured(0, 400).healthy)
    }

    @Test fun switchingForSpeedRequiresFiveFreshSustainedRounds() {
        var memory = SelectionMemory()
        repeat(4) { round ->
            val decision = SelectionPolicy.select(group, "current", health, memory, measuredThisRound = health.keys)
            assertEquals("current", decision.next)
            assertEquals(round + 1, decision.memory.rounds)
            memory = decision.memory
        }
        assertEquals("challenger", SelectionPolicy.select(group, "current", health, memory, measuredThisRound = health.keys).next)
    }

    @Test fun activeConnectionsHoldAWorkingPathButDoNotPinAConfirmedFailedPath() {
        val held = SelectionPolicy.select(group, "current", health, SelectionMemory("challenger", 4), activeConnections = true)
        assertEquals("current", held.next)
        val failed = health.getValue("current").measured(null, 200).measured(null, 300)
        assertEquals("challenger", SelectionPolicy.select(group, "current", health + ("current" to failed), activeConnections = true).next)
    }

    @Test fun unmeasuredRoundsCannotAdvanceSpeedStreakOrSelectAnUnmeasuredChallenger() {
        val memory = SelectionMemory("challenger", 4)
        val currentNotMeasured = SelectionPolicy.select(group, "current", health, memory, measuredThisRound = setOf("challenger"))
        assertEquals("current", currentNotMeasured.next)
        assertEquals(4, currentNotMeasured.memory.rounds)
        val challengerNotMeasured = SelectionPolicy.select(group, "current", health, memory, measuredThisRound = setOf("current"))
        assertEquals("current", challengerNotMeasured.next)
        assertTrue(challengerNotMeasured.memory.rounds <= memory.rounds)
        val failed = health.getValue("current").measured(null, 200).measured(null, 300)
        assertEquals("current", SelectionPolicy.select(group, "current", health + ("current" to failed), measuredThisRound = setOf("current")).next)
    }
}
