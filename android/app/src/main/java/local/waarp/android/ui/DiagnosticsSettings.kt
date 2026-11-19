@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import local.waarp.android.i18n.localized

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Route
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Wifi
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.net.URI

@Composable
internal fun DiagnosticsScreen(state: MobileState, actions: MobileActions, onCreateRoute: (String, String) -> Unit) {
    var section by rememberSaveable { mutableStateOf("check") }
    val tabs = listOf("check" to localized("DiagnosticsSettings.c74d29c13b9d", "Проверка"), "flows" to localized("DiagnosticsSettings.3c5076a0c522", "Соединения")) +
        if (LocalDeveloperMode.current) listOf("logs" to localized("DiagnosticsSettings.aa26d844884a", "Журнал")) else emptyList()
    val active = section.takeIf { key -> tabs.any { it.first == key } } ?: "check"
    val screens = rememberSaveableStateHolder()
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            tabs.forEach { (key, label) ->
                FilterChip(active == key, onClick = { section = key }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        screens.SaveableStateProvider(active) {
        when (active) {
            "flows" -> FlowsScreen(state)
            "logs" -> LogsScreen(state, actions)
            else -> ChecksScreen(state, actions, onCreateRoute)
        }
        }
    }
}

@Composable
private fun ChecksScreen(state: MobileState, actions: MobileActions, onCreateRoute: (String, String) -> Unit) {
    val operation = rememberUiOperation()
    var target by rememberSaveable { mutableStateOf(state.diagnostic?.target.orEmpty()) }
    val diagnostic = state.diagnostic
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { TransferCheck(state, actions) }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.0230e12d29cb", "Проверить адрес"), localized("DiagnosticsSettings.b4a069535529", "Результаты показывают отдельные слои соединения"))
                OutlinedTextField(target, { target = it }, Modifier.fillMaxWidth(), label = { Text(localized("DiagnosticsSettings.4e5fad393d1f", "Домен или IP")) }, placeholder = { Text(localized("DiagnosticsSettings.ccee06303835", "example.com")) },
                    singleLine = true, enabled = !operation.busy && diagnostic?.running != true)
                ActionButton(localized("DiagnosticsSettings.19cdba1bfcd3", "Проверить соединение"), operation.busy || diagnostic?.running == true, target.isNotBlank(),
                    onClick = { operation.run({ actions.diagnose(target.trim()) }) }, modifier = Modifier.fillMaxWidth())
                if (diagnostic?.running == true) OutlinedButton(onClick = { actions.cancelDiagnostic() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(localized("DiagnosticsSettings.1c007e5fdabb", "Отменить проверку")) }
                OperationFeedback(operation)
                if (state.status.phase != ConnectionPhase.ON) Text(localized("DiagnosticsSettings.6c01225ffc71", "VPN сейчас выключен. Проверка прямого соединения не подтверждает работу туннеля."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        if (diagnostic != null) {
            item {
                Panel {
                    SectionHeading(diagnostic.routeName?.let { "$it · ${diagnostic.target}" } ?: diagnostic.target,
                        if (diagnostic.running) localized("DiagnosticsSettings.a93b57b5e2d0", "Проверка выполняется…") else localized("DiagnosticsSettings.2cb50bc4e855", "Результат последней проверки"))
                    if (diagnostic.stale) InlineMessage(localized("DiagnosticsSettings.e8c17618c751", "Сеть или настройки изменились. Результат доступен для просмотра; повторите проверку перед выбором пути."))
                    Text(local.waarp.android.data.ConnectionUses.coverage(diagnostic.connectionUse), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                    if (diagnostic.running) LinearProgressIndicator(Modifier.fillMaxWidth())
                    diagnostic.layers.forEach { layer ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            ObservationIcon(layer.result)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(layer.name, fontWeight = FontWeight.Medium)
                                Text(observationLabel(layer.result), style = MaterialTheme.typography.labelSmall, color = observationColor(layer.result))
                                if (layer.detail.isNotBlank()) Text(layer.detail, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                            }
                        }
                    }
                    diagnostic.conclusion?.let { InlineMessage(it) }
                    if (diagnostic.layers.isEmpty() && !diagnostic.running) Text(localized("DiagnosticsSettings.92fe60e0d92f", "Результаты отдельных слоёв пока отсутствуют."), color = WaarpMuted)
                }
            }
            if (diagnostic.paths.isNotEmpty()) item {
                Panel {
                    SectionHeading(localized("DiagnosticsSettings.ea4b4db918e2", "Проверенные пути"))
                    diagnostic.paths.forEach { path ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            ObservationIcon(path.result)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(path.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                if (path.attempted > 0) Text(httpCheckSummary(path), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                            }
                            Text(validLatency(path.latencyMs)?.let { localized("DiagnosticsSettings.45fbc690ad58", "{arg1} мс", formatMs(it)) } ?: observationLabel(path.result),
                                style = MaterialTheme.typography.labelMedium, color = observationColor(path.result))
                        }
                    }
                    if (!diagnostic.running && !diagnostic.stale && !diagnostic.cancelled && diagnostic.contextId == null && diagnostic.suggestedViaId != null) {
                        OutlinedButton(onClick = {
                            val host = runCatching { URI(diagnostic.target).host?.removePrefix("[")?.removeSuffix("]") }.getOrNull()
                            onCreateRoute(host?.takeIf(String::isNotBlank) ?: diagnostic.target, diagnostic.suggestedViaId)
                        }, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                            Icon(Icons.Outlined.Route, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text(localized("DiagnosticsSettings.a34e7e8b16c9", "Создать маршрут для адреса"))
                        }
                    }
                }
            }
        } else item {
            EmptyState(Icons.Outlined.MonitorHeart, localized("DiagnosticsSettings.67d788467c34", "Сначала — измерение"), localized("DiagnosticsSettings.c6a13c04fc38", "Введи адрес, чтобы увидеть результаты DNS и сетевых проверок. Недоступные или неподдерживаемые слои отмечаются отдельно."))
        }
        item {
            SectionHeading(localized("DiagnosticsSettings.77a54b6a7d42", "История задержек"), localized("DiagnosticsSettings.679b54382f24", "Только реальные измерения; пропуски не соединяются линией"), trailing = {
                IconButton(onClick = { operation.run({ actions.probeTunnels() }) }, enabled = !operation.busy && state.profiles.isNotEmpty()) { Icon(Icons.Outlined.Refresh, localized("DiagnosticsSettings.2076eec64ddd", "Проверить туннели")) }
            })
        }
        if (state.latencyHistory.isEmpty()) item { Text(localized("DiagnosticsSettings.db12d9146a55", "Пока нет измерений. Запусти проверку туннелей."), style = MaterialTheme.typography.bodyMedium, color = WaarpMuted) }
        items(state.latencyHistory, key = { it.id }, contentType = { "history" }) { history -> LatencyChart(history) }
    }
}

@Composable
private fun TransferCheck(state: MobileState, actions: MobileActions) {
    val operation = rememberUiOperation()
    var profile by rememberSaveable { mutableStateOf("") }
    var upload by remember { mutableStateOf("") }
    var advanced by rememberSaveable { mutableStateOf(false) }
    val profiles = state.profiles.filter { !it.revoked && !it.subscriptionMissing && it.source == ProfileSource.PERSONAL }
    val choices = profiles.map { PathChoice(it.id, it.name, it.protocol) }
    val result = state.transfer
    val busy = operation.busy || result?.running == true
    Panel {
        SectionHeading(localized("DiagnosticsSettings.d1e76005b2af", "Проверить передачу данных"), localized("DiagnosticsSettings.61d98ce6731b", "Контрольный текст: 158 КиБ. Целостность проверяется, один пинг не считается успехом."))
        PathField(localized("DiagnosticsSettings.a9f8c1523d53", "Личный туннель"), profile, choices, enabled = !busy) { profile = it }
        Text(localized("DiagnosticsSettings.6e1b4ea035ce", "Проверка обращается к rfc-editor.org только по нажатию. Работу остальных сайтов она не гарантирует."),
            style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        BooleanOption(localized("DiagnosticsSettings.f1d4b382df48", "Также проверить отправку"), value = advanced, enabled = !busy) { advanced = it }
        if (advanced) {
            OutlinedTextField(upload, { upload = it }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy,
                label = { Text(localized("DiagnosticsSettings.6b045623becc", "HTTPS-адрес вашего тестового сервера")) })
            Text(localized("DiagnosticsSettings.b5b6f1ea628c", "Без адреса отправка не измеряется. Сервер должен подтвердить размер и SHA-256 полученных 64 КиБ. Для отправки включите VPN и выберите этот же туннель для служебных загрузок в настройках."),
                style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        if (busy) OutlinedButton(onClick = actions::cancelTransfer, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(localized("DiagnosticsSettings.3c6dcf049501", "Отменить проверку")) }
        else ActionButton(if (advanced) localized("DiagnosticsSettings.16665d7c6d67", "Проверить получение и отправку") else localized("DiagnosticsSettings.1b3f6cc23233", "Проверить получение"), false,
            profiles.any { it.id == profile } && (!advanced || upload.isNotBlank()),
            onClick = { operation.run({ actions.measureTransfer(profile, upload.trim().takeIf { advanced && it.isNotBlank() }) }) }, modifier = Modifier.fillMaxWidth())
        OperationFeedback(operation)
        Column(Modifier.fillMaxWidth().heightIn(min = 80.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            fun text(value: TransferDirectionUi?) = when (value?.state) {
                "pass" -> localized("DiagnosticsSettings.adc7c6cd78d1", "Подтверждено · {arg1} байт · {arg2} мс", value.bytes, value.elapsedMs ?: 0)
                "fail" -> localized("DiagnosticsSettings.b8ba3b59f717", "Не подтверждено · {arg1}", when (value.reason) { "content", "size", "truncated" -> localized("DiagnosticsSettings.afa4b11f49a4", "ответ неполный или другой"); "acknowledgement" -> localized("DiagnosticsSettings.7852fa77b6c2", "сервер не подтвердил данные"); else -> localized("DiagnosticsSettings.d8069f063ccf", "ошибка соединения или ответа") })
                else -> when (value?.reason) { "service_path" -> localized("DiagnosticsSettings.3a87fa79b73e", "Не измерено · нужен активный служебный путь"); else -> localized("DiagnosticsSettings.f0d7d6802acd", "Не измерено") }
            }
            Text(localized("DiagnosticsSettings.8232a0f0319d", "Получение: {arg1}", text(result?.download)), style = MaterialTheme.typography.bodySmall)
            Text(localized("DiagnosticsSettings.9207c19660a1", "Отправка: {arg1}", text(result?.upload)), style = MaterialTheme.typography.bodySmall)
            if (result?.checkedAt != null) Text(localized("DiagnosticsSettings.54605aa833b0", "{arg1} · {arg2}", profiles.find { it.id == result.profileId }?.name ?: localized("DiagnosticsSettings.d864b0a1a233", "Выбранный профиль"), java.text.DateFormat.getDateTimeInstance().format(java.util.Date(result.checkedAt))),
                style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
        }
    }
}

@Composable
private fun ObservationIcon(result: ObservationResult) {
    Icon(when (result) { ObservationResult.OK -> Icons.Outlined.CheckCircleOutline; ObservationResult.FAILED -> Icons.Outlined.ErrorOutline;
        ObservationResult.SKIPPED -> Icons.Outlined.Close; ObservationResult.UNKNOWN -> Icons.Outlined.Info },
        observationLabel(result), Modifier.size(22.dp), tint = observationColor(result))
}

@Composable
private fun observationColor(result: ObservationResult): Color = when (result) {
    ObservationResult.OK -> WaarpGreen
    ObservationResult.FAILED -> MaterialTheme.colorScheme.error
    ObservationResult.SKIPPED, ObservationResult.UNKNOWN -> WaarpMuted
}

private fun observationLabel(result: ObservationResult): String = when (result) {
    ObservationResult.OK -> localized("DiagnosticsSettings.8014726cd9b1", "Успешно")
    ObservationResult.FAILED -> localized("DiagnosticsSettings.89f621652be3", "Ошибка")
    ObservationResult.SKIPPED -> localized("DiagnosticsSettings.9111f928977f", "Пропущено")
    ObservationResult.UNKNOWN -> localized("DiagnosticsSettings.3da959ef86f2", "Не проверено")
}

@Composable
private fun LatencyChart(history: LatencySeriesUi) {
    val samples = remember(history.samplesMs) { history.samplesMs.takeLast(120).map(::validLatency) }
    val measured = samples.filterNotNull()
    val max = (measured.maxOrNull() ?: 1.0).coerceAtLeast(1.0)
    val stroke = WaarpOrange
    val grid = MaterialTheme.colorScheme.outlineVariant
    Panel {
        SectionHeading(history.name, if (measured.isEmpty()) localized("DiagnosticsSettings.82e080972a1c", "Успешных измерений пока нет") else localized("DiagnosticsSettings.cf044f20d9e8", "Последнее: {arg1}", samples.lastOrNull()?.let { localized("DiagnosticsSettings.57c4e37e6e7e", "{arg1} мс", formatMs(it)) } ?: localized("DiagnosticsSettings.f984f34a3388", "нет ответа")))
        if (samples.isNotEmpty()) {
            Text(localized("DiagnosticsSettings.a3afd12d543a", "{arg1} мс", formatMs(max)), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            Canvas(Modifier.fillMaxWidth().height(90.dp).semantics { contentDescription = localized("DiagnosticsSettings.5ea17f902a46", "{arg1}: {arg2} успешных измерений из {arg3}", history.name, measured.size, samples.size) }) {
                val top = 4.dp.toPx()
                val height = (size.height - top * 2).coerceAtLeast(1f)
                drawLine(grid, Offset(0f, top + height), Offset(size.width, top + height), 1.dp.toPx())
                drawLine(grid.copy(alpha = .5f), Offset(0f, top + height / 2), Offset(size.width, top + height / 2), 1.dp.toPx())
                var previous: Offset? = null
                samples.forEachIndexed { index, sample ->
                    if (sample == null) previous = null
                    else {
                        val x = if (samples.size == 1) size.width / 2 else index.toFloat() / (samples.size - 1) * size.width
                        val point = Offset(x, top + height * (1 - sample / max).toFloat())
                        previous?.let { drawLine(stroke, it, point, 2.dp.toPx()) }
                        drawCircle(stroke, 2.dp.toPx(), point)
                        previous = point
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(localized("DiagnosticsSettings.1032e2df4ce4", "Раньше"), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                Text(localized("DiagnosticsSettings.e2b7e68a521d", "Последнее"), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            }
        }
    }
}

@Composable
private fun FlowsScreen(state: MobileState) {
    var query by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val flows = remember(state.flows, query) { state.flows.filter { flow -> listOf(flow.appName, flow.packageName, flow.host, flow.viaLabel).any { it.contains(query, true) } } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SearchField(query, { query = it }, localized("DiagnosticsSettings.3187e82bcbe8", "Приложение, адрес или путь")) }
        item { SectionHeading(localized("DiagnosticsSettings.45d585c40d37", "{arg1} соединений", flows.size), if (state.status.phase == ConnectionPhase.ON) localized("DiagnosticsSettings.2c245cd7572c", "Наблюдаемые движком сейчас") else localized("DiagnosticsSettings.c7358ff05e55", "VPN выключен; последние наблюдения")) }
        if (flows.isEmpty()) item {
            EmptyState(Icons.Outlined.Wifi, localized("DiagnosticsSettings.14b2f6c85be0", "Нет наблюдаемых соединений"), if (state.status.phase == ConnectionPhase.ON) localized("DiagnosticsSettings.91e8aefcb45a", "Открой приложение с включённым маршрутом. Его соединения появятся здесь.")
                else localized("DiagnosticsSettings.f1c489fe7009", "Включи VPN и открой приложение, чтобы увидеть реальные соединения."))
        }
        items(flows, key = { it.id }, contentType = { "flow" }) { flow ->
            Panel {
                Column(Modifier.fillMaxWidth().clickable { selected = if (selected == flow.id) null else flow.id }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(flow.appName.ifBlank { localized("DiagnosticsSettings.32a65b7167bf", "Приложение не определено") }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(localized("DiagnosticsSettings.b83ff58bdd1c", "{arg1}:{arg2}", flow.host, flow.port), style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Icon(Icons.Outlined.ChevronRight, if (selected == flow.id) localized("DiagnosticsSettings.8fbfdca2b18e", "Свернуть соединение") else localized("DiagnosticsSettings.379c6567bf30", "Подробности соединения"))
                    }
                    Text(localized("DiagnosticsSettings.2a131d1d1911", "{arg1} · {arg2}", flow.network.uppercase(), flow.viaLabel), style = MaterialTheme.typography.labelMedium)
                    Text(localized("DiagnosticsSettings.c7592bc8126e", "↓ {arg1}  ·  ↑ {arg2}", formatBytes(flow.downloadedBytes), formatBytes(flow.uploadedBytes)), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                }
                if (selected == flow.id) SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (flow.packageName.isNotBlank()) KeyValue(localized("DiagnosticsSettings.1def6cecfaef", "Пакет Android"), flow.packageName, mono = true)
                        if (flow.rule.isNotBlank()) KeyValue(localized("DiagnosticsSettings.cb883d4760c0", "Совпавшее правило"), flow.rule)
                        KeyValue(localized("DiagnosticsSettings.c83f57b7e34c", "Идентификатор соединения"), flow.id, mono = true)
                    }
                }
            }
        }
    }
}

@Composable
private fun LogsScreen(state: MobileState, actions: MobileActions) {
    val operation = rememberUiOperation()
    var query by rememberSaveable { mutableStateOf("") }
    var preview by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { operation.run({ actions.readLogs() }) }
    val lines = remember(state.logs, query) { state.logs.filter { it.text.contains(query, true) }.takeLast(400) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { operation.run({ actions.readLogs() }) }, enabled = !operation.busy, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("DiagnosticsSettings.7e82d63a0ba3", "Обновить")) }
                OutlinedButton(onClick = { preview = true }, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Icon(Icons.Outlined.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("DiagnosticsSettings.dffd7203277a", "Отчёт")) }
            }
            OperationFeedback(operation)
        }
        item { SearchField(query, { query = it }, localized("DiagnosticsSettings.f200216fc1e3", "Найти в журнале")) }
        item { Text(localized("DiagnosticsSettings.8e0df7ab1b0b", "Последние {arg1} строк. Отчёт подготавливается без приватных ключей и ссылок подписок.", lines.size), style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
        if (lines.isEmpty()) item { EmptyState(Icons.Outlined.Description, localized("DiagnosticsSettings.ba3c06d3b78e", "Журнал пуст"), localized("DiagnosticsSettings.4a6f8cdd883c", "События работы движка появятся после запуска. Для свежих данных нажми «Обновить».")) }
        items(lines, key = { it.id }, contentType = { "log" }) { line ->
            SelectionContainer {
                Text(line.text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                    color = if (line.text.contains("error", true) || line.text.contains("ошибка", true)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
            }
        }
    }
    if (preview) AlertDialog(onDismissRequest = { preview = false }, title = { Text(localized("DiagnosticsSettings.29b4c07b657f", "Диагностика доступна без VPN")) },
        text = {
            Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(localized("DiagnosticsSettings.afb85fffec3d", "В отчёте: версии, состояния VPN, счётчики, категории ошибок и проверка передачи. Конфиги, адреса серверов, ссылки подписок и строки журнала не включаются."))
                SelectionContainer { Text(state.savedDiagnostics ?: localized("DiagnosticsSettings.7a710dd7809b", "Сохранённых сессий пока нет"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                TextButton(onClick = { operation.run({ actions.clearDiagnosticHistory() }) }, enabled = !operation.busy) { Text(localized("DiagnosticsSettings.23f32036856e", "Удалить сохранённую историю")) }
            }
        }, confirmButton = { TextButton(onClick = actions::shareDiagnostics) { Text(localized("DiagnosticsSettings.099b7982ebd5", "Поделиться отчётом")) } },
        dismissButton = { TextButton(onClick = { preview = false }) { Text(localized("DiagnosticsSettings.8754ca7d0e8d", "Закрыть")) } })
}

@Composable
internal fun SettingsScreen(state: MobileState, actions: MobileActions, setDeveloper: (Boolean) -> Unit) {
    val developer = LocalDeveloperMode.current
    val operation = rememberUiOperation()
    Column(Modifier.fillMaxSize()) {
    if (operation.error != null) Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { OperationFeedback(operation) }
    else OperationFeedback(operation)
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.5d4f9b0d968e", "Маршрутизация"))
                BooleanOption(localized("DiagnosticsSettings.f425282ee2d0", "Локальная сеть напрямую"), localized("DiagnosticsSettings.7ebbd748880e", "Доступ к устройствам и сервисам в локальной сети"), state.settings.lanDirect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(lanDirect = it)) })
                }
                HorizontalDivider()
                BooleanOption(localized("DiagnosticsSettings.1e83282c787e", "Домены .ru, .su и .рф напрямую"), localized("DiagnosticsSettings.06cf64473f50", "Исключение для доменов; не определяет страну сервера по IP"), state.settings.ruDirect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(ruDirect = it)) })
                }
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.fc547bd61a93", "Общий DNS Android"))
                Text(localized("DiagnosticsSettings.1a2eaf09457d", "Android иногда не передаёт приложение DNS-запроса, особенно в версиях 10 и 11; для таких запросов используется общий путь."),
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                val choices = listOf(PathChoice(SYSTEM_DNS_AUTOMATIC, localized("DiagnosticsSettings.af3ff3c12a2d", "Автоматически по маршрутам"), localized("DiagnosticsSettings.54b6ccfbcb0f", "Общий путь определяется по включённым маршрутам"))) +
                    rememberPathChoices(state).map { if (it.id == AUTO_PATH) it.copy(name = localized("DiagnosticsSettings.579ffbb0216f", "Авто: свои туннели")) else it }
                PathField(localized("DiagnosticsSettings.60db6fe522ea", "Путь общего DNS"), state.settings.systemDnsViaId ?: SYSTEM_DNS_AUTOMATIC,
                    choices, enabled = !operation.busy) { chosen ->
                    operation.run({ actions.setSystemDnsPath(chosen.takeUnless { it == SYSTEM_DNS_AUTOMATIC }) })
                }
                val dnsHint = state.settings.systemDnsHint
                if (!dnsHint.isNullOrBlank()) InlineMessage(dnsHint, error = state.settings.systemDnsBlocked)
                else if (state.settings.systemDnsBlocked) {
                    InlineMessage(localized("DiagnosticsSettings.d5e91c64c1f1", "Общий DNS заблокирован: у приложений разные пути. Выбери туннель или группу для общих DNS-запросов."), error = true)
                }
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.81d27e93a37c", "Служебные загрузки"), localized("DiagnosticsSettings.10942d757c91", "Обновление подписок и публичного каталога"))
                val choices = listOf(PathChoice(DIRECT_PATH, localized("DiagnosticsSettings.963c03f4ffdc", "Напрямую"), localized("DiagnosticsSettings.42a3ea84bbd7", "Через физическую сеть"))) +
                    state.profiles.filter { !it.revoked && !it.subscriptionMissing && it.source == ProfileSource.PERSONAL }
                        .map { PathChoice(it.id, it.name, it.protocol) }
                PathField(localized("DiagnosticsSettings.0314bd4d8690", "Разрешённый путь"), state.settings.serviceViaId, choices, enabled = !operation.busy) { id ->
                    operation.run({ actions.setServicePath(id) })
                }
                Text(localized("DiagnosticsSettings.1a871de48041", "Для выбранного туннеля нужен включённый VPN. При его отказе прямого резерва нет. Последний успешно загруженный каталог остаётся доступен без сети."),
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.3fbac9995a54", "Запуск и уведомления"))
                BooleanOption(localized("DiagnosticsSettings.9a274c9e08f5", "Подключаться при запуске"), localized("DiagnosticsSettings.3cf307d417bb", "Включать сохранённые маршруты при открытии Waarp"), state.settings.autoConnect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(autoConnect = it)) })
                }
                HorizontalDivider()
                BooleanOption(localized("DiagnosticsSettings.f747d9df20fd", "Уведомления об ошибках"), localized("DiagnosticsSettings.c4e8c637420d", "Дополнительные сообщения об ошибках и смене состояния"), state.settings.notifications, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(notifications = it)) })
                }
                Text(localized("DiagnosticsSettings.eb9b7da3156b", "Служебное уведомление активного VPN требуется Android."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.cd70145d4dfd", "Защита Android"))
                KeyValue(localized("DiagnosticsSettings.d27d7eebca45", "Постоянный VPN"), booleanStatus(state.settings.systemAlwaysOn))
                KeyValue(localized("DiagnosticsSettings.ca6809280be0", "Блокировать соединения без VPN"), booleanStatus(state.settings.systemLockdown))
                Text(localized("DiagnosticsSettings.115e811bc156", "Эти параметры задаются в системных настройках VPN. Их состояние может быть неизвестно, пока служба не запущена."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                OutlinedButton(onClick = actions::openSystemVpnSettings, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text(localized("DiagnosticsSettings.654b9febabe2", "Открыть настройки VPN Android")); Spacer(Modifier.width(8.dp)); Icon(Icons.Outlined.ChevronRight, null) }
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.1837c198ac0c", "Обслуживание"))
                BooleanOption(localized("DiagnosticsSettings.60e1e60cf250", "Для разработчиков"), localized("DiagnosticsSettings.4f24fe5c2219", "Журнал ядра и технические сведения о подключениях"), developer, onChange = setDeveloper)
                Text(localized("DiagnosticsSettings.d8df815cd57e", "Восстановление завершает оставшееся состояние службы после сбоя. Сохранённые профили и маршруты остаются на месте."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                OutlinedButton(onClick = { operation.run({ actions.recover() }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                    Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text(localized("DiagnosticsSettings.31adef21f0cc", "Восстановить состояние VPN"))
                }
                OutlinedButton(onClick = { operation.run({ actions.refresh() }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text(localized("DiagnosticsSettings.bdcdf3fb2cf3", "Обновить данные приложения")) }
                OutlinedButton(onClick = actions::shareDiagnostics, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.Share, null); Spacer(Modifier.width(8.dp)); Text(localized("DiagnosticsSettings.873da6306d86", "Поделиться диагностикой")) }
            }
        }
        item {
            Panel {
                SectionHeading(localized("DiagnosticsSettings.4091c894617a", "Waarp для Android"))
                KeyValue(localized("DiagnosticsSettings.ae6cdb8b3d4a", "Приложение"), state.appVersion.ifBlank { localized("DiagnosticsSettings.a494d55e4d35", "Версия не определена") })
                if (developer) KeyValue(localized("DiagnosticsSettings.38d25753bae3", "Движок"), state.engineVersion.ifBlank { localized("DiagnosticsSettings.a494d55e4d35", "Версия не определена") })
                if (developer) Text(localized("DiagnosticsSettings.2e003f6d8eb9", "Маршруты приложений используют пакеты и UID Android. Конфигурация и ключи хранятся в закрытом хранилище приложения."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
    }
    }
}

private fun booleanStatus(value: Boolean?) = when (value) { true -> localized("DiagnosticsSettings.80e36dd52de6", "Включено"); false -> localized("DiagnosticsSettings.400acc0b9a4d", "Выключено"); null -> localized("DiagnosticsSettings.e60915eafebc", "Пока неизвестно") }

// Screen-only option. It must be converted to null before calling the backend;
// AUTO_PATH selects the actual automatic tunnel group and has different semantics.
private const val SYSTEM_DNS_AUTOMATIC = "system-dns:automatic"
