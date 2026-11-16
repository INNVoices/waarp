package local.waarp.android.ui

import android.os.SystemClock
import android.view.View
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.espresso.Espresso
import androidx.test.espresso.matcher.ViewMatchers.isRoot as isViewRoot
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
import local.waarp.android.data.ProfileImporter
import local.waarp.android.data.ProfileStore
import local.waarp.android.data.TrafficRoute
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the real Activity, ViewModel, native config validation and encrypted repository.
 * Test-only documentation addresses are never connected. Run sequentially on the disposable emulator.
 */
@RunWith(AndroidJUnit4::class)
class MobileUiInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
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
        compose.waitUntil(15_000) { compose.onAllNodes(hasText("Главная") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
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
        field("Название (необязательно)").performTextInput("UI imported tunnel")
        field("Конфигурация или ссылка").performTextInput("invalid input")
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
        field("Конфигурация или ссылка").performScrollTo().performTextReplacement("trojan://synthetic-ui-password@192.0.2.10:443#Synthetic")
        // EditableText is masked by PasswordVisualTransformation; InputText is the exact source value.
        field("Конфигурация или ссылка").assert(SemanticsMatcher.expectValue(SemanticsProperties.InputText,
            AnnotatedString("trojan://synthetic-ui-password@192.0.2.10:443#Synthetic")))
        modalButton("Импортировать", afterTextInput = true)
        awaitData { it.profiles.singleOrNull()?.name == "UI imported tunnel" }
        awaitNoForm()
        tab("Маршруты")
        compose.onNodeWithContentDescription("Добавить маршрут").performClick()
        compose.onNode(hasText("Адрес") and hasClickAction()).performClick()
        field("Домены, IP или подсети CIDR").performTextInput("999.0.0.1")
        field("Название").performScrollTo().performTextInput("UI custom route")
        modalButton("Сохранить маршрут", afterTextInput = true)
        awaitText("Некорректный IP или подсеть", substring = true)
        field("Название").assertTextContains("UI custom route")
        assertTrue(repository.data.value!!.routes.isEmpty())
        field("Домены, IP или подсети CIDR").performScrollTo().performTextReplacement("example.test")
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

    @Test fun groupMemberOrderAndExplicitDeletionReassignmentPersistThroughTheRealUi() {
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
        field("Название группы").performTextInput("UI ordered group")
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
            repository.edit { AppData(routes = List(120) { index ->
                TrafficRoute("state-route-$index", "Route ${index.toString().padStart(3, '0')}",
                    "custom", "host$index.example.test", DIRECT_PATH)
            }) }
        }
        awaitData { it.routes.size == 120 }
        tab("Маршруты")
        field("Найти маршрут").performTextInput("Route 110")
        Espresso.closeSoftKeyboard()
        compose.onNode(hasText("Адреса") and hasClickAction()).performClick()
        // hasText also matches the search field's EditableText. Select the route
        // card, not the identical query that is intentionally still visible.
        compose.onNode(hasText("Route 110") and hasClickAction() and !hasSetTextAction()).assertIsDisplayed()
        tab("Туннели")
        tab("Маршруты")
        assertEditableText("Найти маршрут", "Route 110")
        compose.onNode(hasText("Адреса") and hasClickAction()).assertIsSelected()
        field("Найти маршрут").performTextClearance()
        Espresso.closeSoftKeyboard()
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
        field("Домен или IP").performTextInput("example.test")
        Espresso.closeSoftKeyboard()
        compose.onNode(hasText("Соединения") and hasClickAction()).performClick()
        field("Приложение, адрес или путь").performTextInput("test.app")
        Espresso.closeSoftKeyboard()
        compose.onNode(hasText("Проверка") and hasClickAction()).performClick()
        assertEditableText("Домен или IP", "example.test")
        compose.onNode(hasText("Соединения") and hasClickAction()).performClick()
        assertEditableText("Приложение, адрес или путь", "test.app")
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
        assertFalse(repository.requestedOpen.value)
    }

    private fun tab(label: String) {
        compose.onNode(hasText(label) and hasClickAction()).performClick()
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
        if (afterTextInput) {
            // Android IME layout is outside Compose's virtual clock. A scroll during
            // its transition can move the touch target. Read-only confirmations
            // never opened an IME; after a nested picker their window focus is returning.
            Espresso.closeSoftKeyboard()
            var windowRoot: View? = null
            Espresso.onView(isViewRoot()).check { view, error ->
                if (error != null) throw error
                windowRoot = view
            }
            compose.waitUntil((deadline - SystemClock.uptimeMillis()).coerceAtLeast(1L)) {
                compose.runOnUiThread {
                    windowRoot?.let { ViewCompat.getRootWindowInsets(it)?.isVisible(WindowInsetsCompat.Type.ime()) == false } == true
                }
            }
        }
        button.performScrollTo()
        var previousBounds: Pair<Rect, Rect>? = null
        var stableSince = SystemClock.uptimeMillis()
        compose.waitUntil((deadline - SystemClock.uptimeMillis()).coerceAtLeast(1L)) {
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

    private fun withFailureCapture(name: String = "failure-import-route", block: () -> Unit) {
        try { block() }
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
                    .writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString())
            }.exceptionOrNull()?.let(failure::addSuppressed)
            throw failure
        }
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
