package local.waarp.android.ui

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.os.Parcel
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
        val application = context.applicationContext as Application
        val savedStates = PostSaveCapture()
        application.registerActivityLifecycleCallbacks(savedStates)
        try {
            // Deliberately synthetic values: none may be seeded into the
            // ViewModel SavedStateHandle by the Activity's default arguments.
            val importSecret = "synthetic-external-secret-e13a6d9b"
            val foreignCanary = "synthetic-foreign-extra-437ed280"
            val replacementCanary = "synthetic-replacement-extra-814aca75"
            val sentinels = listOf(importSecret, foreignCanary, replacementCanary)
            val incoming = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_SEND)
                .setType("text/plain").putExtra(Intent.EXTRA_TEXT,
                    "trojan://$importSecret@192.0.2.20:443#External%20rotation")
                .putExtra("external-saved-state-canary", foreignCanary)
                .putExtra("import-replace-id", replacementCanary)
                .putExtra("import-picker-open", true)
            val sourceBytes = marshal(requireNotNull(incoming.extras))
            sentinels.forEach { sentinel ->
                assertTrue("The Parcel scan must detect each synthetic source sentinel", containsEncoded(sourceBytes, sentinel))
            }
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
                    val recreatedInstances = mutableListOf<MainActivity>()
                    scenario.onActivity { activity ->
                        original = activity
                        // ActivityScenario's invoker adds NEW_TASK/CLEAR_TASK to
                        // its launch intent. A new external delivery must not
                        // inherit those task-destruction flags.
                        activity.startActivity(Intent(incoming).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    }
                    awaitConfirmation()
                    scenario.onActivity {
                        assertSame("SINGLE_TOP must deliver to the existing Activity", original, it)
                        recreatedInstances += it
                    }
                    scenario.recreate()
                    awaitConfirmation()
                    scenario.onActivity {
                        assertNotSame("Recreation must replace the Activity instance", original, it)
                        original = it
                    }
                    dialogButton("Импортировать").performClick()
                    scenario.onActivity { recreatedInstances += it }
                    scenario.recreate()
                    scenario.onActivity { assertNotSame("Import must survive another actual recreation", original, it) }
                    savedStates.assertPrivateState(recreatedInstances, sentinels)
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
            application.unregisterActivityLifecycleCallbacks(savedStates)
            runBlocking {
                repository.disconnect()
                withTimeout(20_000) { repository.controller.status.first { it.phase == RuntimePhase.OFF } }
                repository.edit { previous }
            }
        }
    }

    /** API 29's post callback runs after ComponentActivity has completed its
     * SavedStateRegistryController.performSave. The ordinary save callback
     * runs in super.onSaveInstanceState and misses that registry payload.
     * Observe the real lifecycle; never invoke onSaveInstanceState manually.
     */
    private class PostSaveCapture : Application.ActivityLifecycleCallbacks {
        private data class Snapshot(val activity: MainActivity, val registryPresent: Boolean, val bytes: Result<ByteArray>)
        private val snapshots = mutableListOf<Snapshot>()

        override fun onActivityPostSaveInstanceState(activity: Activity, outState: Bundle) {
            if (activity !is MainActivity) return
            val snapshot = Snapshot(activity,
                outState.containsKey("androidx.lifecycle.BundlableSavedStateRegistry.key"),
                runCatching { marshal(outState) })
            synchronized(snapshots) { snapshots += snapshot }
        }

        fun assertPrivateState(recreated: List<MainActivity>, sentinels: List<String>) {
            assertEquals("The scenario must recreate two Activity instances", 2, recreated.size)
            assertNotSame("The saved instances must be distinct", recreated[0], recreated[1])
            val observed = synchronized(snapshots) { snapshots.toList() }
            val matching = observed.filter { snapshot -> recreated.any { it === snapshot.activity } }
            assertTrue("Both real recreations must produce post-save callbacks", matching.size >= 2)
            recreated.forEach { activity ->
                assertTrue("A recreated instance has no observed saved state", matching.any { it.activity === activity })
            }
            matching.forEach { snapshot ->
                assertTrue("Post-save observation must contain the completed SavedStateRegistry", snapshot.registryPresent)
                assertTrue("The actual saved-state Parcel could not be inspected", snapshot.bytes.isSuccess)
                val bytes = snapshot.bytes.getOrThrow()
                assertTrue("The actual saved-state Parcel must not be empty", bytes.isNotEmpty())
                sentinels.forEach { sentinel ->
                    // Never include the payload, sentinel or Bundle in failure output.
                    assertFalse("External import data leaked into Activity saved state", containsEncoded(bytes, sentinel))
                }
            }
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    private companion object {
        fun marshal(state: Bundle): ByteArray {
            val parcel = Parcel.obtain()
            return try { parcel.writeBundle(state); parcel.marshall() } finally { parcel.recycle() }
        }

        fun containsEncoded(bytes: ByteArray, sentinel: String): Boolean =
            listOf(Charsets.UTF_8, Charsets.UTF_16LE).any { charset ->
                val needle = sentinel.toByteArray(charset)
                (0..bytes.size - needle.size).any { offset -> needle.indices.all { bytes[offset + it] == needle[it] } }
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
