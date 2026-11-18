package local.waarp.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
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
        compose.setContent {
            WaarpTheme {
                var open by remember { mutableStateOf(true) }
                val snackbar = remember { SnackbarHostState() }.also { host = it }
                val scope = rememberCoroutineScope()
                CompositionLocalProvider(
                    LocalOperationSnackbar provides snackbar,
                    LocalOperationMessage provides { message -> scope.launch { snackbar.showSnackbar(message, withDismissAction = true) }; Unit },
                    LocalDensity provides Density(1f, 1.5f),
                ) {
                    if (open) {
                        val operation = rememberModalOperation { open = false }
                        FormSheet("Параметры маршрута", operation.busy, { open = false }) {
                            Button(onClick = { operation.run { UiResult(true, "Параметры проверены") } }) { Text("Проверить") }
                            OperationFeedback(operation)
                            Button(onClick = { operation.submit { UiResult(true, "Маршрут сохранён") } }) { Text("Сохранить и закрыть") }
                        }
                    } else SnackbarHost(snackbar)
                }
            }
        }
        val save = compose.onNodeWithText("Сохранить и закрыть")
        val before = save.fetchSemanticsNode().boundsInRoot
        compose.onNodeWithText("Проверить").performClick()
        compose.onNodeWithText("Параметры проверены").assertIsDisplayed()
        assertEquals(before, save.fetchSemanticsNode().boundsInRoot)
        compose.runOnIdle { host.currentSnackbarData?.dismiss() }
        save.performClick()
        compose.onNodeWithTag("waarp-form-sheet").assertDoesNotExist()
        compose.onNodeWithText("Маршрут сохранён").assertIsDisplayed()
    }
}
