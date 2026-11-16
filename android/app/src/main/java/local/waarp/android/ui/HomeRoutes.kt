@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Route
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun HomeScreen(state: MobileState, actions: MobileActions, onRoutes: () -> Unit, onAddTunnel: () -> Unit, onWholeDevice: () -> Unit) {
    val operation = rememberUiOperation()
    val status = state.status
    val isWhole = state.settings.defaultViaId != DIRECT_PATH
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(status.phase, status.connectedSinceMillis) {
        while (status.phase == ConnectionPhase.ON) { now = System.currentTimeMillis(); delay(1000) }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Panel {
                val active = status.phase == ConnectionPhase.ON
                val restoring = status.recovering && status.requestedOpen
                val pending = status.phase == ConnectionPhase.STARTING || restoring
                val title = when {
                    restoring -> "Восстанавливаем соединение"
                    status.phase == ConnectionPhase.ON -> "VPN запущен"
                    status.phase == ConnectionPhase.STARTING -> "Подключаемся"
                    status.phase == ConnectionPhase.STOPPING -> "Отключаемся"
                    status.phase == ConnectionPhase.ERROR -> "Не удалось запустить"
                    status.requestedOpen -> "Ожидает маршрута"
                    else -> "VPN выключен"
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(76.dp).background(
                        if (active) WaarpGreen.copy(alpha = .12f) else WaarpOrange.copy(alpha = .12f), CircleShape), contentAlignment = Alignment.Center) {
                        if (pending || status.phase == ConnectionPhase.STOPPING) CircularProgressIndicator(Modifier.size(48.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Outlined.PowerSettingsNew, null, Modifier.size(34.dp), tint = if (active) WaarpGreen else WaarpOrange)
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
                            color = if (active) WaarpGreen else MaterialTheme.colorScheme.onSurface)
                        Text(when {
                            active -> status.selectedPathLabel ?: pathName(state, state.settings.defaultViaId)
                            pending -> "Ожидаем подтверждения движка"
                            status.phase == ConnectionPhase.ERROR -> "Причина и восстановление ниже"
                            else -> "Маршруты применятся при включении"
                        }, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                        if (active && status.connectedSinceMillis != null) Text(formatDuration(now - status.connectedSinceMillis), style = MaterialTheme.typography.labelMedium)
                    }
                }
                val shouldStop = active || pending || status.requestedOpen
                Button(onClick = { if (shouldStop) actions.disconnect() else actions.connect() },
                    enabled = status.phase != ConnectionPhase.STOPPING,
                    modifier = Modifier.fillMaxWidth().height(56.dp)) {
                    Text(if (pending) "Отменить подключение" else if (shouldStop) "Выключить" else "Включить", style = MaterialTheme.typography.titleMedium)
                }
                (status.error ?: state.error)?.let { InlineMessage(it, error = true) }
                if (status.recoveryFailed || status.phase == ConnectionPhase.ERROR) {
                    OutlinedButton(onClick = { operation.run({ actions.recover() }) }, enabled = !operation.busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Восстановить состояние VPN")
                    }
                }
                if (active) {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TrafficMetric("Приём", state.status.downloadBytesPerSecond, state.status.downloadedBytes, true, Modifier.weight(1f))
                        TrafficMetric("Отправка", state.status.uploadBytesPerSecond, state.status.uploadedBytes, false, Modifier.weight(1f))
                    }
                }
                status.autoPoolTotal?.let { total -> Text("Авто: ${status.autoPoolLive ?: 0} из $total туннелей в рабочем пуле", style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
            }
        }
        item {
            Panel {
                SectionHeading("Что идёт через Waarp")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !isWhole, onClick = { operation.run({ actions.setDefaultRoute(DIRECT_PATH) }) }, enabled = !operation.busy,
                        label = { Text("Только выбранное") }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                    FilterChip(selected = isWhole, onClick = onWholeDevice, enabled = !operation.busy,
                        label = { Text("Всё устройство") }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                }
                if (isWhole) {
                    TextButton(onClick = onWholeDevice, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(pathName(state, state.settings.defaultViaId), Modifier.weight(1f)); Icon(Icons.Outlined.ChevronRight, null)
                    }
                }
                Text(if (isWhole) "Общий путь действует на устройство. Отдельные маршруты задают исключения."
                    else "Через VPN идут включённые приложения, сервисы и адреса из списка маршрутов.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                OperationFeedback(operation)
            }
        }
        items(state.notices, key = { "notice-${it.id}" }) { notice ->
            InlineMessage(listOf(notice.title, notice.detail).filter { it.isNotBlank() }.joinToString("\n"), error = notice.level == NoticeLevel.BLOCK)
        }
        if (state.profiles.isEmpty()) item {
            EmptyState(Icons.Outlined.Shield, "Начни с туннеля", "Импортируй конфигурацию, ссылку или QR-код своего сервера.") {
                Button(onClick = onAddTunnel, Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("Добавить туннель") }
            }
        }
        item {
            Panel {
                SectionHeading("Маршруты", "${state.routes.count { it.enabled }} включено · ${state.routes.size} всего", trailing = {
                    TextButton(onClick = onRoutes, Modifier.heightIn(min = 48.dp)) { Text("Все"); Icon(Icons.Outlined.ChevronRight, null) }
                })
                if (state.routes.isEmpty()) Text("Добавь приложение или адрес и выбери, куда направить его соединения.", color = WaarpMuted)
                else state.routes.take(4).forEach { route ->
                    Row(Modifier.fillMaxWidth().clickable(onClick = onRoutes).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        AppIcon(state.apps.find { it.packageName == route.packageName }, route.name)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) { Text(route.name, maxLines = 1, overflow = TextOverflow.Ellipsis); RouteStateLabel(route, state.status.phase == ConnectionPhase.ON) }
                        Text(pathName(state, route.effectiveViaId ?: route.viaId), style = MaterialTheme.typography.labelSmall,
                            color = WaarpMuted, maxLines = 1, modifier = Modifier.widthIn(max = 140.dp), overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        item { Text("Блокировка соединений вне VPN управляется Android: Настройки → Постоянный VPN. Статус запуска сам по себе не подтверждает доступность сайтов.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
    }
}

@Composable
private fun TrafficMetric(label: String, speed: Long, total: Long, down: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(if (down) Icons.Outlined.ArrowDownward else Icons.Outlined.ArrowUpward, null, Modifier.size(14.dp), tint = WaarpMuted)
            Text(label, color = WaarpMuted, style = MaterialTheme.typography.labelSmall)
        }
        Text("${formatBytes(speed)}/с", fontWeight = FontWeight.SemiBold)
        Text("Всего ${formatBytes(total)}", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
    }
}

@Composable
internal fun WholeDeviceSheet(state: MobileState, actions: MobileActions, onDismiss: () -> Unit) {
    val operation = rememberUiOperation()
    var path by rememberSaveable { mutableStateOf(state.settings.defaultViaId.takeIf { it != DIRECT_PATH } ?: state.settings.lastWholeDeviceViaId) }
    val choices = pathChoices(state, allowDirect = false)
    FormSheet("Путь для устройства", operation.busy, onDismiss) {
        Text("Приложения и адреса с собственными маршрутами сохранят выбранные пути.", color = WaarpMuted)
        PathField("Общий путь", path, choices, enabled = !operation.busy, selected = { path = it })
        OperationFeedback(operation)
        ActionButton("Применить", operation.busy, enabled = choices.any { it.id == path && it.enabled },
            onClick = { path?.let { operation.run({ actions.setDefaultRoute(it) }, onDismiss) } }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun RoutesScreen(state: MobileState, actions: MobileActions, onEdit: (String) -> Unit, onAdd: () -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf("all") }
    val filtered = remember(state.routes, search, kind) {
        state.routes.filter { route -> (kind == "all" || route.kind.name == kind) &&
            listOf(route.name, route.packageName.orEmpty(), route.selector.orEmpty()).any { it.contains(search, ignoreCase = true) } }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 104.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Приложение, сервис или адрес — и путь для его соединений.", color = WaarpMuted, style = MaterialTheme.typography.bodyMedium) }
        item { SearchField(search, { search = it }, "Найти маршрут") }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("all" to "Все", "APP" to "Приложения", "SERVICE" to "Сервисы", "CUSTOM" to "Адреса").forEach { (key, label) ->
                    FilterChip(selected = kind == key, onClick = { kind = key }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
        }
        if (filtered.isEmpty()) item {
            EmptyState(Icons.Outlined.Route, if (state.routes.isEmpty()) "Маршрутов пока нет" else "Ничего не найдено",
                if (state.routes.isEmpty()) "Выбери Android-приложение, готовый сервис или домен/IP." else "Попробуй другой запрос или фильтр.") {
                if (state.routes.isEmpty()) Button(onClick = onAdd, Modifier.heightIn(min = 48.dp)) { Text("Добавить маршрут") }
            }
        }
        items(filtered, key = { it.id }) { route -> RouteCard(route, state, actions, { onEdit(route.id) }) }
        item { InlineMessage("Порядок важен: маршрут приложения применяется ко всем его соединениям; сервисы и адреса уточняют остальной трафик. Резервный путь выбирается только по твоей настройке.") }
    }
}

@Composable
private fun RouteCard(route: RouteUi, state: MobileState, actions: MobileActions, onEdit: () -> Unit) {
    val operation = rememberUiOperation()
    Panel {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            AppIcon(state.apps.find { it.packageName == route.packageName }, route.name)
            Column(Modifier.weight(1f).clickable(onClick = onEdit).padding(vertical = 8.dp)) {
                Text(route.name, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(when (route.kind) { RouteKind.APP -> route.packageName.orEmpty(); RouteKind.SERVICE -> "Сервис"; RouteKind.CUSTOM -> route.selector.orEmpty() },
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Switch(route.enabled, { enabled -> operation.run({ actions.setRouteEnabled(route.id, enabled) }) }, enabled = !operation.busy,
                modifier = Modifier.semantics { contentDescription = "Маршрут ${route.name}" })
        }
        Row(Modifier.fillMaxWidth().clickable(onClick = onEdit).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(pathName(state, route.viaId), style = MaterialTheme.typography.bodyMedium)
                route.fallbackViaId?.let { Text("Резерв: ${pathName(state, it)}", style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
                RouteStateLabel(route, state.status.phase == ConnectionPhase.ON)
            }
            Icon(Icons.Outlined.ChevronRight, "Изменить маршрут")
        }
        route.reason?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
        if (route.downloadedBytes > 0 || route.uploadedBytes > 0) Text("↓ ${formatBytes(route.downloadedBytes)}  ·  ↑ ${formatBytes(route.uploadedBytes)}", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
        OperationFeedback(operation)
    }
}

@Composable
internal fun RouteStateLabel(route: RouteUi, running: Boolean = false) {
    val text = when (route.state) {
        RouteState.OK -> "Основной путь"
        RouteState.FALLBACK -> "Работает резервный путь"
        RouteState.RETRYING -> "Повторная проверка"
        RouteState.BLOCKED -> "Соединения заблокированы"
        RouteState.DIRECT -> "Напрямую"
        RouteState.IDLE -> if (running) "Путь ещё не проверен" else "Применится при включении"
        RouteState.OFF -> "Маршрут выключен"
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = when (route.state) {
        RouteState.OK -> WaarpGreen
        RouteState.BLOCKED -> MaterialTheme.colorScheme.error
        RouteState.FALLBACK, RouteState.RETRYING -> WaarpWarning
        else -> WaarpMuted
    })
}

@Composable
internal fun RouteEditorSheet(state: MobileState, actions: MobileActions, id: String?, suggestedTarget: String?, suggestedVia: String?, onDismiss: () -> Unit) {
    val existing = state.routes.find { it.id == id }
    if (id != null && existing == null) { MissingItemSheet(onDismiss); return }
    val operation = rememberUiOperation()
    var kind by rememberSaveable { mutableStateOf(existing?.kind?.name ?: if (suggestedTarget != null) "CUSTOM" else "APP") }
    var name by rememberSaveable { mutableStateOf(existing?.name.orEmpty()) }
    var packageName by rememberSaveable { mutableStateOf(existing?.packageName) }
    var presetId by rememberSaveable { mutableStateOf(existing?.presetId) }
    var selector by rememberSaveable { mutableStateOf(existing?.selector ?: suggestedTarget.orEmpty()) }
    var via by rememberSaveable { mutableStateOf(existing?.viaId ?: suggestedVia ?: AUTO_PATH) }
    var fallback by rememberSaveable { mutableStateOf(existing?.fallbackViaId) }
    var enabled by rememberSaveable { mutableStateOf(existing?.enabled ?: true) }
    var query by rememberSaveable { mutableStateOf("") }
    var showSystem by rememberSaveable { mutableStateOf(false) }
    var deleting by rememberSaveable { mutableStateOf(false) }
    val choices = pathChoices(state)
    val fallbackChoices = listOf(PathChoice("", "Без резерва", "Если путь недоступен — блокировать соединения")) + choices.filter { it.id != via && it.id != DIRECT_PATH }
    val selectedKind = RouteKind.valueOf(kind)
    val eligibleApps = remember(state.apps, query, showSystem, packageName) { state.apps.filter { (!it.system || showSystem || it.packageName == packageName) &&
        (it.name.contains(query, true) || it.packageName.contains(query, true)) }.sortedBy { it.name.lowercase() } }
    FormSheet(if (existing == null) "Новый маршрут" else "Изменить маршрут", operation.busy, onDismiss) {
        if (existing == null) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(RouteKind.APP to "Приложение", RouteKind.SERVICE to "Сервис", RouteKind.CUSTOM to "Адрес").forEach { (type, label) ->
                FilterChip(selected = type == selectedKind, onClick = { kind = type.name; query = "" }, label = { Text(label) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        when (selectedKind) {
            RouteKind.APP -> {
                Text("Выбери установленное приложение", style = MaterialTheme.typography.titleSmall)
                packageName?.let { KeyValue("Выбрано", state.apps.find { app -> app.packageName == it }?.name ?: it) }
                SearchField(query, { query = it }, "Название или пакет")
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(showSystem, { showSystem = !showSystem }, label = { Text("Системные") }, modifier = Modifier.heightIn(min = 48.dp))
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { operation.run({ actions.refreshApps() }) }, enabled = !operation.busy) { Text("Обновить") }
                }
                if (eligibleApps.isEmpty()) Text("Приложения не найдены. Обнови список или измени поиск.", color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
                else LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
                    items(eligibleApps, key = { it.packageName }) { app ->
                        Row(Modifier.fillMaxWidth().selectable(selected = packageName == app.packageName, enabled = !operation.busy, role = Role.RadioButton) {
                            packageName = app.packageName; if (name.isBlank() || existing == null) name = app.name
                        }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            AppIcon(app, app.name); Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) { Text(app.name, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(app.packageName, style = MaterialTheme.typography.labelSmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            if (packageName == app.packageName) Icon(Icons.Outlined.Check, "Выбрано", tint = WaarpOrange)
                        }
                    }
                }
                Text("Android применяет правила к UID. Приложения с общим UID получают один путь.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
            RouteKind.SERVICE -> {
                val serviceChoices = state.presets.map { PathChoice(it.id, it.name, it.description) }
                PathField("Сервис", presetId, serviceChoices, !operation.busy) { selected ->
                    presetId = selected; if (name.isBlank() || existing == null) name = state.presets.find { it.id == selected }?.name.orEmpty()
                }
                state.presets.find { it.id == presetId }?.let { Text(it.description, color = WaarpMuted, style = MaterialTheme.typography.bodySmall) }
            }
            RouteKind.CUSTOM -> {
                OutlinedTextField(selector, { selector = it }, Modifier.fillMaxWidth(), enabled = !operation.busy, label = { Text("Домены, IP или подсети CIDR") },
                    placeholder = { Text("example.com\n10.10.0.0/16") }, minLines = 2, maxLines = 5)
                Text("Домен охватывает его поддомены. Несколько адресов — по одному в строке.", color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = !operation.busy, label = { Text("Название") }, singleLine = true)
        PathField("Основной путь", via, choices, !operation.busy) { via = it; if (fallback == it || it == DIRECT_PATH) fallback = null }
        if (via != DIRECT_PATH) {
            PathField("Если основной недоступен", fallback ?: "", fallbackChoices, !operation.busy) { fallback = it.takeIf(String::isNotBlank) }
            Text("Резервный туннель или группа; без выхода напрямую.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Маршрут включён", Modifier.weight(1f)); Switch(enabled, { enabled = it }, enabled = !operation.busy)
        }
        OperationFeedback(operation)
        val hasTarget = when (selectedKind) { RouteKind.APP -> packageName != null; RouteKind.SERVICE -> presetId != null; RouteKind.CUSTOM -> selector.isNotBlank() }
        ActionButton("Сохранить маршрут", operation.busy, enabled = hasTarget && (name.isNotBlank() || selectedKind == RouteKind.CUSTOM) && choices.any { it.id == via && it.enabled },
            onClick = { operation.run({ actions.saveRoute(RouteDraft(id, selectedKind, name.trim().ifBlank { selector.trim() }, via, fallback.takeIf { via != DIRECT_PATH && it != DIRECT_PATH }, enabled,
                packageName = packageName.takeIf { selectedKind == RouteKind.APP }, presetId = presetId.takeIf { selectedKind == RouteKind.SERVICE },
                selector = selector.trim().takeIf { selectedKind == RouteKind.CUSTOM })) }, onDismiss) }, modifier = Modifier.fillMaxWidth())
        if (id != null) {
            if (deleting) {
                InlineMessage("После удаления соединения будут следовать общему пути устройства.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { deleting = false }, enabled = !operation.busy, modifier = Modifier.weight(1f).height(48.dp)) { Text("Отмена") }
                    Button(onClick = { operation.run({ actions.deleteRoute(id) }, onDismiss) }, enabled = !operation.busy, modifier = Modifier.weight(1f).height(48.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)) { Text("Удалить") }
                }
            } else TextButton(onClick = { deleting = true }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text("Удалить маршрут")
            }
        }
    }
}

@Composable
internal fun FormSheet(title: String, busy: Boolean, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val busyNow by rememberUpdatedState(busy)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { next -> !busyNow || next != SheetValue.Hidden })
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = sheetState,
        sheetMaxWidth = 680.dp) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}
