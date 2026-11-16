// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.core.RuntimeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

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

    @Test fun runtimeOffPublishesPersistedIntentBeforeAnAlarmMayClaimTheIdleGeneration() {
        val workers = Executors.newFixedThreadPool(2)
        val enteredPersistence = CountDownLatch(1)
        val releasePersistence = CountDownLatch(1)
        val alarmEntered = CountDownLatch(1)
        val savedWanted = AtomicBoolean(true)
        val recovered = AtomicBoolean(false)
        try {
            val active = RuntimeState.requestStart("synthetic")
            val off = workers.submit<Long?> {
                RuntimeState.stopAndApply(active.generation, true, false) {
                    assertTrue("OFF persistence must share the generation monitor", Thread.holdsLock(RuntimeState))
                    assertFalse(RuntimeState.wanted())
                    enteredPersistence.countDown()
                    check(releasePersistence.await(3, TimeUnit.SECONDS))
                    savedWanted.set(false)
                }
            }
            assertTrue(enteredPersistence.await(3, TimeUnit.SECONDS))
            val alarm = workers.submit {
                alarmEntered.countDown()
                RuntimeState.whenGeneration(active.generation + 1) {
                    if (RecoveryPolicy.accepts(savedWanted.get(), "epoch", "epoch", false,
                            active.generation + 1, RuntimeState.sessionGeneration())) {
                        recovered.set(true)
                        RuntimeState.requestStart()
                    }
                }
            }
            assertTrue(alarmEntered.await(3, TimeUnit.SECONDS))
            assertFalse(alarm.isDone)
            releasePersistence.countDown()
            val offGeneration = off.get(3, TimeUnit.SECONDS)!!
            alarm.get(3, TimeUnit.SECONDS)
            assertFalse(recovered.get())
            assertFalse(RuntimeState.wanted())

            val next = RuntimeState.requestStart("replacement")
            assertNull(RuntimeState.stopAndApply(offGeneration, null, false) { savedWanted.set(false) })
            assertTrue(RuntimeState.isCurrent(next.generation))
            val pause = RuntimeState.stopAndApply(next.generation, true, true) {}!!
            assertTrue(RuntimeState.isPausedForUpdate())
            assertFalse(RuntimeState.wanted())
            RuntimeState.startIfIdle(pause, "after edit")!!
            assertFalse(RuntimeState.isPausedForUpdate())
        } finally {
            releasePersistence.countDown()
            workers.shutdownNow()
            check(workers.awaitTermination(3, TimeUnit.SECONDS))
            RuntimeState.requestStop()
        }
    }
}
