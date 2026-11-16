// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import local.waarp.android.data.MAX_IMPORT_BYTES
import local.waarp.android.data.NetworkTools
import local.waarp.android.ui.WaarpApp
import local.waarp.android.ui.WaarpTheme
import java.io.File

class MainActivity : ComponentActivity() {
    private val model: MobileViewModel by viewModels()
    // Secret input is intentionally not placed into Bundle, saved-state or rememberSaveable.
    private var incomingText by mutableStateOf<String?>(null)
    private var importingExternal by mutableStateOf(false)
    private var incomingError by mutableStateOf<String?>(null)
    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.onConsentResult(result.resultCode == RESULT_OK)
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        model.pendingConsentIntent?.takeIf { model.pendingConsentToken != null }?.let(vpnConsent::launch)
    }
    private val qr = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { importText(it) }
    }
    private val documents = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val replace = model.pendingReplaceId; model.pendingReplaceId = null
        if (uris.isNotEmpty()) lifecycleScope.launch {
            if (uris.size > 20 || (replace != null && uris.size != 1)) {
                model.notifyUser(if (replace != null) "Для замены выберите один файл" else "Выберите не больше 20 файлов за один импорт", true)
                return@launch
            }
            var added = 0; var failed = 0
            for (uri in uris) {
                try {
                    val (text, name) = readDocument(uri)
                    val result = if (replace == null) model.importText(text, name) else model.replaceTunnel(replace, text)
                    if (result.ok) added++ else failed++
                    if (uris.size == 1) model.notifyUser(result.message ?: if (result.ok) "Профиль сохранён" else "Не удалось импортировать", !result.ok)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { failed++; if (uris.size == 1) model.notifyUser("Не удалось прочитать файл. Нужен текстовый конфиг до 1 МБ.", true) }
            }
            if (uris.size > 1) model.notifyUser("Файлов обработано: $added; с ошибкой: $failed", failed > 0)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            WaarpApp(state, model)
            if (incomingText != null) WaarpTheme {
                AlertDialog(
                    onDismissRequest = { if (!importingExternal) incomingText = null },
                    title = { Text("Импорт из другого приложения") },
                    text = { Text(incomingError ?: "Проверить и добавить полученный конфиг или подписку в библиотеку туннелей? После импорта назначьте нужные маршруты в Waarp.") },
                    confirmButton = {
                        TextButton(enabled = !importingExternal, onClick = {
                            val text = incomingText ?: return@TextButton
                            importingExternal = true
                            incomingError = null
                            lifecycleScope.launch {
                                try {
                                    val result = model.importText(text)
                                    model.notifyUser(result.message ?: "Импорт завершён", !result.ok)
                                    if (result.ok) incomingText = null
                                    else incomingError = result.message ?: "Не удалось импортировать конфиг"
                                } finally { importingExternal = false }
                            }
                        }) { Text(if (importingExternal) "Проверка…" else "Импортировать") }
                    },
                    dismissButton = { TextButton(enabled = !importingExternal, onClick = { incomingText = null; incomingError = null }) { Text("Отмена") } },
                )
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                model.events.collect { event ->
                    try {
                        when (event) {
                            is MobileEvent.Consent -> {
                                if (needsNotificationPermission()) {
                                    notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                                } else vpnConsent.launch(event.intent)
                            }
                            is MobileEvent.FileImport -> documents.launch(arrayOf("text/*", "application/octet-stream", "application/x-openvpn-profile", "application/json"))
                            MobileEvent.QrImport -> qr.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Наведите камеру на QR с конфигом или ссылкой").setBeepEnabled(false).setOrientationLocked(false))
                            MobileEvent.ClipboardImport -> {
                                val clipboard = getSystemService(ClipboardManager::class.java)
                                val clip = clipboard.primaryClip
                                val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).text?.toString() else null
                                if (text.isNullOrBlank()) model.notifyUser("В буфере нет текста конфигурации", true) else importText(text)
                            }
                            MobileEvent.SystemVpnSettings -> startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
                            MobileEvent.ShareDiagnostics -> shareDiagnostics()
                        }
                    } catch (_: Exception) {
                        if (event is MobileEvent.Consent) model.onConsentResult(false)
                        model.notifyUser("Android не смог открыть запрошенный экран", true)
                    }
                }
            }
        }
        if (savedInstanceState == null) receiveExternal(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receiveExternal(intent) }

    private fun needsNotificationPermission() = Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    private fun importText(text: String) {
        lifecycleScope.launch {
            val result = model.importText(text)
            model.notifyUser(result.message ?: if (result.ok) "Импорт завершён" else "Не удалось импортировать", !result.ok)
        }
    }

    private suspend fun readDocument(uri: Uri): Pair<String, String> = withContext(Dispatchers.IO) {
        require(uri.scheme == "content") { "Нужен документ из системного выбора файлов" }
        var name = ""
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0) name = cursor.getString(nameIndex).orEmpty().substringBeforeLast('.')
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) require(cursor.getLong(sizeIndex) <= MAX_IMPORT_BYTES)
            }
        }
        val bytes = contentResolver.openInputStream(uri)?.use { NetworkTools.readBounded(it) } ?: error("Документ недоступен")
        bytes.toString(Charsets.UTF_8) to name
    }

    private fun receiveExternal(intent: Intent?) {
        if (intent == null || importingExternal) return
        lifecycleScope.launch {
            try {
                val text = when (intent.action) {
                    Intent.ACTION_SEND -> {
                        val plain = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                        if (plain != null) plain else IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { readDocument(it).first }
                    }
                    Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "waarp" && it.host == "import" }?.let {
                        it.getQueryParameter("config") ?: it.getQueryParameter("text")
                    }
                    else -> null
                }
                if (text != null) {
                    require(text.toByteArray().size <= MAX_IMPORT_BYTES && text.isNotBlank())
                    incomingError = null; incomingText = text
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { model.notifyUser("Не удалось прочитать переданный конфиг", true) }
        }
    }

    private fun shareDiagnostics() {
        lifecycleScope.launch {
            val report = model.diagnosticReport()
            val file = withContext(Dispatchers.IO) {
                val directory = File(cacheDir, "diagnostics").apply { mkdirs() }
                File(directory, "waarp-diagnostics.txt").apply { writeText(report) }
            }
            val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
            val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            share.clipData = ClipData.newRawUri("Диагностика Waarp", uri)
            startActivity(Intent.createChooser(share, "Передать отчёт диагностики"))
        }
    }
}
