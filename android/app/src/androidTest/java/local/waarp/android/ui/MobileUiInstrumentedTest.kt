package local.waarp.android.ui

import android.os.SystemClock
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.espresso.Espresso
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.matcher.RootMatchers.withDecorView
import androidx.test.espresso.matcher.ViewMatchers.isRoot as isViewRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import local.waarp.android.MainActivity
import local.waarp.android.WaarpApplication
import local.waarp.android.core.RuntimePhase
import local.waarp.android.data.AppData
import local.waarp.android.data.ProfileImporter
import local.waarp.android.data.ProfileStore
import local.waarp.android.data.TrafficRoute
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TestName
import org.hamcrest.Matchers.sameInstance
import org.json.JSONArray
import org.json.JSONObject

/** Exercises the real Activity, ViewModel, native config validation and encrypted repository.
 * Test-only documentation addresses are never connected. Run sequentially on the disposable emulator.
 */
@RunWith(AndroidJUnit4::class)
class MobileUiInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    @get:Rule val testName = TestName()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val repository get() = (context.applicationContext as WaarpApplication).repository
    private var previous: AppData? = null

    @Before fun prepareCleanOfflineState() {
        runBlocking {
            previous = repository.ready()
            repository.disconnect()
            withTimeout(20_000) { repository.controller.status.first { it.phase == RuntimePhase.OFF } }
            repository.edit { AppData() }
        }
        awaitData { it.profiles.isEmpty() && it.routes.isEmpty() }
        withFailureCapture("failure-ready-${testName.methodName}") {
            val deadline = SystemClock.uptimeMillis() + 15_000L
            compose.waitUntil(remaining(deadline)) { compose.onAllNodes(hasText("Главная") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
            val window = awaitFocusedWindow(compose.onNode(hasText("Главная") and hasClickAction()), deadline)
            assertInitialWindowRendered(window, deadline)
        }
    }

    @After fun restoreRepositoryAndStopVpn() {
        runBlocking {
            repository.disconnect()
            withTimeout(20_000) { repository.controller.status.first { it.phase == RuntimePhase.OFF } }
            previous?.let { saved -> repository.edit { saved } }
        }
    }

    @Test fun everyDestinationAndAndroidSettingsScreenOpensWithoutStartingVpn() {
        compose.onNodeWithText("VPN выключен").assertIsDisplayed()
        screenshot("01-home-empty")
        tab("Маршруты")
        compose.onNodeWithText("Маршрутов пока нет").assertIsDisplayed()
        tab("Туннели")
        compose.onNodeWithText("Добавь первый туннель").assertIsDisplayed()
        tab("Диагностика")
        compose.onNodeWithText("Проверить адрес").assertIsDisplayed()
        compose.onNode(hasText("Соединения") and hasClickAction()).performClick()
        compose.onNodeWithText("Нет наблюдаемых соединений").assertIsDisplayed()
        compose.onNodeWithContentDescription("Настройки").performClick()
        compose.onNodeWithText("Маршрутизация").assertIsDisplayed()
        compose.onNodeWithText("Локальная сеть напрямую").assertIsDisplayed()
        screenshot("02-settings")
        compose.onNode(hasText("Путь общего DNS") and hasClickAction()).performScrollTo().performClick()
        compose.onNode(hasText("Напрямую") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        awaitData { it.settings.systemDnsVia == DIRECT_PATH }
        assertEquals(DIRECT_PATH, runBlocking { ProfileStore(context).read() }.settings.systemDnsVia)
        compose.onNode(hasText("Путь общего DNS") and hasClickAction()).performScrollTo().performClick()
        compose.onNode(hasText("Автоматически по маршрутам") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        awaitData { it.settings.systemDnsVia == null }
        assertNull(runBlocking { ProfileStore(context).read() }.settings.systemDnsVia)
        compose.onNodeWithContentDescription("Назад").performClick()
        tab("Главная")
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
        assertFalse(repository.requestedOpen.value)
    }

    @Test fun rejectedImportAndRouteSaveKeepDraftsUntilCorrectedThenPersist() = withFailureCapture {
        tab("Туннели")
        compose.onNodeWithContentDescription("Добавить туннель").performClick()
        field("Название (необязательно)").enterText("UI imported tunnel")
        field("Конфигурация или ссылка").enterText("invalid input")
        modalButton("Импортировать", afterTextInput = true)
        awaitText("Формат не распознан", substring = true)
        field("Название (необязательно)").assertTextContains("UI imported tunnel")
        compose.onNodeWithTag("waarp-form-sheet").assertExists()
        assertTrue(repository.data.value!!.profiles.isEmpty())
        compose.activityRule.scenario.recreate()
        awaitText("Формат не распознан", substring = true)
        field("Название (необязательно)").assertTextContains("UI imported tunnel")
        field("Конфигурация или ссылка").assert(SemanticsMatcher.expectValue(SemanticsProperties.InputText,
            AnnotatedString("invalid input")))
        field("Конфигурация или ссылка").performScrollTo().enterText("trojan://synthetic-ui-password@192.0.2.10:443#Synthetic", replace = true)
        // EditableText is masked by PasswordVisualTransformation; InputText is the exact source value.
        field("Конфигурация или ссылка").assert(SemanticsMatcher.expectValue(SemanticsProperties.InputText,
            AnnotatedString("trojan://synthetic-ui-password@192.0.2.10:443#Synthetic")))
        modalButton("Импортировать", afterTextInput = true)
        awaitData { it.profiles.singleOrNull()?.name == "UI imported tunnel" }
        awaitNoForm()
        tab("Маршруты")
        compose.onNodeWithContentDescription("Добавить маршрут").performClick()
        compose.onNode(hasText("Адрес") and hasClickAction()).performClick()
        field("Домены, IP или подсети CIDR").enterText("999.0.0.1")
        field("Название").performScrollTo().enterText("UI custom route")
        modalButton("Сохранить маршрут", afterTextInput = true)
        awaitText("Некорректный IP или подсеть", substring = true)
        field("Название").assertTextContains("UI custom route")
        assertTrue(repository.data.value!!.routes.isEmpty())
        field("Домены, IP или подсети CIDR").performScrollTo().enterText("example.test", replace = true)
        assertEditableText("Домены, IP или подсети CIDR", "example.test")
        modalButton("Сохранить маршрут", afterTextInput = true)
        awaitData { it.routes.singleOrNull()?.name == "UI custom route" }
        awaitNoForm()
        val saved = runBlocking { ProfileStore(context).read() }
        assertEquals("UI custom route", saved.routes.single().name)
        assertEquals("example.test", saved.routes.single().match)
        assertEquals("g-auto", saved.routes.single().via)
        compose.activityRule.scenario.recreate()
        awaitText("UI custom route")
        screenshot("03-saved-route")
        compose.onNode(hasText("UI custom route") and hasClickAction()).performClick()
        modalButton("Удалить маршрут")
        modalButton("Удалить")
        awaitData { it.routes.isEmpty() }
        awaitNoForm()
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
    }

    @Test fun groupMemberOrderAndExplicitDeletionReassignmentPersistThroughTheRealUi() = withFailureCapture("failure-group-reassignment") {
        val alpha = ProfileImporter.link("trojan://synthetic-alpha@192.0.2.11:443#UI%20Alpha").copy(id = "ui-alpha")
        val beta = ProfileImporter.link("trojan://synthetic-beta@192.0.2.12:443#UI%20Beta").copy(id = "ui-beta")
        runBlocking {
            repository.edit { AppData(profiles = listOf(alpha, beta), routes = listOf(
                TrafficRoute(id = "ui-route", name = "Reassignment route", kind = "custom", match = "example.test", via = alpha.id))) }
        }
        awaitData { it.profiles.size == 2 }
        tab("Туннели")
        compose.onNode(hasText("Группы") and hasClickAction()).performClick()
        compose.onNode(hasText("Группа") and hasClickAction()).performClick()
        field("Название группы").enterText("UI ordered group")
        compose.onNode(hasText("Первый доступный") and hasClickAction()).performClick()
        val checkbox = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox)
        selectGroupMember("UI Alpha", checkbox)
        selectGroupMember("UI Beta", checkbox)
        compose.onNodeWithContentDescription("Поднять UI Beta").performScrollTo().performClick()
        modalButton("Сохранить группу", afterTextInput = true)
        awaitData { it.groups.singleOrNull()?.members == listOf(beta.id, alpha.id) }
        awaitNoForm()
        assertEquals("first", repository.data.value!!.groups.single().policy)
        screenshot("04-groups")
        compose.onNode(hasText("Добавленные") and hasClickAction()).performClick()
        compose.onNode(hasText("UI Alpha") and hasClickAction()).performClick()
        modalButton("Удалить туннель")
        compose.onNode(hasText("Удалить туннель?") and hasAnyAncestor(hasTestTag("waarp-form-sheet"))).assertExists()
        compose.onNode(hasText("Куда переназначить маршруты") and hasClickAction()).performScrollTo().performClick()
        compose.onNode(hasText("UI Beta") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        modalButton("Переназначить и удалить")
        awaitData { value -> value.profiles.none { it.id == alpha.id } && value.routes.single().via == beta.id }
        awaitNoForm()
        assertEquals(listOf(beta.id), repository.data.value!!.groups.single().members)
        val saved = runBlocking { ProfileStore(context).read() }
        assertEquals(beta.id, saved.routes.single().via)
        assertEquals(listOf(beta.id), saved.groups.single().members)
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
    }

    @Test fun tabsAndSectionsRetainFiltersScrollAndDiagnosticDraft() = withFailureCapture("failure-navigation-state") {
        runBlocking {
            // Exercise a real Main caller, as the ViewModel does. Preparing a
            // library edit must leave Main before any transform work and resume
            // on Main only after validation and encrypted publication complete.
            withContext(Dispatchers.Main.immediate) {
                assertSame(Looper.getMainLooper(), Looper.myLooper())
                repository.edit {
                    assertNotSame("Library edit transform ran on Main", Looper.getMainLooper(), Looper.myLooper())
                    AppData(routes = List(120) { index ->
                        TrafficRoute("state-route-$index", "Route ${index.toString().padStart(3, '0')}",
                            "custom", "host$index.example.test", DIRECT_PATH)
                    })
                }
                assertSame(Looper.getMainLooper(), Looper.myLooper())
            }
        }
        awaitData { it.routes.size == 120 }
        tab("Маршруты")
        field("Найти маршрут").enterText("Route 110")
        dismissKeyboard(field("Найти маршрут"))
        compose.onNode(hasText("Адреса") and hasClickAction()).performClick()
        // hasText also matches the search field's EditableText. Select the route
        // card, not the identical query that is intentionally still visible.
        compose.onNode(hasText("Route 110") and hasClickAction() and !hasSetTextAction()).assertIsDisplayed()
        tab("Туннели")
        tab("Маршруты")
        assertEditableText("Найти маршрут", "Route 110")
        compose.onNode(hasText("Адреса") and hasClickAction()).assertIsSelected()
        field("Найти маршрут").enterText("", replace = true)
        dismissKeyboard(field("Найти маршрут"))
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Route 119"))
        compose.onNodeWithText("Route 119").assertIsDisplayed()
        compose.onNodeWithContentDescription("Маршрут Route 119").assertIsOn().performClick()
        tab("Главная")
        awaitData { value -> value.routes.single { it.id == "state-route-119" }.enabled == false }
        assertFalse(runBlocking { ProfileStore(context).read() }.routes.single { it.id == "state-route-119" }.enabled)
        tab("Маршруты")
        compose.onNodeWithText("Route 119").assertIsDisplayed()
        compose.onNodeWithContentDescription("Маршрут Route 119").assertIsOff()
        compose.onNodeWithContentDescription("Настройки").performClick()
        compose.onNodeWithContentDescription("Назад").performClick()
        compose.onNodeWithText("Route 119").assertIsDisplayed()

        tab("Диагностика")
        field("Домен или IP").enterText("example.test")
        dismissKeyboard(field("Домен или IP"))
        compose.onNode(hasText("Соединения") and hasClickAction()).performClick()
        field("Приложение, адрес или путь").enterText("test.app")
        dismissKeyboard(field("Приложение, адрес или путь"))
        compose.onNode(hasText("Проверка") and hasClickAction()).performClick()
        assertEditableText("Домен или IP", "example.test")
        compose.onNode(hasText("Соединения") and hasClickAction()).performClick()
        assertEditableText("Приложение, адрес или путь", "test.app")
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
        assertFalse(repository.requestedOpen.value)
    }

    private fun tab(label: String) {
        val node = compose.onNode(hasText(label) and hasClickAction())
        awaitFocusedWindow(node, SystemClock.uptimeMillis() + 15_000L)
        node.performClick()
        compose.waitForIdle()
    }
    private fun field(label: String) = compose.onNode(hasText(label) and hasSetTextAction())
    private fun assertEditableText(label: String, expected: String) {
        field(label).assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(expected)))
    }
    private fun modalButton(label: String, afterTextInput: Boolean = false) = withFailureCapture("failure-modal") {
        // Background content remains in the semantics tree while the sheet is open.
        val button = compose.onNode(hasText(label) and hasClickAction() and hasAnyAncestor(hasTestTag("waarp-form-sheet")))
        val deadline = SystemClock.uptimeMillis() + 15_000L
        awaitFocusedWindow(button, deadline)
        if (afterTextInput) {
            // Android IME layout is outside Compose's virtual clock. A scroll during
            // its transition can move the touch target. Read-only confirmations
            // never opened an IME; after a nested picker their window focus is returning.
            dismissKeyboard(button, deadline)
        }
        button.performScrollTo()
        var previousBounds: Pair<Rect, Rect>? = null
        var stableSince = SystemClock.uptimeMillis()
        compose.waitUntil(remaining(deadline)) {
            val bounds = runCatching {
                button.assertIsDisplayed().assertIsEnabled()
                button.fetchSemanticsNode().boundsInRoot to compose.onNodeWithTag("waarp-form-sheet").fetchSemanticsNode().boundsInRoot
            }.getOrNull()
            if (bounds == null || bounds != previousBounds) {
                previousBounds = bounds
                stableSince = SystemClock.uptimeMillis()
            }
            bounds != null && SystemClock.uptimeMillis() - stableSince >= 250L
        }
        button.assertIsDisplayed().assertIsEnabled().performClick()
        compose.waitForIdle()
    }

    private fun remaining(deadline: Long) = (deadline - SystemClock.uptimeMillis()).coerceAtLeast(1L)

    private fun isWindowReady(window: View) = window.isAttachedToWindow && window.isShown &&
        window.hasWindowFocus() && !window.isLayoutRequested && window.width > 0 && window.height > 0

    private fun awaitFocusedWindow(node: SemanticsNodeInteraction, deadline: Long): View = withFailureCapture("failure-window-${testName.methodName}") {
        // Semantics actions can succeed while Android has not presented the window.
        // Resolve the node's own window: a form belongs to its dialog, not the Activity decor.
        val window = (node.fetchSemanticsNode().root as ViewRootForTest).view.rootView
        compose.waitUntil(remaining(deadline)) { compose.runOnUiThread { isWindowReady(window) } }
        assertEquals("A foreign window obscures the UI", context.packageName,
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).currentPackageName)
        window
    }

    private fun SemanticsNodeInteraction.enterText(text: String, replace: Boolean = false) {
        awaitFocusedWindow(this, SystemClock.uptimeMillis() + 15_000L)
        assertIsDisplayed().assertIsEnabled()
        if (replace) performTextReplacement(text) else performTextInput(text)
    }

    private fun dismissKeyboard(node: SemanticsNodeInteraction, deadline: Long = SystemClock.uptimeMillis() + 10_000L) {
        val window = awaitFocusedWindow(node, deadline)
        // Preserve Espresso's real IME action, with an exact focused decor instead
        // of its default root picker selecting an unfocused BASE_APPLICATION.
        Espresso.onView(isViewRoot()).inRoot(withDecorView(sameInstance(window))).perform(closeSoftKeyboard())
        compose.waitUntil(remaining(deadline)) {
            compose.runOnUiThread { isWindowReady(window) &&
                ViewCompat.getRootWindowInsets(window)?.isVisible(WindowInsetsCompat.Type.ime()) == false }
        }
    }

    private fun assertInitialWindowRendered(window: View, deadline: Long) {
        // This runs only on the cleared, empty Home screen, before any synthetic
        // form data is entered. A semantic-only PASS must not accept a blank AVD.
        val committed = AtomicBoolean()
        val callback = Runnable { committed.set(true) }
        compose.runOnUiThread {
            assertTrue("UI window is not hardware accelerated", window.isHardwareAccelerated)
            window.viewTreeObserver.registerFrameCommitCallback(callback)
            window.invalidate()
        }
        try {
            compose.waitUntil(remaining(deadline)) { committed.get() && compose.runOnUiThread { isWindowReady(window) } }
        } finally {
            compose.runOnUiThread { if (window.viewTreeObserver.isAlive) window.viewTreeObserver.unregisterFrameCommitCallback(callback) }
        }
        val capture = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            ?: throw AssertionError("Android did not capture the presented Home window")
        try {
            val content = compose.runOnUiThread {
                val position = IntArray(2).also(window::getLocationOnScreen)
                val bars = checkNotNull(ViewCompat.getRootWindowInsets(window)).getInsets(WindowInsetsCompat.Type.systemBars())
                android.graphics.Rect(position[0] + bars.left, position[1] + bars.top,
                    position[0] + window.width - bars.right, position[1] + window.height - bars.bottom)
            }
            assertTrue("Captured Home content is outside the display", content.intersect(0, 0, capture.width, capture.height) && !content.isEmpty)
            val colors = mutableSetOf<Int>()
            // Uniformity only: no expected color, theme, font or pixel baseline.
            // Excluding system bars prevents their clock/icons from hiding blank app content.
            for (y in content.top until content.bottom step 8) {
                for (x in content.left until content.right step 8) colors += capture.getPixel(x, y) and 0x00ffffff
            }
            val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            File(directory, "00-ready-${testName.methodName}.png").outputStream().use {
                assertTrue("Initial UI screenshot encoding failed", capture.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
            }
            assertTrue("Presented Home is a uniform blank raster; native rendering is not ready", colors.size > 1)
        } finally { capture.recycle() }
    }

    private fun <T> withFailureCapture(name: String = "failure-import-route", block: () -> T): T {
        try { return block() }
        catch (failure: Throwable) {
            // These cases contain only synthetic documentation-address fixtures.
            // Capture before @After restores data and ActivityScenario closes the form.
            val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            runCatching {
                UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
                    .takeScreenshot(File(directory, "$name.png"))
            }.exceptionOrNull()?.let(failure::addSuppressed)
            runCatching {
                File(directory, "$name-semantics.txt")
                    .writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
            }.exceptionOrNull()?.let(failure::addSuppressed)
            runCatching { writeWindowEvidence(directory, name) }.exceptionOrNull()?.let(failure::addSuppressed)
            throw failure
        }
    }

    private fun writeWindowEvidence(directory: File, name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val appWindows = compose.runOnUiThread {
            JSONArray().apply {
                WindowInspector.getGlobalWindowViews().forEach { view ->
                    val layout = view.layoutParams as? WindowManager.LayoutParams
                    val insets = ViewCompat.getRootWindowInsets(view)
                    val position = IntArray(2).also(view::getLocationOnScreen)
                    put(JSONObject().put("viewClass", view.javaClass.name).put("package", view.context.packageName)
                        .put("windowType", layout?.type).put("flags", layout?.flags)
                        .put("attached", view.isAttachedToWindow).put("shown", view.isShown)
                        .put("windowFocus", view.hasWindowFocus()).put("viewFocus", view.hasFocus())
                        .put("layoutRequested", view.isLayoutRequested).put("hardwareAccelerated", view.isHardwareAccelerated)
                        .put("x", position[0]).put("y", position[1]).put("width", view.width).put("height", view.height)
                        .put("drawingTimeMs", view.drawingTime).put("displayState", view.display?.state)
                        .put("imeVisible", insets?.isVisible(WindowInsetsCompat.Type.ime())))
                }
            }
        }
        val frameworkWindows = JSONArray()
        instrumentation.uiAutomation.windows.forEach { window ->
            val bounds = android.graphics.Rect().also(window::getBoundsInScreen)
            val record = JSONObject().put("id", window.id).put("type", window.type).put("layer", window.layer)
                .put("active", window.isActive).put("focused", window.isFocused)
                .put("accessibilityFocused", window.isAccessibilityFocused).put("bounds", bounds.toShortString())
                .put("package", window.root?.packageName?.toString())
            runCatching {
                instrumentation.uiAutomation.getWindowContentFrameStats(window.id)?.let { frames ->
                    record.put("frameCount", frames.frameCount).put("startTimeNs", frames.startTimeNano)
                        .put("endTimeNs", frames.endTimeNano)
                }
            }.exceptionOrNull()?.let { record.put("frameStatsError", it.javaClass.name) }
            frameworkWindows.put(record)
        }
        File(directory, "$name-windows.json").writeText(JSONObject().put("test", testName.methodName)
            .put("uptimeMs", SystemClock.uptimeMillis()).put("expectedPackage", context.packageName)
            .put("foregroundPackage", device.currentPackageName).put("screenOn", device.isScreenOn)
            .put("appWindows", appWindows).put("frameworkWindows", frameworkWindows).toString(2))
    }
    private fun selectGroupMember(name: String, checkbox: SemanticsMatcher) {
        // The list scrolls inside the form. Bring its viewport into the outer scroll
        // container first, including after a selected row changes the form's height.
        compose.onNodeWithTag("group-candidates").performScrollTo()
        val member = hasText(name) and checkbox
        compose.onNode(member).performScrollTo().assertIsDisplayed().performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(member and isOn()).fetchSemanticsNodes().size == 1 }
        compose.onNode(member).assertIsOn()
    }
    private fun awaitData(predicate: (AppData) -> Boolean) {
        compose.waitUntil(15_000) { repository.data.value?.let(predicate) == true }
        compose.waitForIdle()
    }
    private fun awaitNoForm() {
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("waarp-form-sheet").fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
    }
    private fun awaitText(text: String, substring: Boolean = false) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.waitForIdle()
        assertTrue("Screenshot capture failed", device.takeScreenshot(File(directory, "$name.png")))
        // Compose can still execute semantics actions behind a foreign ANR dialog.
        // Such a screenshot is evidence of a blocked device, not a passing UI review.
        assertEquals("A system or another app's window obscures the UI screenshot", context.packageName, device.currentPackageName)
    }
}
