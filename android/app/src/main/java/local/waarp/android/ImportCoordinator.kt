// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import local.waarp.android.data.MAX_IMPORT_BYTES
import local.waarp.android.data.NetworkTools
import local.waarp.android.ui.UiResult

/** Public progress only. Received credentials stay in process memory, never in saved state. */
data class ImportUiState(val confirmationAvailable: Boolean = false, val busy: Boolean = false,
    val error: String? = null, val taskLabel: String? = null)

/** Owned by the Activity ViewModel, so rotation does not cancel a selected batch halfway through. */
internal class ImportCoordinator(
    private val scope: CoroutineScope,
    private val readDocument: suspend (Uri) -> Pair<String, String>,
    private val import: suspend (text: String, name: String, replaceId: String?) -> UiResult,
    private val notify: (String, Boolean) -> Unit,
) {
    private val _state = MutableStateFlow(ImportUiState())
    val state = _state.asStateFlow()
    private var pendingText: String? = null
    private var receiveGeneration = 0L

    fun receive(intent: Intent?) {
        if (intent == null || state.value.busy) return
        val generation = ++receiveGeneration
        scope.launch {
            try {
                val text = when (intent.action) {
                    Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                        ?: IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { readDocument(it).first }
                    Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "waarp" && it.host == "import" }?.let {
                        it.getQueryParameter("config") ?: it.getQueryParameter("text")
                    }
                    else -> null
                } ?: return@launch
                val valid = withContext(Dispatchers.Default) {
                    text.isNotBlank() && text.length <= MAX_IMPORT_BYTES && text.toByteArray(Charsets.UTF_8).size <= MAX_IMPORT_BYTES
                }
                require(valid)
                if (generation != receiveGeneration || state.value.busy) return@launch
                pendingText = text
                _state.value = ImportUiState(confirmationAvailable = true)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { if (generation == receiveGeneration) notify("Не удалось прочитать переданный конфиг", true) }
        }
    }

    fun dismiss() {
        if (state.value.busy) return
        receiveGeneration++
        pendingText = null
        _state.value = ImportUiState()
    }

    fun confirm() {
        val text = pendingText ?: return
        if (state.value.busy) return
        receiveGeneration++
        _state.value = ImportUiState(confirmationAvailable = true, busy = true)
        scope.launch {
            try {
                val result = import(text, "", null)
                if (result.ok) {
                    pendingText = null
                    _state.value = ImportUiState()
                } else _state.value = ImportUiState(confirmationAvailable = true, error = result.message ?: "Не удалось импортировать конфиг")
                notify(result.message ?: if (result.ok) "Импорт завершён" else "Не удалось импортировать", !result.ok)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _state.value = ImportUiState(confirmationAvailable = true, error = "Не удалось импортировать конфиг") }
            finally { _state.value = state.value.copy(busy = false) }
        }
    }

    fun importText(text: String) {
        if (state.value.busy) { notify("Дождитесь завершения текущего импорта", true); return }
        _state.value = state.value.copy(busy = true, taskLabel = "Проверяем полученную конфигурацию…")
        scope.launch {
            try {
                val result = import(text, "", null)
                notify(result.message ?: if (result.ok) "Импорт завершён" else "Не удалось импортировать", !result.ok)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { notify("Не удалось импортировать конфиг", true) }
            finally { _state.value = state.value.copy(busy = false, taskLabel = null) }
        }
    }

    fun importDocuments(uris: List<Uri>, replaceId: String?) {
        if (uris.isEmpty()) return
        if (state.value.busy) { notify("Дождитесь завершения текущего импорта", true); return }
        if (uris.size > 20 || (replaceId != null && uris.size != 1)) {
            notify(if (replaceId != null) "Для замены выберите один файл" else "Выберите не больше 20 файлов за один импорт", true)
            return
        }
        _state.value = state.value.copy(busy = true, taskLabel = "Импорт файлов: 0 из ${uris.size}")
        scope.launch {
            var added = 0
            var failed = 0
            try {
                for ((index, uri) in uris.withIndex()) {
                    try {
                        val (text, name) = readDocument(uri)
                        val result = import(text, name, replaceId)
                        if (result.ok) added++ else failed++
                        if (uris.size == 1) notify(result.message ?: if (result.ok) "Профиль сохранён" else "Не удалось импортировать", !result.ok)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { failed++; if (uris.size == 1) notify("Не удалось прочитать файл. Нужен текстовый конфиг до 1 МБ.", true) }
                    _state.value = state.value.copy(taskLabel = "Импорт файлов: ${index + 1} из ${uris.size}")
                }
                if (uris.size > 1) notify("Файлов обработано: $added; с ошибкой: $failed", failed > 0)
            } finally { _state.value = state.value.copy(busy = false, taskLabel = null) }
        }
    }

    fun clearSensitiveInput() { pendingText = null; receiveGeneration++ }
}

internal suspend fun readImportDocument(context: Context, uri: Uri): Pair<String, String> = withContext(Dispatchers.IO) {
    require(uri.scheme == "content")
    var name = ""
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (nameIndex >= 0) name = cursor.getString(nameIndex).orEmpty().substringBeforeLast('.')
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) require(cursor.getLong(sizeIndex) <= MAX_IMPORT_BYTES)
        }
    }
    val bytes = context.contentResolver.openInputStream(uri)?.use { NetworkTools.readBounded(it) } ?: error("Документ недоступен")
    bytes.toString(Charsets.UTF_8) to name
}
