// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import local.waarp.android.data.RecoveryPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Exercise the production queue/epoch orchestration with deliberately blocked durable writes. */
class VpnControlLaneTest {
    @After fun cleanup() {
        drain()
        RuntimeState.requestStop()
        RuntimeState.status.value = RuntimeStatus()
        RuntimeState.logs.value = emptyList()
    }

    @Test fun offInvalidatesBlockedStartWithoutWaitingForDiskAndCannotPublishBeforeItsOwnCommit() {
        val caller = Executors.newSingleThreadExecutor()
        val onEntered = CountDownLatch(1)
        val onRelease = CountDownLatch(1)
        val offEntered = CountDownLatch(1)
        val offRelease = CountDownLatch(1)
        val persistedWanted = AtomicBoolean(false)
        val activated = AtomicBoolean(false)
        val recovered = AtomicBoolean(false)
        val failures = ConcurrentLinkedQueue<Throwable>()
        try {
            val request = RuntimeState.requestStart("test")
            VpnControlLane.enqueueStart(request) {
                VpnControlLane.completeStart(request,
                    persist = {
                        VpnControlLane.requireCurrent()
                        onEntered.countDown()
                        check(onRelease.await(3, TimeUnit.SECONDS))
                        persistedWanted.set(true)
                        true
                    },
                    activate = { activated.set(true) },
                    fail = { failures.add(it) },
                )
            }
            assertTrue(onEntered.await(3, TimeUnit.SECONDS))
            // This command must return while the first write is still blocked.
            val stopped = caller.submit<Long?> {
                VpnControlLane.enqueueStop(null, null, false,
                    persist = {
                        VpnControlLane.requireCurrent()
                        offEntered.countDown()
                        check(offRelease.await(3, TimeUnit.SECONDS))
                        persistedWanted.set(false)
                        null
                    },
                    finish = { token, error ->
                        error?.let(failures::add)
                        RuntimeState.finishStop(token, error)
                    },
                )
            }.get(3, TimeUnit.SECONDS)!!
            assertFalse(RuntimeState.wanted())
            assertEquals(RuntimePhase.STOPPING, RuntimeState.status.value.phase)
            VpnControlLane.execute {
                if (RecoveryPolicy.accepts(persistedWanted.get(), "epoch", "epoch", false,
                        stopped, RuntimeState.sessionGeneration())) recovered.set(true)
            }
            onRelease.countDown()
            assertTrue(offEntered.await(3, TimeUnit.SECONDS))
            assertTrue(persistedWanted.get())
            assertEquals(RuntimePhase.STOPPING, RuntimeState.status.value.phase)
            assertFalse(activated.get())
            offRelease.countDown()
            drain()
            assertFalse(persistedWanted.get())
            assertFalse(recovered.get())
            assertEquals(RuntimePhase.OFF, RuntimeState.status.value.phase)
            assertTrue(failures.toString(), failures.isEmpty())
        } finally {
            onRelease.countDown()
            offRelease.countDown()
            caller.shutdownNow()
            check(caller.awaitTermination(3, TimeUnit.SECONDS))
            drain()
        }
    }

    @Test fun replacementOnKeepsWriteOrderAndRejectsLateOffCompletion() {
        val offEntered = CountDownLatch(1)
        val offRelease = CountDownLatch(1)
        val writes = ConcurrentLinkedQueue<String>()
        val failures = ConcurrentLinkedQueue<Throwable>()
        val persistedWanted = AtomicBoolean(true)
        val oldStopPublished = AtomicBoolean(false)
        try {
            RuntimeState.requestStart("old")
            RuntimeState.status.value = RuntimeStatus(phase = RuntimePhase.ON)
            VpnControlLane.enqueueStop(null, null, false,
                persist = {
                    VpnControlLane.requireCurrent()
                    offEntered.countDown()
                    check(offRelease.await(3, TimeUnit.SECONDS))
                    persistedWanted.set(false)
                    writes.add("OFF")
                    null
                },
                finish = { token, error -> oldStopPublished.set(RuntimeState.finishStop(token, error)) },
            )
            assertTrue(offEntered.await(3, TimeUnit.SECONDS))
            val next = RuntimeState.requestStart("replacement")
            VpnControlLane.enqueueStart(next) {
                VpnControlLane.completeStart(next,
                    persist = {
                        VpnControlLane.requireCurrent()
                        persistedWanted.set(true)
                        writes.add("ON")
                        true
                    },
                    activate = { RuntimeState.updateIfCurrent(next.generation) { it.copy(phase = RuntimePhase.ON) } },
                    fail = { failures.add(it) },
                )
            }
            offRelease.countDown()
            drain()
            assertEquals(listOf("OFF", "ON"), writes.toList())
            assertFalse(oldStopPublished.get())
            assertTrue(persistedWanted.get())
            assertTrue(RuntimeState.isCurrent(next.generation))
            assertEquals(RuntimePhase.ON, RuntimeState.status.value.phase)
            assertTrue(failures.toString(), failures.isEmpty())
        } finally { offRelease.countDown(); drain() }
    }

