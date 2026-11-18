// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import local.waarp.android.data.ConnectionProofContext
import local.waarp.android.ui.RouteCheckRequest
import local.waarp.android.ui.RouteDraft
import local.waarp.android.ui.RouteKind
import local.waarp.android.ui.UiResult
import org.junit.Assert.*
import org.junit.Test

class ConnectionCheckSharingTest {
    private val context = ConnectionProofContext(4, 8, 2, 99, "ON", "g-auto=p-a")
    private val draft = RouteDraft("r-a", RouteKind.APP, "Example", "p-a", packageName = "example.app", connectionUse = "game")
    private val request = RouteCheckRequest("sheet-a", draft, "https://example.test/check")
    private val identity = ConnectionCheckIdentity(request.target, request, context)

    @Test fun identicalWaitersShareTheOneOwnersExactResult() = runBlocking {
        val finished = CompletableDeferred<Unit>()
        var calls = 0
        val result = UiResult(true, "fixture result")
        val owner = async(start = CoroutineStart.UNDISPATCHED) { calls++; finished.await(); result }
        val first = async(start = CoroutineStart.UNDISPATCHED) { sharedConnectionCheck(owner, identity, identity.copy(), false)!!.await() }
        val second = async(start = CoroutineStart.UNDISPATCHED) { sharedConnectionCheck(owner, identity, identity.copy(), false)!!.await() }
        assertEquals(1, calls)
        finished.complete(Unit)
        assertSame(result, first.await())
        assertSame(result, second.await())
        assertNull(sharedConnectionCheck(owner, identity, identity, false)) // No completed-result cache.
    }

    @Test fun differentDraftTargetPurposeOrRuntimeNeverJoins() = runBlocking {
        val owner = CompletableDeferred<UiResult>()
        val differentRequests = listOf(request.copy(contextId = "sheet-b"), request.copy(target = "https://example.test/other")) +
            listOf(draft.copy(id = "r-b"), draft.copy(kind = RouteKind.SERVICE), draft.copy(name = "Other"),
                draft.copy(viaId = "p-b"), draft.copy(fallbackViaId = "p-c"), draft.copy(enabled = false),
                draft.copy(packageName = "other.app"), draft.copy(connectionUse = "web"),
                draft.copy(recommendationProofId = "another-proof")).map { request.copy(draft = it) }
        val differentContexts = listOf(context.copy(revision = 5), context.copy(intent = 9), context.copy(nativeSession = 3),
            context.copy(physicalNetwork = 100), context.copy(phase = "OFF"), context.copy(selections = "g-auto=p-b"))
        val different = listOf(identity.copy(target = "https://example.test/other"), identity.copy(request = null)) +
            differentRequests.map { identity.copy(request = it) } + differentContexts.map { identity.copy(context = it) }
        different.forEach { assertNull(sharedConnectionCheck(owner, identity, it, false)) }
        assertNull(sharedConnectionCheck(owner, identity, identity, true))
        assertNull(sharedConnectionCheck(owner, identity, null, false))
        assertNull(sharedConnectionCheck(owner, null, identity, false))
        owner.cancel()
    }

    @Test fun cancellingAJoinerLeavesTheOwnerAndOtherWaiterAlive() = runBlocking {
        val owner = CompletableDeferred<UiResult>()
        val first = async(start = CoroutineStart.UNDISPATCHED) { sharedConnectionCheck(owner, identity, identity, false)!!.await() }
        val second = async(start = CoroutineStart.UNDISPATCHED) { sharedConnectionCheck(owner, identity, identity, false)!!.await() }
        first.cancelAndJoin()
        assertTrue(owner.isActive)
        val result = UiResult(true, "fixture result")
        owner.complete(result)
        assertSame(result, second.await())
    }

    @Test fun explicitCancellationRejectsLateJoinersUntilNativeCleanupFinishes() = runBlocking {
        val cleanup = CompletableDeferred<Unit>()
        val blocker = CompletableDeferred<Unit>()
        val owner = async(start = CoroutineStart.UNDISPATCHED) {
            try { blocker.await(); UiResult(true, "obsolete result") }
            finally { withContext(NonCancellable) { cleanup.await() } }
        }
        val waiter = async(start = CoroutineStart.UNDISPATCHED) { sharedConnectionCheck(owner, identity, identity, false)!!.await() }
        owner.cancel()
        assertFalse(owner.isCompleted)
        assertNull(sharedConnectionCheck(owner, identity, identity, false))
        cleanup.complete(Unit)
        owner.join(); waiter.join()
        assertTrue(waiter.isCancelled)
    }
}
