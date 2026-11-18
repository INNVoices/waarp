@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import local.waarp.android.i18n.localized

import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import local.waarp.android.data.ConnectionUses
import java.util.UUID
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle

@Composable
internal fun HomeScreen(state: MobileState, actions: MobileActions, onRoutes: () -> Unit, onAddTunnel: () -> Unit, onWholeDevice: () -> Unit) {
    val operation = rememberUiOperation()
    val status = state.status
    val isWhole = state.settings.defaultViaId != DIRECT_PATH
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Panel {
                val active = status.phase == ConnectionPhase.ON
                val restoring = status.recovering && status.requestedOpen
                // A live route transaction is not a connection start. Actual STARTING/OFF remains visible.
                val pending = status.phase == ConnectionPhase.STARTING || (restoring && !active)
                val title = when {
                    status.phase == ConnectionPhase.ON -> localized("HomeRoutes.37b0b9751113", "VPN запущен")
                    restoring -> localized("HomeRoutes.b840438fd67f", "Восстанавливаем соединение")
                    status.phase == ConnectionPhase.STARTING -> localized("HomeRoutes.2a9aa13d7266", "Подключаемся")
                    status.phase == ConnectionPhase.STOPPING -> localized("HomeRoutes.0ee1d0bb9d29", "Отключаемся")
                    status.phase == ConnectionPhase.ERROR -> localized("HomeRoutes.d4d82249fce1", "Не удалось запустить")
                    status.requestedOpen -> localized("HomeRoutes.1163d5b4f011", "Ожидает маршрута")
                    else -> localized("HomeRoutes.f219c4632081", "VPN выключен")
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
                            pending -> localized("HomeRoutes.c04f0c697345", "Ожидаем подтверждения движка")
                            status.phase == ConnectionPhase.ERROR -> localized("HomeRoutes.92c0666b226c", "Причина и восстановление ниже")
                            else -> localized("HomeRoutes.f0f301ddb0bd", "Маршруты применятся при включении")
                        }, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                        if (active && status.connectedSinceMillis != null) ConnectionUptime(status.connectedSinceMillis)
                    }
                }
                val shouldStop = active || pending || status.requestedOpen
                Button(onClick = { if (shouldStop) actions.disconnect() else actions.connect() },
                    enabled = status.phase != ConnectionPhase.STOPPING,
                    modifier = Modifier.fillMaxWidth().height(56.dp)) {
                    Text(if (pending) localized("HomeRoutes.8285f450a3d1", "Отменить подключение") else if (shouldStop) localized("HomeRoutes.d44e48c17edb", "Выключить") else localized("HomeRoutes.0b909159c8d6", "Включить"), style = MaterialTheme.typography.titleMedium)
                }
                (status.error ?: state.error)?.let { InlineMessage(it, error = true) }
                if (status.recoveryFailed || status.phase == ConnectionPhase.ERROR) {
                    OutlinedButton(onClick = { operation.run({ actions.recover() }) }, enabled = !operation.busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("HomeRoutes.97c80858024c", "Восстановить состояние VPN"))
                    }
                }
                if (active) {
                    HorizontalDivider()
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TrafficMetric(localized("HomeRoutes.c395d722b001", "Приём"), state.status.downloadBytesPerSecond, state.status.downloadedBytes, true, Modifier.weight(1f))
                        TrafficMetric(localized("HomeRoutes.67dd105051e5", "Отправка"), state.status.uploadBytesPerSecond, state.status.uploadedBytes, false, Modifier.weight(1f))
                    }
                }
                status.autoPoolTotal?.let { total -> Text(localized("HomeRoutes.697c13d8ba94", "Авто: загружено {arg1} из {arg2} туннелей", status.autoPoolLive ?: 0, total), style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
            }
        }
        item {
            Panel {
                SectionHeading(localized("HomeRoutes.3005f1052360", "Что идёт через Waarp"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !isWhole, onClick = { operation.run({ actions.setDefaultRoute(DIRECT_PATH) }) }, enabled = !operation.busy,
                        label = { Text(localized("HomeRoutes.17db804be537", "Только выбранное")) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                    FilterChip(selected = isWhole, onClick = onWholeDevice, enabled = !operation.busy,
                        label = { Text(localized("HomeRoutes.b1eeb5762320", "Всё устройство")) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                }
                if (isWhole) {
                    TextButton(onClick = onWholeDevice, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(pathName(state, state.settings.defaultViaId), Modifier.weight(1f)); Icon(Icons.Outlined.ChevronRight, null)
                    }
                }
                Text(if (isWhole) localized("HomeRoutes.92bf4a2b0f30", "Общий путь действует на устройство. Отдельные маршруты задают исключения.")
                    else localized("HomeRoutes.9273034f5880", "Через VPN идут включённые приложения, сервисы и адреса из списка маршрутов."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                if (!isWhole && state.routes.any { it.kind == RouteKind.APP && it.enabled && it.viaId != DIRECT_PATH }) {
                    Text(localized("HomeRoutes.e44b0f1dc36f", "Если Android не определит приложение, соединение без отдельного правила будет заблокировано."),
                        style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                }
                OperationFeedback(operation)
            }
        }
        items(state.notices, key = { "notice-${it.id}" }) { notice ->
            InlineMessage(listOf(notice.title, notice.detail).filter { it.isNotBlank() }.joinToString("\n"), error = notice.level == NoticeLevel.BLOCK)
        }
        if (state.profiles.isEmpty()) item {
            EmptyState(Icons.Outlined.Shield, localized("HomeRoutes.f1d861f9bdde", "Начни с туннеля"), localized("HomeRoutes.19449e2288f0", "Импортируй конфигурацию, ссылку или QR-код своего сервера.")) {
                Button(onClick = onAddTunnel, Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text(localized("HomeRoutes.b067be6524cb", "Добавить туннель")) }
            }
        }
        item {
            Panel {
                SectionHeading(localized("HomeRoutes.b949746505b5", "Маршруты"), localized("HomeRoutes.a73bfababe68", "{arg1} включено · {arg2} всего", state.routes.count { it.enabled }, state.routes.size), trailing = {
                    TextButton(onClick = onRoutes, Modifier.heightIn(min = 48.dp)) { Text(localized("HomeRoutes.ad2e38af7700", "Все")); Icon(Icons.Outlined.ChevronRight, null) }
                })
                if (state.routes.isEmpty()) Text(localized("HomeRoutes.e7a58a7713d0", "Добавь приложение или адрес и выбери, куда направить его соединения."), color = WaarpMuted)
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
        item { Text(localized("HomeRoutes.76604ec0576c", "Блокировка соединений вне VPN управляется Android: Настройки → Постоянный VPN. Статус запуска сам по себе не подтверждает доступность сайтов."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
    }
}

@Composable
private fun ConnectionUptime(startedAt: Long) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lifecycle, startedAt) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { now = System.currentTimeMillis(); delay(1000) }
        }
    }
    Text(formatDuration(now - startedAt), style = MaterialTheme.typography.labelMedium)
}

@Composable
private fun TrafficMetric(label: String, speed: Long, total: Long, down: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(if (down) Icons.Outlined.ArrowDownward else Icons.Outlined.ArrowUpward, null, Modifier.size(14.dp), tint = WaarpMuted)
            Text(label, color = WaarpMuted, style = MaterialTheme.typography.labelSmall)
        }
        Text(localized("HomeRoutes.cf3c85254d35", "{arg1}/с", formatBytes(speed)), fontWeight = FontWeight.SemiBold)
        Text(localized("HomeRoutes.d31b4a03354a", "Всего {arg1}", formatBytes(total)), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
    }
}

@Composable
internal fun WholeDeviceSheet(state: MobileState, actions: MobileActions, onDismiss: () -> Unit) {
    val operation = rememberModalOperation(onDismiss)
    var path by rememberSaveable { mutableStateOf(state.settings.defaultViaId.takeIf { it != DIRECT_PATH } ?: state.settings.lastWholeDeviceViaId) }
    val choices = rememberPathChoices(state, allowDirect = false)
    FormSheet(localized("HomeRoutes.2214bd6ce5fd", "Путь для устройства"), operation.busy, onDismiss) {
        Text(localized("HomeRoutes.d825e48440ae", "Приложения и адреса с собственными маршрутами сохранят выбранные пути."), color = WaarpMuted)
        PathField(localized("HomeRoutes.19e7ede3e93c", "Общий путь"), path, choices, enabled = !operation.busy, selected = { path = it })
        OperationFeedback(operation)
        ActionButton(localized("HomeRoutes.e674dd204b23", "Применить"), operation.busy, enabled = choices.any { it.id == path && it.enabled },
            onClick = { path?.let { operation.submit({ actions.setDefaultRoute(it) }) } }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun RoutesScreen(state: MobileState, actions: MobileActions, onEdit: (String) -> Unit, onAdd: () -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf("all") }
    val names = rememberPathNames(state)
    val apps = remember(state.apps) { state.apps.associateBy { it.packageName } }
    val filtered = remember(state.routes, search, kind) {
        state.routes.filter { route -> (kind == "all" || route.kind.name == kind) &&
            listOf(route.name, route.packageName.orEmpty(), route.selector.orEmpty()).any { it.contains(search, ignoreCase = true) } }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 104.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(localized("HomeRoutes.b7c50fc117b4", "Приложение, сервис или адрес — и путь для его соединений."), color = WaarpMuted, style = MaterialTheme.typography.bodyMedium) }
        item { SearchField(search, { search = it }, localized("HomeRoutes.97264a53c839", "Найти маршрут")) }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("all" to localized("HomeRoutes.02cdb3e4910b", "Все"), "APP" to localized("HomeRoutes.353e3f81b882", "Приложения"), "SERVICE" to localized("HomeRoutes.4f4df18c9b39", "Сервисы"), "CUSTOM" to localized("HomeRoutes.3a7b6e3c2ee5", "Адреса")).forEach { (key, label) ->
                    FilterChip(selected = kind == key, onClick = { kind = key }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
                }
            }
        }
        if (filtered.isEmpty()) item {
            EmptyState(Icons.Outlined.Route, if (state.routes.isEmpty()) localized("HomeRoutes.f749884a0770", "Маршрутов пока нет") else localized("HomeRoutes.876c2f1e3a70", "Ничего не найдено"),
                if (state.routes.isEmpty()) localized("HomeRoutes.6a697b786e1e", "Выбери Android-приложение, готовый сервис или домен/IP.") else localized("HomeRoutes.a45e45f68328", "Попробуй другой запрос или фильтр.")) {
                if (state.routes.isEmpty()) Button(onClick = onAdd, Modifier.heightIn(min = 48.dp)) { Text(localized("HomeRoutes.979f64257500", "Добавить маршрут")) }
            }
        }
        items(filtered, key = { it.id }, contentType = { "route" }) { route ->
            RouteCard(route, apps[route.packageName], names[route.viaId] ?: localized("HomeRoutes.ee9c783cdc7b", "Недоступный путь"),
                route.fallbackViaId?.let { names[it] ?: localized("HomeRoutes.ee9c783cdc7b", "Недоступный путь") }, state.status.phase == ConnectionPhase.ON, actions, { onEdit(route.id) })
        }
        item { InlineMessage(localized("HomeRoutes.29b479d7887a", "Порядок важен: маршрут приложения применяется ко всем его соединениям; сервисы и адреса уточняют остальной трафик. Резервный путь выбирается только по твоей настройке.")) }
    }
}

@Composable
private fun RouteCard(route: RouteUi, app: AppUi?, primaryName: String, fallbackName: String?, running: Boolean, actions: MobileActions, onEdit: () -> Unit) {
    val operation = rememberUiOperation()
    Panel {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            AppIcon(app, route.name)
            Column(Modifier.weight(1f).clickable(onClick = onEdit).padding(vertical = 8.dp)) {
                Text(route.name, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(when (route.kind) { RouteKind.APP -> route.packageName.orEmpty(); RouteKind.SERVICE -> localized("HomeRoutes.fb8c62d1fea2", "Сервис"); RouteKind.CUSTOM -> route.selector.orEmpty() },
                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Checkbox(route.enabled, { enabled -> operation.run({ actions.setRouteEnabled(route.id, enabled) }) }, enabled = !operation.busy,
                modifier = Modifier.semantics { contentDescription = localized("HomeRoutes.099a049432b5", "Маршрут {arg1}", route.name) })
        }
        Row(Modifier.fillMaxWidth().clickable(onClick = onEdit).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(primaryName, style = MaterialTheme.typography.bodyMedium)
                fallbackName?.let { Text(localized("HomeRoutes.b6953257a4a3", "Резерв: {arg1}", it), style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
                RouteStateLabel(route, running)
            }
            Icon(Icons.Outlined.ChevronRight, localized("HomeRoutes.14a1e57a8156", "Изменить маршрут"))
        }
        route.reason?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
        if (route.downloadedBytes > 0 || route.uploadedBytes > 0) Text(localized("HomeRoutes.ceb9db075636", "↓ {arg1}  ·  ↑ {arg2}", formatBytes(route.downloadedBytes), formatBytes(route.uploadedBytes)), style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
        OperationFeedback(operation)
    }
}

@Composable
internal fun RouteStateLabel(route: RouteUi, running: Boolean = false) {
    val text = when (route.state) {
        RouteState.OK -> localized("HomeRoutes.ca3da9007ec5", "Основной путь")
        RouteState.FALLBACK -> localized("HomeRoutes.ad103a8c1ad1", "Работает резервный путь")
        RouteState.RETRYING -> localized("HomeRoutes.773198d13cb5", "Повторная проверка")
        RouteState.CHECK_FAILED -> localized("HomeRoutes.5c47d157c9a8", "Проверка сайтов не прошла")
        RouteState.BLOCKED -> localized("HomeRoutes.05672557b746", "Соединения заблокированы")
        RouteState.DIRECT -> localized("HomeRoutes.532ec469ebd5", "Напрямую")
        RouteState.IDLE -> if (running) localized("HomeRoutes.d78f30c691fb", "Путь ещё не проверен") else localized("HomeRoutes.84896c3335dd", "Применится при включении")
        RouteState.OFF -> localized("HomeRoutes.45bcfb123150", "Маршрут выключен")
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = when (route.state) {
        RouteState.OK -> WaarpGreen
        RouteState.CHECK_FAILED -> WaarpWarning
        RouteState.BLOCKED -> MaterialTheme.colorScheme.error
        RouteState.FALLBACK, RouteState.RETRYING -> WaarpWarning
        else -> WaarpMuted
    })
}

@Composable
internal fun RouteEditorSheet(state: MobileState, actions: MobileActions, id: String?, suggestedTarget: String?, suggestedVia: String?, onDismiss: () -> Unit) {
    val existing = state.routes.find { it.id == id }
    val operation = rememberModalOperation(onDismiss)
    if (id != null && existing == null) { PendingRemovalSheet(operation, onDismiss); return }
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
    var connectionUse by rememberSaveable { mutableStateOf(ConnectionUses.normalize(existing?.connectionUse)) }
    var recommendationProof by rememberSaveable { mutableStateOf<String?>(null) }
    var step by rememberSaveable { mutableStateOf("form") }
    val checkContextId = rememberSaveable { UUID.randomUUID().toString() }
    var checkTarget by rememberSaveable { mutableStateOf("") }
    DisposableEffect(checkContextId) { onDispose { actions.cancelDiagnostic(checkContextId) } }
    val choices = rememberPathChoices(state)
    val fallbackChoices = listOf(PathChoice("", localized("HomeRoutes.7d57cd2afb8f", "Без резерва"), localized("HomeRoutes.9cfa3b607d82", "Если путь недоступен — блокировать соединения"))) + choices.filter { it.id != via && it.id != DIRECT_PATH }
    val selectedKind = RouteKind.valueOf(kind)
    val eligibleApps = remember(state.apps, query, showSystem, packageName) { state.apps.filter { (!it.system || showSystem || it.packageName == packageName) &&
        (it.name.contains(query, true) || it.packageName.contains(query, true)) } }
    val draft = RouteDraft(id, selectedKind, name.trim().ifBlank { selector.trim() }, via,
        fallback.takeIf { via != DIRECT_PATH && it != DIRECT_PATH }, enabled,
        packageName.takeIf { selectedKind == RouteKind.APP }, presetId.takeIf { selectedKind == RouteKind.SERVICE },
        selector.trim().takeIf { selectedKind == RouteKind.CUSTOM }, connectionUse, recommendationProof)
    val title = when (step) { "check" -> localized("HomeRoutes.da327e7ff2e3", "Проверить соединение"); "path" -> localized("HomeRoutes.d5509720b862", "Выбрать путь"); else -> if (existing == null) localized("HomeRoutes.95bf7bfac1d8", "Новый маршрут") else localized("HomeRoutes.d583b5a87f0e", "Изменить маршрут") }
    FormSheet(title, operation.busy, { actions.cancelDiagnostic(checkContextId); onDismiss() }) {
        BackHandler(enabled = step != "form") { actions.cancelDiagnostic(checkContextId); step = "form" }
        if (step == "check") {
            RouteConnectionCheck(state, actions, draft, checkContextId, checkTarget, { checkTarget = it; recommendationProof = null },
                onBack = { actions.cancelDiagnostic(checkContextId); step = "form" },
                onSelect = { path, proof -> via = path; recommendationProof = proof; if (fallback == path) fallback = null; step = "form" })
            return@FormSheet
        }
        if (step == "path") {
            RoutePathPicker(state, via, { step = "form" }) { path ->
                via = path; recommendationProof = null; if (fallback == path || path == DIRECT_PATH) fallback = null; step = "form"
            }
            return@FormSheet
        }
        if (existing == null) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(RouteKind.APP to localized("HomeRoutes.1d231e511e66", "Приложение"), RouteKind.SERVICE to localized("HomeRoutes.89178f893d62", "Сервис"), RouteKind.CUSTOM to localized("HomeRoutes.a8c9517b8f0a", "Адрес")).forEach { (type, label) ->
                FilterChip(selected = type == selectedKind, onClick = { kind = type.name; query = "" }, label = { Text(label) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        when (selectedKind) {
            RouteKind.APP -> {
                Text(localized("HomeRoutes.1eece3ae221f", "Выбери установленное приложение"), style = MaterialTheme.typography.titleSmall)
                packageName?.let { KeyValue(localized("HomeRoutes.1e7993bbe3ab", "Выбрано"), state.apps.find { app -> app.packageName == it }?.name ?: it) }
                SearchField(query, { query = it }, localized("HomeRoutes.e95dcfe9b966", "Название или пакет"))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    BooleanOption(localized("HomeRoutes.b6543051dcb7", "Системные приложения"), value = showSystem, modifier = Modifier.weight(1f)) { showSystem = it }
                    TextButton(onClick = { operation.run({ actions.refreshApps() }) }, enabled = !operation.busy) { Text(localized("HomeRoutes.8e4db3a44122", "Обновить")) }
                }
                if (eligibleApps.isEmpty()) Text(localized("HomeRoutes.675a4aac7132", "Приложения не найдены. Обнови список или измени поиск."), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
                else LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
                    items(eligibleApps, key = { it.packageName }, contentType = { "app" }) { app ->
                        Row(Modifier.fillMaxWidth().selectable(selected = packageName == app.packageName, enabled = !operation.busy, role = Role.RadioButton) {
                            packageName = app.packageName; if (name.isBlank() || existing == null) name = app.name
                        }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            AppIcon(app, app.name); Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) { Text(app.name, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(app.packageName, style = MaterialTheme.typography.labelSmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            if (packageName == app.packageName) Icon(Icons.Outlined.Check, localized("HomeRoutes.1e7993bbe3ab", "Выбрано"), tint = WaarpOrange)
                        }
                    }
                }
                Text(localized("HomeRoutes.fa06408a8920", "Android применяет правила к UID. Приложения с общим UID получают один путь."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
            }
            RouteKind.SERVICE -> {
                val serviceChoices = state.presets.map { PathChoice(it.id, it.name, it.description) }
                PathField(localized("HomeRoutes.89178f893d62", "Сервис"), presetId, serviceChoices, !operation.busy) { selected ->
                    presetId = selected; if (name.isBlank() || existing == null) name = state.presets.find { it.id == selected }?.name.orEmpty()
                }
                state.presets.find { it.id == presetId }?.let { Text(it.description, color = WaarpMuted, style = MaterialTheme.typography.bodySmall) }
            }
            RouteKind.CUSTOM -> {
                OutlinedTextField(selector, { selector = it }, Modifier.fillMaxWidth(), enabled = !operation.busy, label = { Text(localized("HomeRoutes.e6da5fd717f9", "Домены, IP или подсети CIDR")) },
                    placeholder = { Text(localized("HomeRoutes.8e25e1806de1", "example.com\n10.10.0.0/16")) }, minLines = 2, maxLines = 5)
                Text(localized("HomeRoutes.731dc9f23e80", "Домен охватывает его поддомены. Несколько адресов — по одному в строке."), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = !operation.busy, label = { Text(localized("HomeRoutes.4ee8f9dd9834", "Название")) }, singleLine = true)
        PathField(localized("HomeRoutes.f399ac50c7d8", "Основной путь"), via, choices, !operation.busy) { via = it; recommendationProof = null; if (fallback == it || it == DIRECT_PATH) fallback = null }
        TextButton(onClick = { step = "path" }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(localized("HomeRoutes.52f9b7bf06e3", "Список и карта подключений")) }
        PathField(localized("HomeRoutes.101631dda493", "Для чего используется"), connectionUse, ConnectionUses.ids.map { PathChoice(it, ConnectionUses.label(it), "") }, !operation.busy) {
            connectionUse = it; recommendationProof = null
        }
        TextButton(onClick = {
            if (checkTarget.isBlank()) checkTarget = when (selectedKind) {
                RouteKind.SERVICE -> state.presets.find { it.id == presetId }?.domains?.firstOrNull().orEmpty()
                RouteKind.CUSTOM -> selector.lineSequence().firstOrNull()?.trim()?.takeIf { !it.contains('/') && !it.contains(',') }.orEmpty()
                RouteKind.APP -> ""
            }
            step = "check"
        }, enabled = !operation.busy && when (selectedKind) { RouteKind.APP -> packageName != null; RouteKind.SERVICE -> presetId != null; RouteKind.CUSTOM -> selector.isNotBlank() },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(localized("HomeRoutes.f89044b95041", "Проверить соединение для маршрута")) }
        if (recommendationProof != null) Text(localized("HomeRoutes.d5b15100c8df", "Путь выбран по проверке. Изменение вступит в силу после сохранения маршрута."), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
        if (via != DIRECT_PATH) {
            PathField(localized("HomeRoutes.e06e6fa6cda7", "Если основной недоступен"), fallback ?: "", fallbackChoices, !operation.busy) { fallback = it.takeIf(String::isNotBlank) }
            Text(localized("HomeRoutes.8b75107789d4", "Резервный туннель или группа; без выхода напрямую."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(localized("HomeRoutes.8fa5fd4288fc", "Маршрут включён"), Modifier.weight(1f)); Checkbox(enabled, { enabled = it }, enabled = !operation.busy)
        }
        OperationFeedback(operation)
        val hasTarget = when (selectedKind) { RouteKind.APP -> packageName != null; RouteKind.SERVICE -> presetId != null; RouteKind.CUSTOM -> selector.isNotBlank() }
        ActionButton(localized("HomeRoutes.32f25c02ba68", "Сохранить маршрут"), operation.busy, enabled = hasTarget && (name.isNotBlank() || selectedKind == RouteKind.CUSTOM) && choices.any { it.id == via && it.enabled },
            onClick = { operation.submit({ actions.saveRoute(draft) }) }, modifier = Modifier.fillMaxWidth())
        if (id != null) {
            if (deleting) {
                InlineMessage(localized("HomeRoutes.0473afd58e0c", "После удаления соединения будут следовать общему пути устройства."))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { deleting = false }, enabled = !operation.busy, modifier = Modifier.weight(1f).height(48.dp)) { Text(localized("HomeRoutes.75dea962e428", "Отмена")) }
                    Button(onClick = { operation.submit({ actions.deleteRoute(id) }) }, enabled = !operation.busy, modifier = Modifier.weight(1f).height(48.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)) { Text(localized("HomeRoutes.1767ceb2d178", "Удалить")) }
                }
            } else TextButton(onClick = { deleting = true }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Icon(Icons.Outlined.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text(localized("HomeRoutes.d6ca43270d4f", "Удалить маршрут"))
            }
        }
    }
}

@Composable
internal fun FormSheet(title: String, busy: Boolean, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val busyNow by rememberUpdatedState(busy)
    val snackbar = LocalOperationSnackbar.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { next -> !busyNow || next != SheetValue.Hidden })
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, sheetState = sheetState,
        sheetMaxWidth = 680.dp) {
        BoxWithConstraints(Modifier.fillMaxWidth().imePadding()) {
            // Reserve this area even without a message. Its height depends only on
            // the window/font scale, so appearing feedback cannot move controls.
            // A separate scrolling viewport keeps long messages inside the footer,
            // never over the form's last action or behind the modal window.
            val notificationHeight = minOf(96.dp * LocalDensity.current.fontScale.coerceAtLeast(1f), 160.dp, maxHeight / 4)
            Column(Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f, fill = false).testTag("waarp-form-sheet").fillMaxWidth()
                    .verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    content()
                }
                if (snackbar != null) {
                    val notificationScroll = rememberScrollState()
                    LaunchedEffect(snackbar.currentSnackbarData) { notificationScroll.scrollTo(0) }
                    Box(Modifier.testTag("waarp-form-notifications").fillMaxWidth().height(notificationHeight).clipToBounds(),
                        contentAlignment = Alignment.BottomCenter) {
                        Box(Modifier.testTag("waarp-form-notification-viewport").fillMaxWidth().heightIn(max = notificationHeight)
                            .verticalScroll(notificationScroll).padding(12.dp)) {
                            SnackbarHost(snackbar, Modifier.fillMaxWidth())
                        }
                    }
                }
            }
        }
    }
}