    @Test fun failedDurableOffStillCleansUpAndReportsErrorInsteadOfOff() {
        RuntimeState.requestStart("test")
        RuntimeState.status.value = RuntimeStatus(phase = RuntimePhase.ON)
        val failure = IOException("synthetic disk failure")
        val completion = CompletableFuture<Throwable?>()
        VpnControlLane.enqueueStop(null, null, false,
            persist = { VpnControlLane.requireCurrent(); throw failure },
            finish = { token, error ->
                RuntimeState.finishStop(token, error)
                completion.complete(error)
            },
        )
        assertSame(failure, completion.get(3, TimeUnit.SECONDS))
        assertFalse(RuntimeState.wanted())
        assertEquals(RuntimePhase.ERROR, RuntimeState.status.value.phase)
        assertTrue(RuntimeState.status.value.message.orEmpty().contains("synthetic disk failure"))
    }

    @Test fun cancellingTheCallingCoroutineDoesNotAbandonAcceptedOff() = runBlocking {
        RuntimeState.requestStart("test")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val persistedWanted = AtomicBoolean(true)
        try {
            val screen = launch(start = CoroutineStart.UNDISPATCHED) {
                VpnControlLane.enqueueStop(null, null, false,
                    persist = {
                        entered.countDown()
                        check(release.await(3, TimeUnit.SECONDS))
                        persistedWanted.set(false)
                        null
                    },
                    finish = { token, error -> RuntimeState.finishStop(token, error) },
                )
                awaitCancellation()
            }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            screen.cancelAndJoin()
            assertEquals(RuntimePhase.STOPPING, RuntimeState.status.value.phase)
            release.countDown()
            drain()
            assertFalse(persistedWanted.get())
            assertEquals(RuntimePhase.OFF, RuntimeState.status.value.phase)
        } finally { release.countDown(); drain() }
    }

    @Test fun staleStopAndEditResumeCannotChangeReplacementIntent() {
        val original = RuntimeState.requestStart("old")
        val paused = VpnControlLane.enqueueStop(original.generation, true, true,
            persist = { null }, finish = { token, error -> RuntimeState.finishStop(token, error) })!!
        drain()
        assertTrue(RuntimeState.isPausedForUpdate())
        assertFalse(RuntimeState.wanted())
        val replacement = RuntimeState.startIfIdle(paused, "new")!!
        assertFalse(RuntimeState.isPausedForUpdate())
        var touched = false
        assertNull(VpnControlLane.enqueueStop(paused, false, false,
            persist = { touched = true; null }, finish = { _, _ -> touched = true }))
        assertNull(RuntimeState.startIfIdle(paused, "late resume"))
        drain()
        assertFalse(touched)
        assertTrue(RuntimeState.isCurrent(replacement.generation))
    }

    @Test fun persistenceGuardRejectsTheCallerThreadAndRuntimeMonitor() {
        assertThrows(IllegalStateException::class.java) { VpnControlLane.requireCurrent() }
        val result = CompletableFuture<Boolean>()
        VpnControlLane.execute {
            VpnControlLane.requireCurrent()
            val error = runCatching { synchronized(RuntimeState) { VpnControlLane.requireCurrent() } }.exceptionOrNull()
            result.complete(error is IllegalStateException)
        }
        assertTrue(result.get(3, TimeUnit.SECONDS))
    }

    private fun drain() {
        val reached = CompletableFuture<Unit>()
        VpnControlLane.execute { reached.complete(Unit) }
        reached.get(3, TimeUnit.SECONDS)
    }
}
