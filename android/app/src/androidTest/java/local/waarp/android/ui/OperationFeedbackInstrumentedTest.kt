package local.waarp.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlinx.coroutines.launch

class OperationFeedbackInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun repeatedSuccessDoesNotMoveFollowingControlAndRemainsAnnounced() {
        val announced = mutableListOf<String>()
        compose.setContent {
            WaarpTheme {
                CompositionLocalProvider(LocalOperationMessage provides { announced.add(it) }, LocalDensity provides Density(1f, 1.5f)) {
                    val operation = rememberUiOperation()
                    Column(Modifier.width(320.dp)) {
                        Button(onClick = { operation.run { UiResult(true, "Маршрут сохранён") } }) { Text("Сохранить") }
                        OperationFeedback(operation)
                        Button(onClick = {}) { Text("Следующий маршрут") }
                    }
                }
            }
        }
        val next = compose.onNodeWithText("Следующий маршрут")
        val before = next.fetchSemanticsNode().boundsInRoot
        repeat(2) {
            compose.onNodeWithText("Сохранить").performClick()
            compose.waitForIdle()
            assertEquals(before, next.fetchSemanticsNode().boundsInRoot)
        }
        compose.runOnIdle { assertEquals(listOf("Маршрут сохранён", "Маршрут сохранён"), announced) }
    }

    @Test fun blockingFailureStillAppearsNextToAction() {
        compose.setContent {
            WaarpTheme {
                val operation = rememberUiOperation()
                Column {
                    Button(onClick = { operation.run { UiResult(false, "Не удалось сохранить маршрут") } }) { Text("Сохранить") }
                    OperationFeedback(operation)
                }
            }
        }
        compose.onNodeWithText("Сохранить").performClick()
        compose.onNodeWithText("Не удалось сохранить маршрут").assertExists()
    }

    @Test fun successInOpenSheetDoesNotMoveFormControls() {
        lateinit var host: SnackbarHostState
        val open = mutableStateOf(false)
        val notification = mutableStateOf("")
        val fontScale = mutableStateOf(1.5f)
        val announced = mutableListOf<String>()
        compose.setContent {
            WaarpTheme {
                val snackbar = remember { SnackbarHostState() }.also { host = it }
                val scope = rememberCoroutineScope()
                CompositionLocalProvider(
                    LocalOperationSnackbar provides snackbar,
                    LocalOperationMessage provides { message ->
                        announced.add(message)
                        scope.launch { snackbar.showSnackbar(message, withDismissAction = true, duration = SnackbarDuration.Indefinite) }
                        Unit
                    },
                    LocalDensity provides Density(1f, fontScale.value),
                ) {
                    if (open.value) {
                        val operation = rememberModalOperation { open.value = false }
                        FormSheet("Параметры маршрута", operation.busy, { open.value = false }) {
                            Button(onClick = { operation.run { UiResult(true, notification.value) } }) { Text("Проверить") }
                            OperationFeedback(operation)
                            Button(onClick = { operation.submit { UiResult(true, "Маршрут сохранён") } }) { Text("Сохранить и закрыть") }
                        }
                    } else SnackbarHost(snackbar)
                }
            }
        }
        val notices = listOf(
            "Параметры проверены" to 1.5f,
            ("Параметры проверены.\n" + "Подробности проверки маршрута.\n".repeat(10) + "Проверка завершена.") to 2f,
        )
        for ((index, scenario) in notices.withIndex()) {
            val (message, scale) = scenario
            compose.runOnIdle { notification.value = message; fontScale.value = scale; open.value = true }
            val save = compose.onNodeWithText("Сохранить и закрыть")
            val form = compose.onNodeWithTag("waarp-form-sheet")
            val footer = compose.onNodeWithTag("waarp-form-notifications")
            val before = save.fetchSemanticsNode().boundsInRoot
            val formBefore = form.fetchSemanticsNode().boundsInRoot
            val footerBefore = footer.fetchSemanticsNode().boundsInRoot
            compose.onNodeWithText("Проверить").performClick()
            compose.waitUntil(5_000L) { host.currentSnackbarData?.visuals?.message == message }
            compose.onNodeWithText(message).assertIsDisplayed()
            assertEquals(before, save.fetchSemanticsNode().boundsInRoot)
            assertEquals(formBefore, form.fetchSemanticsNode().boundsInRoot)
            assertEquals(footerBefore, footer.fetchSemanticsNode().boundsInRoot)
            assertTrue("Notification overlaps the form", formBefore.bottom <= footerBefore.top)
            assertTrue("Notification overlaps the final action", before.bottom <= footerBefore.top)
            if (index > 0) {
                val viewport = compose.onNodeWithTag("waarp-form-notification-viewport")
                assertTrue("Long feedback must remain scrollable",
                    viewport.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].maxValue() > 0f)
                viewport.performTouchInput { swipeUp() }
                assertTrue("Feedback did not scroll inside its own viewport",
                    viewport.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value() > 0f)
                assertEquals(before, save.fetchSemanticsNode().boundsInRoot)
            }
            // Touch the real control while the notification is still visible.
            // Dismissing it before this tap would hide the overlay regression.
            compose.runOnIdle { assertEquals(message, host.currentSnackbarData?.visuals?.message) }
            save.assertIsDisplayed().performTouchInput { click() }
            compose.onNodeWithTag("waarp-form-sheet").assertDoesNotExist()
            compose.runOnIdle {
                assertEquals(listOf(message, "Маршрут сохранён"), announced.takeLast(2))
                host.currentSnackbarData?.dismiss()
            }
            compose.waitUntil(5_000L) { host.currentSnackbarData?.visuals?.message == "Маршрут сохранён" }
            compose.onNodeWithText("Маршрут сохранён").assertIsDisplayed()
            compose.runOnIdle { host.currentSnackbarData?.dismiss() }
            compose.waitUntil(5_000L) { host.currentSnackbarData == null }
        }
    }
}
