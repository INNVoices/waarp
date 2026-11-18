@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

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
    val screens = rememberSaveableStateHolder()
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("check" to "Проверка", "flows" to "Соединения", "logs" to "Журнал").forEach { (key, label) ->
                FilterChip(section == key, onClick = { section = key }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        screens.SaveableStateProvider(section) {
        when (section) {
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
                SectionHeading("Проверить адрес", "Результаты показывают отдельные слои соединения")
                OutlinedTextField(target, { target = it }, Modifier.fillMaxWidth(), label = { Text("Домен или IP") }, placeholder = { Text("example.com") },
                    singleLine = true, enabled = !operation.busy && diagnostic?.running != true)
                ActionButton("Проверить соединение", operation.busy || diagnostic?.running == true, target.isNotBlank(),
                    onClick = { operation.run({ actions.diagnose(target.trim()) }) }, modifier = Modifier.fillMaxWidth())
                OperationFeedback(operation)
                if (state.status.phase != ConnectionPhase.ON) Text("VPN сейчас выключен. Проверка прямого соединения не подтверждает работу туннеля.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        if (diagnostic != null) {
            item {
                Panel {
                    SectionHeading(diagnostic.target, if (diagnostic.running) "Проверка выполняется…" else "Результат последней проверки")
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
                    if (diagnostic.layers.isEmpty() && !diagnostic.running) Text("Результаты отдельных слоёв пока отсутствуют.", color = WaarpMuted)
                }
            }
            if (diagnostic.paths.isNotEmpty()) item {
                Panel {
                    SectionHeading("Проверенные пути")
                    diagnostic.paths.forEach { path ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            ObservationIcon(path.result)
                            Text(path.name, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(validLatency(path.latencyMs)?.let { "${formatMs(it)} мс" } ?: observationLabel(path.result),
                                style = MaterialTheme.typography.labelMedium, color = observationColor(path.result))
                        }
                    }
                    if (!diagnostic.running && diagnostic.suggestedViaId != null) {
                        OutlinedButton(onClick = {
                            val host = runCatching { URI(diagnostic.target).host?.removePrefix("[")?.removeSuffix("]") }.getOrNull()
                            onCreateRoute(host?.takeIf(String::isNotBlank) ?: diagnostic.target, diagnostic.suggestedViaId)
                        }, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                            Icon(Icons.Outlined.Route, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)); Text("Создать маршрут для адреса")
                        }
                    }
                }
            }
        } else item {
            EmptyState(Icons.Outlined.MonitorHeart, "Сначала — измерение", "Введи адрес, чтобы увидеть результаты DNS и сетевых проверок. Недоступные или неподдерживаемые слои отмечаются отдельно.")
        }
        item {
            SectionHeading("История задержек", "Только реальные измерения; пропуски не соединяются линией", trailing = {
                IconButton(onClick = { operation.run({ actions.probeTunnels() }) }, enabled = !operation.busy && state.profiles.isNotEmpty()) { Icon(Icons.Outlined.Refresh, "Проверить туннели") }
            })
        }
        if (state.latencyHistory.isEmpty()) item { Text("Пока нет измерений. Запусти проверку туннелей.", style = MaterialTheme.typography.bodyMedium, color = WaarpMuted) }
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
        SectionHeading("Проверить передачу данных", "Контрольный текст: 158 КиБ. Целостность проверяется, один пинг не считается успехом.")
        PathField("Личный туннель", profile, choices, enabled = !busy) { profile = it }
        Text("Проверка обращается к rfc-editor.org только по нажатию. Работу остальных сайтов она не гарантирует.",
            style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        TextButton(onClick = { advanced = !advanced }, enabled = !busy) { Text(if (advanced) "Скрыть проверку отправки" else "Проверить также отправку…") }
        if (advanced) {
            OutlinedTextField(upload, { upload = it }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy,
                label = { Text("HTTPS-адрес вашего тестового сервера") })
            Text("Без адреса отправка не измеряется. Сервер должен подтвердить размер и SHA-256 полученных 64 КиБ. Для отправки включите VPN и выберите этот же туннель для служебных загрузок в настройках.",
                style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        if (busy) OutlinedButton(onClick = actions::cancelTransfer, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Отменить проверку") }
        else ActionButton("Проверить получение и отправку", false, profile in profiles.map { it.id },
            onClick = { operation.run({ actions.measureTransfer(profile, upload.trim().takeIf(String::isNotBlank)) }) }, modifier = Modifier.fillMaxWidth())
        OperationFeedback(operation)
        Column(Modifier.fillMaxWidth().heightIn(min = 80.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            fun text(value: TransferDirectionUi?) = when (value?.state) {
                "pass" -> "Подтверждено · ${value.bytes} байт · ${value.elapsedMs ?: 0} мс"
                "fail" -> "Не подтверждено · ${when (value.reason) { "content", "size", "truncated" -> "ответ неполный или другой"; "acknowledgement" -> "сервер не подтвердил данные"; else -> "ошибка соединения или ответа" }}"
                else -> when (value?.reason) { "service_path" -> "Не измерено · нужен активный служебный путь"; else -> "Не измерено" }
            }
            Text("Получение: ${text(result?.download)}", style = MaterialTheme.typography.bodySmall)
            Text("Отправка: ${text(result?.upload)}", style = MaterialTheme.typography.bodySmall)
            if (result?.checkedAt != null) Text("${profiles.find { it.id == result.profileId }?.name ?: "Выбранный профиль"} · ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(result.checkedAt))}",
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
    ObservationResult.OK -> "Успешно"
    ObservationResult.FAILED -> "Ошибка"
    ObservationResult.SKIPPED -> "Пропущено"
    ObservationResult.UNKNOWN -> "Не проверено"
}

@Composable
private fun LatencyChart(history: LatencySeriesUi) {
    val samples = remember(history.samplesMs) { history.samplesMs.takeLast(120).map(::validLatency) }
    val measured = samples.filterNotNull()
    val max = (measured.maxOrNull() ?: 1.0).coerceAtLeast(1.0)
    val stroke = WaarpOrange
    val grid = MaterialTheme.colorScheme.outlineVariant
    Panel {
        SectionHeading(history.name, if (measured.isEmpty()) "Успешных измерений пока нет" else "Последнее: ${samples.lastOrNull()?.let { "${formatMs(it)} мс" } ?: "нет ответа"}")
        if (samples.isNotEmpty()) {
            Text("${formatMs(max)} мс", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            Canvas(Modifier.fillMaxWidth().height(90.dp).semantics { contentDescription = "${history.name}: ${measured.size} успешных измерений из ${samples.size}" }) {
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
                Text("Раньше", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                Text("Последнее", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
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
        item { SearchField(query, { query = it }, "Приложение, адрес или путь") }
        item { SectionHeading("${flows.size} соединений", if (state.status.phase == ConnectionPhase.ON) "Наблюдаемые движком сейчас" else "VPN выключен; последние наблюдения") }
        if (flows.isEmpty()) item {
            EmptyState(Icons.Outlined.Wifi, "Нет наблюдаемых соединений", if (state.status.phase == ConnectionPhase.ON) "Открой приложение с включённым маршрутом. Его соединения появятся здесь."
                else "Включи VPN и открой приложение, чтобы увидеть реальные соединения.")
        }
        items(flows, key = { it.id }, contentType = { "flow" }) { flow ->
            Panel {
                Column(Modifier.fillMaxWidth().clickable { selected = if (selected == flow.id) null else flow.id }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(flow.appName.ifBlank { "Приложение не определено" }, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${flow.host}:${flow.port}", style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Icon(Icons.Outlined.ChevronRight, if (selected == flow.id) "Свернуть соединение" else "Подробности соединения")
                    }
                    Text("${flow.network.uppercase()} · ${flow.viaLabel}", style = MaterialTheme.typography.labelMedium)
                    Text("↓ ${formatBytes(flow.downloadedBytes)}  ·  ↑ ${formatBytes(flow.uploadedBytes)}", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                }
                if (selected == flow.id) SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (flow.packageName.isNotBlank()) KeyValue("Пакет Android", flow.packageName, mono = true)
                        if (flow.rule.isNotBlank()) KeyValue("Совпавшее правило", flow.rule)
                        KeyValue("Идентификатор соединения", flow.id, mono = true)
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
                OutlinedButton(onClick = { operation.run({ actions.readLogs() }) }, enabled = !operation.busy, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Обновить") }
                OutlinedButton(onClick = { preview = true }, modifier = Modifier.weight(1f).heightIn(min = 50.dp)) { Icon(Icons.Outlined.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Отчёт") }
            }
            OperationFeedback(operation)
        }
        item { SearchField(query, { query = it }, "Найти в журнале") }
        item { Text("Последние ${lines.size} строк. Отчёт подготавливается без приватных ключей и ссылок подписок.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
        if (lines.isEmpty()) item { EmptyState(Icons.Outlined.Description, "Журнал пуст", "События работы движка появятся после запуска. Для свежих данных нажми «Обновить».") }
        items(lines, key = { it.id }, contentType = { "log" }) { line ->
            SelectionContainer {
                Text(line.text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                    color = if (line.text.contains("error", true) || line.text.contains("ошибка", true)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
            }
        }
    }
    if (preview) AlertDialog(onDismissRequest = { preview = false }, title = { Text("Диагностика доступна без VPN") },
        text = {
            Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("В отчёте: версии, состояния VPN, счётчики, категории ошибок и проверка передачи. Конфиги, адреса серверов, ссылки подписок и строки журнала не включаются.")
                SelectionContainer { Text(state.savedDiagnostics ?: "Сохранённых сессий пока нет", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                TextButton(onClick = { operation.run({ actions.clearDiagnosticHistory() }) }, enabled = !operation.busy) { Text("Удалить сохранённую историю") }
            }
        }, confirmButton = { TextButton(onClick = actions::shareDiagnostics) { Text("Поделиться отчётом") } },
        dismissButton = { TextButton(onClick = { preview = false }) { Text("Закрыть") } })
}

@Composable
internal fun SettingsScreen(state: MobileState, actions: MobileActions) {
    val operation = rememberUiOperation()
    Column(Modifier.fillMaxSize()) {
    if (operation.error != null) Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) { OperationFeedback(operation) }
    else OperationFeedback(operation)
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Panel {
                SectionHeading("Маршрутизация")
                SettingsToggle("Локальная сеть напрямую", "Доступ к устройствам и сервисам в локальной сети", state.settings.lanDirect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(lanDirect = it)) })
                }
                HorizontalDivider()
                SettingsToggle("Домены .ru, .su и .рф напрямую", "Исключение для доменов; не определяет страну сервера по IP", state.settings.ruDirect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(ruDirect = it)) })
                }
            }
        }
        item {
            Panel {
                SectionHeading("Общий DNS Android")
                Text("Android иногда не передаёт приложение DNS-запроса, особенно в версиях 10 и 11; для таких запросов используется общий путь.",
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                val choices = listOf(PathChoice(SYSTEM_DNS_AUTOMATIC, "Автоматически по маршрутам", "Общий путь определяется по включённым маршрутам")) +
                    rememberPathChoices(state).map { if (it.id == AUTO_PATH) it.copy(name = "Авто: свои туннели") else it }
                PathField("Путь общего DNS", state.settings.systemDnsViaId ?: SYSTEM_DNS_AUTOMATIC,
                    choices, enabled = !operation.busy) { chosen ->
                    operation.run({ actions.setSystemDnsPath(chosen.takeUnless { it == SYSTEM_DNS_AUTOMATIC }) })
                }
                val dnsHint = state.settings.systemDnsHint
                if (!dnsHint.isNullOrBlank()) InlineMessage(dnsHint, error = state.settings.systemDnsBlocked)
                else if (state.settings.systemDnsBlocked) {
                    InlineMessage("Общий DNS заблокирован: у приложений разные пути. Выбери туннель или группу для общих DNS-запросов.", error = true)
                }
            }
        }
        item {
            Panel {
                SectionHeading("Служебные загрузки", "Обновление подписок и публичного каталога")
                val choices = listOf(PathChoice(DIRECT_PATH, "Напрямую", "Через физическую сеть")) +
                    state.profiles.filter { !it.revoked && !it.subscriptionMissing && it.source == ProfileSource.PERSONAL }
                        .map { PathChoice(it.id, it.name, it.protocol) }
                PathField("Разрешённый путь", state.settings.serviceViaId, choices, enabled = !operation.busy) { id ->
                    operation.run({ actions.setServicePath(id) })
                }
                Text("Для выбранного туннеля нужен включённый VPN. При его отказе прямого резерва нет. Последний успешно загруженный каталог остаётся доступен без сети.",
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        item {
            Panel {
                SectionHeading("Запуск и уведомления")
                SettingsToggle("Подключаться при запуске", "Включать сохранённые маршруты при открытии Waarp", state.settings.autoConnect, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(autoConnect = it)) })
                }
                HorizontalDivider()
                SettingsToggle("Уведомления об ошибках", "Дополнительные сообщения об ошибках и смене состояния", state.settings.notifications, !operation.busy) {
                    operation.run({ actions.saveSettings(SettingsPatch(notifications = it)) })
                }
                Text("Служебное уведомление активного VPN требуется Android.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
        item {
            Panel {
                SectionHeading("Защита Android")
                KeyValue("Постоянный VPN", booleanStatus(state.settings.systemAlwaysOn))
                KeyValue("Блокировать соединения без VPN", booleanStatus(state.settings.systemLockdown))
                Text("Эти параметры задаются в системных настройках VPN. Их состояние может быть неизвестно, пока служба не запущена.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                OutlinedButton(onClick = actions::openSystemVpnSettings, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text("Открыть настройки VPN Android"); Spacer(Modifier.width(8.dp)); Icon(Icons.Outlined.ChevronRight, null) }
            }
        }
        item {
            Panel {
                SectionHeading("Обслуживание")
                Text("Восстановление завершает оставшееся состояние службы после сбоя. Сохранённые профили и маршруты остаются на месте.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                OutlinedButton(onClick = { operation.run({ actions.recover() }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                    Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text("Восстановить состояние VPN")
                }
                OutlinedButton(onClick = { operation.run({ actions.refresh() }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text("Обновить данные приложения") }
                OutlinedButton(onClick = actions::shareDiagnostics, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.Share, null); Spacer(Modifier.width(8.dp)); Text("Поделиться диагностикой") }
            }
        }
        item {
            Panel {
                SectionHeading("Waarp для Android")
                KeyValue("Приложение", state.appVersion.ifBlank { "Версия не определена" })
                KeyValue("Движок", state.engineVersion.ifBlank { "Версия не определена" })
                Text("Маршруты приложений используют пакеты и UID Android. Конфигурация и ключи хранятся в закрытом хранилище приложения.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
        }
    }
    }
}

@Composable
private fun SettingsToggle(title: String, detail: String, value: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontWeight = FontWeight.Medium)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        Switch(value, onChange, enabled = enabled, modifier = Modifier.semantics { contentDescription = title })
    }
}

private fun booleanStatus(value: Boolean?) = when (value) { true -> "Включено"; false -> "Выключено"; null -> "Пока неизвестно" }

// Screen-only option. It must be converted to null before calling the backend;
// AUTO_PATH selects the actual automatic tunnel group and has different semantics.
private const val SYSTEM_DNS_AUTOMATIC = "system-dns:automatic"
