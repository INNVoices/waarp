// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecoveryPolicyTest {
    @Test fun offAndLaterOnRejectAnAlreadyDeliveredAlarm() {
        assertTrue(RecoveryPolicy.accepts(true, "on-a", "on-a", false, 7, 7))
        // OFF wins even when delivery has already copied the old alarm extras.
        assertFalse(RecoveryPolicy.accepts(false, "on-a", "on-a", false, 7, 7))
        assertFalse(RecoveryPolicy.accepts(true, "on-b", "on-a", false, 9, 9))
        // A request claimed before the later OFF/ON cannot commit to its runtime.
        assertFalse(RecoveryPolicy.accepts(true, "on-b", "on-b", false, 7, 9))
        assertFalse(RecoveryPolicy.accepts(true, "on-b", "on-b", true, 9, 9))
        assertFalse(RecoveryPolicy.accepts(true, null, null, false, 9, 9))
    }

    @Test fun consecutiveProcessDeathsConsumeOneSharedBoundedBudget() {
        val first = RecoveryPolicy.claim(RecoveryHistory(), 20_000, 4) as RecoveryDecision.Start
        val deferred = RecoveryPolicy.claim(first.history, 21_000, 4) as RecoveryDecision.Wait
        assertEquals(4_000L, deferred.delayMs)
        assertEquals(listOf(20_000L), deferred.history.attempts)
        val second = RecoveryPolicy.claim(deferred.history, 25_000, 4) as RecoveryDecision.Start
        // Briefly reaching ON must not reset the process-death fuse.
        val briefOn = RecoveryPolicy.healthy(second.history, 26_000, 4)
        assertTrue(RecoveryPolicy.claim(briefOn, 30_000, 4) is RecoveryDecision.Exhausted)
    }

    @Test fun rollingBudgetCannotBeResetByStraddlingABucketBoundary() {
        val first = RecoveryPolicy.claim(RecoveryHistory(), 299_000, 1) as RecoveryDecision.Start
        val second = RecoveryPolicy.claim(first.history, 304_000, 1) as RecoveryDecision.Start
        assertTrue(RecoveryPolicy.claim(second.history, 309_000, 1) is RecoveryDecision.Exhausted)
        val later = RecoveryPolicy.claim(second.history, 599_000, 1) as RecoveryDecision.Start
        assertEquals(listOf(304_000L, 599_000L), later.history.attempts)
    }

    @Test fun onlyContinuousConfirmedUptimeResetsHealthHistory() {
        val used = RecoveryHistory(listOf(10_000, 15_000), bootCount = 2)
        val on = RecoveryPolicy.healthy(used, 16_000, 2)
        assertEquals(used.attempts, RecoveryPolicy.healthy(on, 315_999, 2).attempts)
        assertTrue(RecoveryPolicy.healthy(on, 316_000, 2).attempts.isEmpty())
        val paused = RecoveryPolicy.interrupted(on)
        val resumed = RecoveryPolicy.healthy(paused, 316_000, 2)
        assertEquals(316_000L, resumed.healthySince)
        assertEquals(used.attempts, resumed.attempts)
    }

    @Test fun rebootAndMonotonicRollbackNeverCreateAnInfiniteBackoff() {
        val oldBoot = RecoveryHistory(listOf(1_000, 6_000), healthySince = 7_000, bootCount = 8)
        val rebootWithGreaterUptime = RecoveryPolicy.claim(oldBoot, 10_000, 9) as RecoveryDecision.Start
        assertEquals(listOf(10_000L), rebootWithGreaterUptime.history.attempts)
        val noBootCount = oldBoot.copy(bootCount = -1)
        val rollback = RecoveryPolicy.claim(noBootCount, 20, -1) as RecoveryDecision.Start
        assertEquals(listOf(20L), rollback.history.attempts)
        // Changing wall-clock time is irrelevant: only elapsed time is supplied.
        assertTrue(RecoveryPolicy.claim(oldBoot, 10_000, 8) is RecoveryDecision.Exhausted)
    }

}
