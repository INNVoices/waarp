package local.waarp.android.ui

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ModalSessionTest {
    private val dispatcher = StandardTestDispatcher()
    private val store = ViewModelStore()
    @Before fun setDispatcher() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { store.clear(); Dispatchers.resetMain() }

    @Test fun retainedModalKeepsDraftAndSinglePendingSubmissionThenCompletesOnce() = runTest(dispatcher) {
        val sessions = ModalSessions().also { store.put("modal", it) }
        val original = sessions.obtain("form")
        val text = original.text("configuration").apply { value = "synthetic-configuration" }
        val finish = CompletableDeferred<Unit>()
        var commits = 0
        original.operation.submit { finish.await(); commits++; UiResult(true, "saved") }
        runCurrent()
        val afterRecreation = sessions.obtain("form")
        assertSame(original, afterRecreation)
        assertEquals("synthetic-configuration", afterRecreation.text("configuration").value)
        assertTrue(afterRecreation.operation.busy)
        afterRecreation.operation.submit { commits++; UiResult(true) }
        runCurrent()
        assertEquals(0, commits)
        finish.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, commits)
        assertEquals(1L, afterRecreation.operation.completions)
        assertFalse(afterRecreation.operation.busy)
        sessions.clear("form")
        assertEquals("", text.value)
        assertEquals("", sessions.obtain("next-form").text("configuration").value)
    }

    @Test fun refreshIsNotAFormCompletionAndRejectedSubmitRetainsTheDraft() = runTest(dispatcher) {
        val session = ModalSessions().also { store.put("modal", it) }.obtain("form")
        session.text("configuration").value = "synthetic-invalid"
        session.operation.run { UiResult(true, "refreshed") }
        advanceUntilIdle()
        assertEquals(0L, session.operation.completions)
        session.operation.submit { UiResult(false, "invalid format") }
        advanceUntilIdle()
        assertEquals(0L, session.operation.completions)
        assertEquals("invalid format", session.operation.error)
        assertEquals("synthetic-invalid", session.text("configuration").value)
        assertFalse(session.operation.busy)
    }
}
