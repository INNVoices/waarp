package local.waarp.android.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
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
        compose.onNodeWithContentDescription("Назад").performClick()
        tab("Главная")
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
        assertFalse(repository.requestedOpen.value)
    }

    @Test fun rejectedImportAndRouteSaveKeepDraftsUntilCorrectedThenPersist() {
        tab("Туннели")
        compose.onNodeWithContentDescription("Добавить туннель").performClick()
        field("Название (необязательно)").performTextInput("UI imported tunnel")
        field("Конфигурация или ссылка").performTextInput("invalid input")
        modalButton("Импортировать")
        awaitText("Формат не распознан", substring = true)
        field("Название (необязательно)").assertTextContains("UI imported tunnel")
        compose.onNodeWithText("Добавить туннель").assertIsDisplayed()
        assertTrue(repository.data.value!!.profiles.isEmpty())
        field("Конфигурация или ссылка").performScrollTo().performTextReplacement("trojan://synthetic-ui-password@192.0.2.10:443#Synthetic")
        modalButton("Импортировать")
        awaitData { it.profiles.singleOrNull()?.name == "UI imported tunnel" }
        tab("Маршруты")
        compose.onNodeWithContentDescription("Добавить маршрут").performClick()
        compose.onNode(hasText("Адрес") and hasClickAction()).performClick()
        field("Домены, IP или подсети CIDR").performTextInput("999.0.0.1")
        field("Название").performScrollTo().performTextInput("UI custom route")
        modalButton("Сохранить маршрут")
        awaitText("Некорректный IP или подсеть", substring = true)
        field("Название").assertTextContains("UI custom route")
        assertTrue(repository.data.value!!.routes.isEmpty())
        field("Домены, IP или подсети CIDR").performScrollTo().performTextReplacement("example.test")
        modalButton("Сохранить маршрут")
        awaitData { it.routes.singleOrNull()?.name == "UI custom route" }
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
        compose.onNode(hasText("UI Alpha") and checkbox).performScrollTo().performClick()
        compose.onNode(hasText("UI Beta") and checkbox).performScrollTo().performClick()
        compose.onNodeWithContentDescription("Поднять UI Beta").performScrollTo().performClick()
        modalButton("Сохранить группу")
        awaitData { it.groups.singleOrNull()?.members == listOf(beta.id, alpha.id) }
        assertEquals("first", repository.data.value!!.groups.single().policy)
        screenshot("04-groups")
        compose.onNode(hasText("Добавленные") and hasClickAction()).performClick()
        compose.onNode(hasText("UI Alpha") and hasClickAction()).performClick()
        modalButton("Удалить туннель")
        compose.onNode(hasText("Куда переназначить маршруты") and hasClickAction()).performScrollTo().performClick()
        compose.onNode(hasText("UI Beta") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        modalButton("Переназначить и удалить")
        awaitData { value -> value.profiles.none { it.id == alpha.id } && value.routes.single().via == beta.id }
        assertEquals(listOf(beta.id), repository.data.value!!.groups.single().members)
        val saved = runBlocking { ProfileStore(context).read() }
        assertEquals(beta.id, saved.routes.single().via)
        assertEquals(listOf(beta.id), saved.groups.single().members)
        assertEquals(RuntimePhase.OFF, repository.controller.status.value.phase)
    }

    private fun tab(label: String) {
        compose.onNode(hasText(label) and hasClickAction()).performClick()
        compose.waitForIdle()
    }
    private fun field(label: String) = compose.onNode(hasText(label) and hasSetTextAction())
    private fun modalButton(label: String) {
        compose.onNode(hasText(label) and hasClickAction()).performScrollTo().performClick()
        compose.waitForIdle()
    }
    private fun awaitData(predicate: (AppData) -> Boolean) {
        compose.waitUntil(15_000) { repository.data.value?.let(predicate) == true }
        compose.waitForIdle()
    }
    private fun awaitText(text: String, substring: Boolean = false) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle()
    }
    private fun screenshot(name: String) {
        compose.waitForIdle()
        val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).takeScreenshot(File(directory, "$name.png"))
    }
}
