// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.*
import org.junit.Test

class StructuralRestartApprovalTest {
    @Test fun noApprovalNeededForCompatibleLiveOrInertChanges() = runBlocking {
        var prompts = 0
        assertTrue(StructuralRestartApproval.allowed(false, { true }) { prompts++; false })
        assertEquals(0, prompts)
    }
    @Test fun missingUiAndDenialPreserveOriginalSession() = runBlocking {
        assertFalse(StructuralRestartApproval.allowed(true, { true }, null))
        assertFalse(StructuralRestartApproval.allowed(true, { true }) { false })
    }
    @Test fun staleIntentCannotAskOrApplyOldApproval() = runBlocking {
        var asks = 0
        assertFalse(StructuralRestartApproval.allowed(true, { false }) { asks++; true })
        assertEquals(0, asks)
        var current = true
        assertFalse(StructuralRestartApproval.allowed(true, { current }) { current = false; true })
        assertTrue(StructuralRestartApproval.allowed(true, { true }) { true })
    }

    @Test fun timedOutQueuedPromptBecomesDeniedAndCannotBeAcceptedLater() = runBlocking {
        lateinit var queued: CompletableDeferred<Boolean>
        val answer = withTimeoutOrNull(50) {
            StructuralRestartApproval.awaitResponse { queued = it }
        }
        assertNull(answer)
        assertFalse(queued.isActive)
        assertFalse(queued.await())
        assertFalse(queued.complete(true))
    }

    @Test fun cancellingPresentationClosesVisiblePromptAndRejectsLateTap() = runBlocking {
        val shown = CompletableDeferred<CompletableDeferred<Boolean>>()
        val job = async {
            StructuralRestartApproval.awaitResponse { response ->
                shown.complete(response)
                awaitCancellation()
            }
        }
        val response = shown.await()
        job.cancelAndJoin()
        assertFalse(response.isActive)
        assertFalse(response.await())
        assertFalse(response.complete(true))
    }

    @Test fun approvedAndDismissedPromptsCompleteExactlyOnce() = runBlocking {
        lateinit var approved: CompletableDeferred<Boolean>
        assertTrue(StructuralRestartApproval.awaitResponse { response -> approved = response; response.complete(true) })
        assertTrue(approved.await())
        assertFalse(approved.complete(false))
        assertFalse(StructuralRestartApproval.awaitResponse { it.complete(false) })
    }
}
