// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import local.waarp.android.i18n.localized

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
            catch (_: Exception) { if (generation == receiveGeneration) notify(localized("ImportCoordinator.9a75aba3e25c", "Не удалось прочитать переданный конфиг"), true) }
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
                } else _state.value = ImportUiState(confirmationAvailable = true, error = result.message ?: localized("ImportCoordinator.4573510c31e6", "Не удалось импортировать конфиг"))
                notify(result.message ?: if (result.ok) localized("ImportCoordinator.f22d7a4a650e", "Импорт завершён") else localized("ImportCoordinator.4d2d42e43b72", "Не удалось импортировать"), !result.ok)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _state.value = ImportUiState(confirmationAvailable = true, error = localized("ImportCoordinator.4573510c31e6", "Не удалось импортировать конфиг")) }
            finally { _state.value = state.value.copy(busy = false) }
        }
    }

    fun importText(text: String) {
        if (state.value.busy) { notify(localized("ImportCoordinator.330a3ff955cd", "Дождитесь завершения текущего импорта"), true); return }
        _state.value = state.value.copy(busy = true, taskLabel = localized("ImportCoordinator.a6a906a0f554", "Проверяем полученную конфигурацию…"))
        scope.launch {
            try {
                val result = import(text, "", null)
                notify(result.message ?: if (result.ok) localized("ImportCoordinator.e9b96935e09d", "Импорт завершён") else localized("ImportCoordinator.b095650e6e79", "Не удалось импортировать"), !result.ok)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { notify(localized("ImportCoordinator.d7995245e80d", "Не удалось импортировать конфиг"), true) }
            finally { _state.value = state.value.copy(busy = false, taskLabel = null) }
        }
    }

    fun importDocuments(uris: List<Uri>, replaceId: String?) {
        if (uris.isEmpty()) return
        if (state.value.busy) { notify(localized("ImportCoordinator.3e718cfb9e46", "Дождитесь завершения текущего импорта"), true); return }
        if (uris.size > 20 || (replaceId != null && uris.size != 1)) {
            notify(if (replaceId != null) localized("ImportCoordinator.8af8c1946222", "Для замены выберите один файл") else localized("ImportCoordinator.4bdc0a7059e8", "Выберите не больше 20 файлов за один импорт"), true)
            return
        }
        _state.value = state.value.copy(busy = true, taskLabel = localized("ImportCoordinator.214db5817bea", "Импорт файлов: 0 из {arg1}", uris.size))
        scope.launch {
            var added = 0
            var failed = 0
            try {
                for ((index, uri) in uris.withIndex()) {
                    try {
                        val (text, name) = readDocument(uri)
                        val result = import(text, name, replaceId)
                        if (result.ok) added++ else failed++
                        if (uris.size == 1) notify(result.message ?: if (result.ok) localized("ImportCoordinator.5ef87aa8a952", "Профиль сохранён") else localized("ImportCoordinator.05fb38d8a261", "Не удалось импортировать"), !result.ok)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { failed++; if (uris.size == 1) notify(localized("ImportCoordinator.393ee8101882", "Не удалось прочитать файл. Нужен текстовый конфиг до 1 МБ."), true) }
                    _state.value = state.value.copy(taskLabel = localized("ImportCoordinator.5da9a00133d9", "Импорт файлов: {arg1} из {arg2}", index + 1, uris.size))
                }
                if (uris.size > 1) notify(localized("ImportCoordinator.f3bbc503c51f", "Файлов обработано: {arg1}; с ошибкой: {arg2}", added, failed), failed > 0)
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
    val bytes = context.contentResolver.openInputStream(uri)?.use { NetworkTools.readBounded(it) } ?: error(localized("ImportCoordinator.7dd5d6175f0c", "Документ недоступен"))
    bytes.toString(Charsets.UTF_8) to name
}
