package local.waarp.android.ui

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import local.waarp.android.MainActivity
import local.waarp.android.WaarpApplication
import local.waarp.android.core.RuntimePhase
import local.waarp.android.data.AppData
import local.waarp.android.data.ProfileStore
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Owns an ACTION_SEND scenario throughout the external-import lifecycle.
 * ActivityScenario matches action/type/categories, so a launcher scenario stops
 * tracking after the real onNewIntent correctly replaces Activity.getIntent().
 * An empty Compose rule lets this test own and close the correct scenario.
 */
@RunWith(AndroidJUnit4::class)
class ExternalImportUiInstrumentedTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val repository get() = (context.applicationContext as WaarpApplication).repository

    @Test fun externalImportConfirmationSurvivesRecreationAndCommitsOnce() {
        val previous = runBlocking {
            val saved = repository.ready()
            repository.disconnect()
            withTimeout(20_000) { repository.controller.status.first { it.phase == RuntimePhase.OFF } }
            repository.edit { AppData() }
            saved
        }
        try {
            val incoming = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_SEND)
                .setType("text/plain").putExtra(Intent.EXTRA_TEXT,
                    "trojan://synthetic-external@192.0.2.20:443#External%20rotation")
            ActivityScenario.launch<MainActivity>(incoming).use { scenario ->
                withFailureCapture {
                    awaitConfirmation()
                    assertTrue(repository.data.value!!.profiles.isEmpty())
                    // Exercise cold-start receipt without granting import consent.
                    dialogButton("Отмена").performClick()
                    awaitNoConfirmation()
                    assertTrue(repository.data.value!!.profiles.isEmpty())

                    // Deliver the real Android intent to the existing Activity.
                    // Action/type/categories still match this scenario's launch.
                    var original: MainActivity? = null
                    scenario.onActivity { activity ->
                        original = activity
                        // ActivityScenario's invoker adds NEW_TASK/CLEAR_TASK to
                        // its launch intent. A new external delivery must not
                        // inherit those task-destruction flags.
                        activity.startActivity(Intent(incoming).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    }
                    awaitConfirmation()
                    scenario.onActivity { assertSame("SINGLE_TOP must deliver to the existing Activity", original, it) }
                    scenario.recreate()
                    awaitConfirmation()
                    scenario.onActivity {
                        assertNotSame("Recreation must replace the Activity instance", original, it)
                        original = it
                    }
                    dialogButton("Импортировать").performClick()
                    scenario.recreate()
                    scenario.onActivity { assertNotSame("Import must survive another actual recreation", original, it) }
                    compose.waitUntil(15_000) { repository.data.value?.profiles?.singleOrNull()?.name == "External rotation" }
                    awaitNoConfirmation()
                    val saved = runBlocking { ProfileStore(context).read() }
                    assertEquals(1, saved.profiles.size)
                    assertEquals("External rotation", saved.profiles.single().name)
                    assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
                    assertFalse(repository.requestedOpen.value)
                }
            }
        } finally {
            runBlocking {
                repository.disconnect()
                withTimeout(20_000) { repository.controller.status.first { it.phase == RuntimePhase.OFF } }
                repository.edit { previous }
            }
        }
    }

    private fun dialogButton(label: String) = compose
        .onNode(hasText(label) and hasClickAction() and hasAnyAncestor(isDialog()))
        .assertIsDisplayed().assertIsEnabled()

    private fun awaitConfirmation() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Импорт из другого приложения").fetchSemanticsNodes().size == 1 }
        compose.waitForIdle()
    }

    private fun awaitNoConfirmation() {
        compose.waitUntil(15_000) { compose.onAllNodesWithText("Импорт из другого приложения").fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
    }

    private fun withFailureCapture(block: () -> Unit) {
        try { block() }
        catch (failure: Throwable) {
            val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            runCatching {
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .takeScreenshot(File(directory, "failure-external-import.png"))
            }.exceptionOrNull()?.let(failure::addSuppressed)
            runCatching {
                File(directory, "failure-external-import-semantics.txt")
                    .writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString())
            }.exceptionOrNull()?.let(failure::addSuppressed)
            throw failure
        }
    }
}
