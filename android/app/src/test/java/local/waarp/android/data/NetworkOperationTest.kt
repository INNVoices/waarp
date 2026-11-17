// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class NetworkOperationTest {
    @Test fun cancellationClosesTheBlockedResourceAwayFromTheCancellingThread() = runBlocking {
        val started = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val closingThread = AtomicReference<String>()
        val call = launch(Dispatchers.IO) {
            NetworkOperation.call(close = {
                closingThread.set(Thread.currentThread().name)
                closed.countDown()
            }) {
                started.countDown()
                check(closed.await(5, TimeUnit.SECONDS)) { "Cancelled resource remained open" }
                "obsolete result"
            }
            fail("A cancelled result must not escape")
        }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        withTimeout(2_000) { call.cancelAndJoin() }
        assertTrue(call.isCancelled)
        assertEquals("waarp-network-cancel", closingThread.get())
    }

    @Test fun overallDeadlineInterruptsAResourceThatNeverFinishesItsBody() = runBlocking {
        val closed = CountDownLatch(1)
        try {
            withContext(Dispatchers.IO) {
                NetworkOperation.within(75) {
                    NetworkOperation.call(close = closed::countDown) {
                        check(closed.await(5, TimeUnit.SECONDS))
                        "late body"
                    }
                }
            }
            fail("The deadline must fail the request")
        } catch (_: SocketTimeoutException) { }
        assertEquals(0L, closed.count)
    }

    @Test fun parentTimeoutRemainsCancellationInsteadOfBecomingAnObservationFailure() = runBlocking {
        val closed = CountDownLatch(1)
        try {
            withContext(Dispatchers.IO) {
                withTimeout(75) {
                    NetworkOperation.within(5_000) {
                        NetworkOperation.call(close = closed::countDown) {
                            check(closed.await(5, TimeUnit.SECONDS))
                            "late body"
                        }
                    }
                }
            }
            fail("The parent timeout must cancel the request")
        } catch (_: TimeoutCancellationException) { }
        assertEquals(0L, closed.count)
    }

    @Test fun completedCallsKeepTheirResultAndDoNotScheduleCancellation() = runBlocking {
        var cancelled = false
        assertEquals("body", NetworkOperation.within(1_000) {
            NetworkOperation.call(close = { cancelled = true }) { "body" }
        })
        assertFalse(cancelled)
    }

    @Test fun transportFailureRetainsItsOriginalType() = runBlocking {
        val failure = IOException("fixture failure")
        try {
            NetworkOperation.within(1_000) { NetworkOperation.call(close = {}) { throw failure } }
            fail("Transport failure must propagate")
        } catch (actual: IOException) {
            // Coroutine debug stack recovery may copy a Throwable while retaining
            // its original as the cause. Transport classification must survive.
            assertEquals(failure.javaClass, actual.javaClass)
            assertEquals(failure.message, actual.message)
            assertTrue(generateSequence(actual as Throwable?) { it.cause }.any { it === failure })
        }
    }
}
