// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
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
import androidx.lifecycle.DEFAULT_ARGS_KEY
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.MutableCreationExtras
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import local.waarp.android.ui.WaarpApp
import local.waarp.android.ui.WaarpTheme
import java.io.File

class MainActivity : ComponentActivity() {
    private var pendingRestart by mutableStateOf<MobileEvent.RestartApproval?>(null)
    private fun answerRestart(approved: Boolean) {
        pendingRestart?.response?.complete(approved)
        pendingRestart = null
    }
    private val model: MobileViewModel by viewModels(extrasProducer = {
        MutableCreationExtras(defaultViewModelCreationExtras).apply {
            // ComponentActivity otherwise copies all incoming Intent extras into
            // SavedStateHandle, including externally shared VPN credentials.
            // Imports are explicitly handled in memory by ImportCoordinator.
            this[DEFAULT_ARGS_KEY] = Bundle()
        }
    })
    private val vpnConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.onConsentResult(result.resultCode == RESULT_OK)
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        model.currentConsentIntent()?.let(vpnConsent::launch)
    }
    private val qr = registerForActivityResult(ScanContract()) { result -> model.onQrResult(result.contents) }
    private val documents = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> model.onDocumentsPicked(uris) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Compose uses a dark theme regardless of the device theme. Keep system
        // icons legible on that surface, including on light-theme Android 10.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            val incoming by model.imports.state.collectAsStateWithLifecycle()
            WaarpApp(state, model)
            if (pendingRestart != null) WaarpTheme {
                AlertDialog(
                    onDismissRequest = { answerRestart(false) },
                    title = { Text("Перезапуск VPN") },
                    text = { Text("Для этого изменения требуется перезапустить VPN. Это временно прервёт работающие соединения.\n\nОтмена сохранит текущий туннель и прежние правила.") },
                    confirmButton = { TextButton(onClick = { answerRestart(true) }) { Text("Перезапустить VPN") } },
                    dismissButton = { TextButton(onClick = { answerRestart(false) }) { Text("Отмена") } },
                )
            }
            if (incoming.confirmationAvailable) WaarpTheme {
                AlertDialog(
                    onDismissRequest = model.imports::dismiss,
                    title = { Text("Импорт из другого приложения") },
                    text = { Text(incoming.error ?: "Проверить и добавить полученный конфиг или подписку в библиотеку туннелей? После импорта назначьте нужные маршруты в Waarp.") },
                    confirmButton = {
                        TextButton(enabled = !incoming.busy, onClick = model.imports::confirm) {
                            Text(if (incoming.busy) "Проверка…" else "Импортировать")
                        }
                    },
                    dismissButton = { TextButton(enabled = !incoming.busy, onClick = model.imports::dismiss) { Text("Отмена") } },
                )
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                model.events.collect { event ->
                    try {
                        when (event) {
                            is MobileEvent.Consent -> {
                                if (!model.isCurrentConsent(event.token)) return@collect
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
                                if (text.isNullOrBlank()) model.notifyUser("В буфере нет текста конфигурации", true) else model.imports.importText(text)
                            }
                            MobileEvent.SystemVpnSettings -> startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
                            MobileEvent.ShareDiagnostics -> shareDiagnostics()
                            is MobileEvent.RestartApproval -> {
                                pendingRestart?.response?.complete(false)
                                pendingRestart = event
                            }
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) {
                        if (event is MobileEvent.FileImport || event is MobileEvent.QrImport) model.cancelImportPicker()
                        if (event is MobileEvent.Consent) model.onConsentResult(false)
                        if (event is MobileEvent.RestartApproval) event.response.complete(false)
                        model.notifyUser("Android не смог открыть запрошенный экран", true)
                    }
                }
            }
        }
        if (savedInstanceState == null) model.imports.receive(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); model.imports.receive(intent) }

    override fun onResume() { super.onResume(); model.onForeground() }
    override fun onDestroy() { answerRestart(false); super.onDestroy() }

    private fun needsNotificationPermission() = Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    private fun shareDiagnostics() {
        lifecycleScope.launch {
            try {
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
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { model.notifyUser("Не удалось подготовить или передать отчёт диагностики", true) }
        }
    }
}
