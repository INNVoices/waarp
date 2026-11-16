// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope

/** One active modal, retained only in memory across configuration changes. No saved-state handle. */
internal class ModalSessions : ViewModel() {
    private var active: Pair<String, ModalSession>? = null
    fun obtain(id: String): ModalSession {
        active?.takeIf { it.first == id }?.let { return it.second }
        active?.second?.clearText()
        return ModalSession(UiOperation(viewModelScope)).also { active = id to it }
    }
    fun clear(id: String) {
        active?.takeIf { it.first == id }?.second?.clearText()
        if (active?.first == id) active = null
    }
    override fun onCleared() { active?.second?.clearText(); active = null }
}

internal class ModalSession(val operation: UiOperation) {
    private val text = mutableMapOf<String, MutableState<String>>()
    var handledCompletion: Long = 0
    fun text(key: String): MutableState<String> = text.getOrPut(key) { mutableStateOf("") }
    fun clearText() { text.values.forEach { it.value = "" }; text.clear() }
}

internal val LocalModalSession = staticCompositionLocalOf<ModalSession?> { null }

@Composable
internal fun rememberModalText(key: String): MutableState<String> {
    val session = LocalModalSession.current
    return remember(session, key) { session?.text(key) ?: mutableStateOf("") }
}

@Composable
internal fun rememberModalOperation(onSuccess: (() -> Unit)? = null): UiOperation {
    val session = LocalModalSession.current
    val operation = session?.operation ?: rememberUiOperation()
    val successNow by rememberUpdatedState(onSuccess)
    // Execute a completion against the current composition, never an old Activity's close callback.
    LaunchedEffect(operation, operation.completions) {
        if (operation.completions > (session?.handledCompletion ?: 0) && successNow != null) {
            session?.handledCompletion = operation.completions
            successNow?.invoke()
        }
    }
    return operation
}
