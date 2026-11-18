@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun ImportSheet(actions: MobileActions, onDismiss: () -> Unit, externalMessage: UiMessage? = null) {
    val operation = rememberModalOperation(onDismiss)
    var mode by rememberSaveable { mutableStateOf("text") }
    var name by rememberSaveable { mutableStateOf("") }
    // Credentials must never enter Android's saved instance state or persistent screen DTOs.
    var text by rememberModalText("configuration")
    var visible by remember { mutableStateOf(false) }
    var address by rememberModalText("address")
    var endpoint by rememberModalText("endpoint")
    var publicKey by rememberModalText("public-key")
    val initialMessage = remember { externalMessage?.id }
    var externalFeedback by remember { mutableStateOf<UiMessage?>(null) }
    LaunchedEffect(externalMessage?.id) {
        if (externalMessage != null && externalMessage.id != initialMessage) externalFeedback = externalMessage
    }
    FormSheet("Добавить туннель", operation.busy, onDismiss) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { actions.requestFileImport() }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.Description, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Файл") }
            OutlinedButton(onClick = actions::requestQrImport, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("QR-код") }
            OutlinedButton(onClick = actions::requestClipboardImport, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.ContentPaste, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Буфер") }
        }
        externalFeedback?.takeIf { it.error }?.let { InlineMessage(it.text, error = true) }
        HorizontalDivider()
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("text" to "Текст / ссылка", "subscription" to "Подписка", "wireguard" to "WireGuard").forEach { (key, label) ->
                FilterChip(mode == key, onClick = { mode = key; operation.clearError() }, label = { Text(label) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(if (mode == "wireguard") "Название" else "Название (необязательно)") }, singleLine = true, enabled = !operation.busy)
        if (mode == "wireguard") {
            Text("Создать конфигурацию WireGuard для своего сервера", style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), label = { Text("Адрес клиента с маской") }, placeholder = { Text("10.8.0.2/32") }, singleLine = true, enabled = !operation.busy)
            OutlinedTextField(endpoint, { endpoint = it }, Modifier.fillMaxWidth(), label = { Text("Адрес сервера и порт") }, placeholder = { Text("vpn.example.com:51820") }, singleLine = true, enabled = !operation.busy)
            OutlinedTextField(publicKey, { publicKey = it }, Modifier.fillMaxWidth(), label = { Text("Публичный ключ сервера") }, minLines = 2, maxLines = 3, enabled = !operation.busy)
            InlineMessage("Waarp создаст ключ клиента. После сохранения добавь его публичный ключ на сервер — он будет в карточке туннеля. Для готовой конфигурации используй импорт.")
        } else {
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), enabled = !operation.busy,
                label = { Text(if (mode == "subscription") "URL подписки" else "Конфигурация или ссылка") },
                placeholder = { Text(if (mode == "subscription") "https://…" else "Вставь данные подключения") },
                minLines = if (mode == "subscription") 2 else 5, maxLines = 8,
                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = { IconButton(onClick = { visible = !visible }) { Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) "Скрыть данные" else "Показать данные") } })
            Text(if (mode == "subscription") "Ссылка может содержать личный токен. Импортированные серверы обновляются из карточки подписки."
                else "Ссылки, .conf, .ovpn и JSON outbound MASQUE. Для WARP нужны свои ключи и адреса из регистрации. Данные проверяются перед сохранением.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        OperationFeedback(operation)
        ActionButton(if (mode == "wireguard") "Создать WireGuard" else "Импортировать", operation.busy,
            enabled = if (mode == "wireguard") name.isNotBlank() && address.isNotBlank() && endpoint.isNotBlank() && publicKey.isNotBlank() else text.isNotBlank(),
            onClick = {
                operation.submit({ if (mode == "wireguard") actions.createWireGuard(WireGuardDraft(name.trim(), address.trim(), endpoint.trim(), publicKey.trim()))
                    else actions.importText(text.trim(), name.trim()) })
            }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun TunnelDetailsSheet(profile: TunnelUi, state: MobileState, actions: MobileActions, onDismiss: () -> Unit,
    onRename: () -> Unit, onReplace: () -> Unit, onDelete: () -> Unit) {
    val operation = rememberModalOperation()
    FormSheet(profile.name, operation.busy, onDismiss) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { HealthLabel(profile.health, profile.latencyMs); SourceBadge(profile.source) }
        SelectionContainer {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                KeyValue("Протокол", profile.protocol)
                if (profile.host.isNotBlank()) KeyValue("Сервер", "${profile.host}${if (profile.port > 0) ":${profile.port}" else ""}", mono = true)
                if (LocalDeveloperMode.current && profile.addresses.isNotEmpty()) KeyValue("Адреса клиента", profile.addresses.joinToString("\n"), mono = true)
                if (LocalDeveloperMode.current) profile.clientPublicKey?.let { KeyValue("Публичный ключ клиента", it, mono = true) }
                if (LocalDeveloperMode.current) profile.technical.forEach { (label, value) -> KeyValue(label, value, mono = true) }
            }
        }
        if (profile.revoked) InlineMessage("Этот профиль отозван и не используется для новых соединений.", error = true)
        if (profile.subscriptionMissing) InlineMessage("Сервер отсутствует в последней версии подписки. Маршруты сохраняются до твоего решения.", error = true)
        if (profile.source == ProfileSource.PUBLIC) InlineMessage("Это публичный сервер третьей стороны. Он не включается в Авто; назначение маршрутам всегда явное.")
        val routes = state.routes.filter { it.viaId == profile.id || it.fallbackViaId == profile.id }
        val groups = state.groups.filter { profile.id in it.members }
        val usage = buildList {
            add("${routes.size} маршрутов")
            add("${groups.count { it.id != AUTO_PATH }} групп")
            if (state.settings.defaultViaId == profile.id) add("общий путь устройства")
            if (state.settings.systemDnsViaId == profile.id) add("Общий DNS Android")
        }
        Text("Используется: ${usage.joinToString(" · ")}",
            color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
        if (profile.canTune || profile.tuneLabel != null) TunnelTuningControls(profile, state, actions)
        if (profile.subscription) {
            OutlinedButton(onClick = { operation.run({ actions.refreshSubscription(profile.id) }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text("Обновить подписку")
            }
        }
        OperationFeedback(operation)
        if (profile.canRename) OutlinedButton(onClick = onRename, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.Edit, null); Spacer(Modifier.width(8.dp)); Text("Переименовать") }
        if (profile.canReplace) OutlinedButton(onClick = onReplace, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.SwapHoriz, null); Spacer(Modifier.width(8.dp)); Text("Заменить конфигурацию") }
        if (profile.canDelete) TextButton(onClick = onDelete, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Icon(Icons.Outlined.DeleteOutline, null, tint = MaterialTheme.colorScheme.error); Spacer(Modifier.width(8.dp)); Text("Удалить туннель", color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
internal fun RenameTunnelSheet(profile: TunnelUi, actions: MobileActions, onDismiss: () -> Unit) {
    val operation = rememberModalOperation(onDismiss)
    var name by rememberSaveable(profile.id) { mutableStateOf(profile.name) }
    FormSheet("Название туннеля", operation.busy, onDismiss) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Название") }, singleLine = true, enabled = !operation.busy)
        OperationFeedback(operation)
        ActionButton("Сохранить", operation.busy, name.isNotBlank() && profile.canRename,
            onClick = { operation.submit({ actions.renameTunnel(profile.id, name.trim()) }) }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun ReplaceTunnelSheet(profile: TunnelUi, actions: MobileActions, onDismiss: () -> Unit, externalMessage: UiMessage? = null) {
    val operation = rememberModalOperation(onDismiss)
    var text by rememberModalText("configuration")
    var visible by remember { mutableStateOf(false) }
    val initialMessage = remember { externalMessage?.id }
    var externalFeedback by remember { mutableStateOf<UiMessage?>(null) }
    LaunchedEffect(externalMessage?.id) {
        if (externalMessage != null && externalMessage.id != initialMessage) externalFeedback = externalMessage
    }
    FormSheet("Заменить ${profile.name}", operation.busy, onDismiss) {
        Text("Новая конфигурация займёт место этого туннеля. Его назначения в маршрутах и группах сохранятся.", color = WaarpMuted)
        OutlinedButton(onClick = { actions.requestFileImport(profile.id) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
            Icon(Icons.Outlined.Description, null); Spacer(Modifier.width(8.dp)); Text("Выбрать файл замены")
        }
        externalFeedback?.takeIf { it.error }?.let { InlineMessage(it.text, error = true) }
        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), label = { Text("Новая конфигурация или ссылка") }, minLines = 5, maxLines = 8, enabled = !operation.busy,
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace), visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { IconButton(onClick = { visible = !visible }) { Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) "Скрыть данные" else "Показать данные") } })
        OperationFeedback(operation)
        ActionButton("Проверить и заменить", operation.busy, text.isNotBlank() && profile.canReplace,
            onClick = { operation.submit({ actions.replaceTunnel(profile.id, text.trim()) }) }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
internal fun DeletePathSheet(state: MobileState, actions: MobileActions, id: String?, group: Boolean, onDismiss: () -> Unit) {
    if (id == null) { MissingItemSheet(onDismiss); return }
    val exists = if (group) state.groups.any { it.id == id && it.id != AUTO_PATH } else state.profiles.any { it.id == id && it.canDelete }
    val operation = rememberModalOperation(onDismiss)
    if (!exists) { PendingRemovalSheet(operation, onDismiss); return }
    var replacement by rememberSaveable { mutableStateOf<String?>(null) }
    val affectedRoutes = state.routes.filter { it.viaId == id || it.fallbackViaId == id }
    val affectedGroups = if (group) emptyList() else state.groups.filter { it.id != AUTO_PATH && id in it.members }
    val isDefault = state.settings.defaultViaId == id
    val isSystemDns = state.settings.systemDnsViaId == id
    val remaining = state.profiles.filter { it.id != id && !it.revoked && !it.subscriptionMissing }
    val remainingIds = remaining.mapTo(HashSet()) { it.id }
    val excluded = buildSet {
        add(id)
        if (!group) {
            state.groups.filter { it.members.none(remainingIds::contains) }.forEach { add(it.id) }
            if (remaining.none { it.source != ProfileSource.PUBLIC }) add(AUTO_PATH)
        }
    }
    val choices = listOf(PathChoice("", "Без переназначения", "Сохранить заблокированные назначения")) + rememberPathChoices(state, excluded = excluded)
    FormSheet("Удалить ${if (group) "группу" else "туннель"}?", operation.busy, onDismiss) {
        Text(pathName(state, id), style = MaterialTheme.typography.titleMedium)
        if (affectedRoutes.isNotEmpty() || affectedGroups.isNotEmpty() || isDefault || isSystemDns) {
            Text("Затронутые назначения", fontWeight = FontWeight.SemiBold)
            if (isDefault) Text("• Общий путь устройства", style = MaterialTheme.typography.bodyMedium)
            if (isSystemDns) Text("• Общий DNS Android", style = MaterialTheme.typography.bodyMedium)
            if (affectedRoutes.isNotEmpty() || affectedGroups.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
                items(affectedRoutes, key = { "route-${it.id}" }, contentType = { "assignment" }) { route ->
                    Text("• ${route.name} — ${if (route.viaId == id) "основной" else "резервный"} путь", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                }
                items(affectedGroups, key = { "group-${it.id}" }, contentType = { "assignment" }) { item ->
                    Text("• Группа «${item.name}»", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                }
            }
            PathField("Куда переназначить маршруты", replacement ?: "", choices, !operation.busy) { replacement = it.takeIf(String::isNotBlank) }
            if (replacement == null) InlineMessage("Маршруты, которым больше некуда подключаться, останутся заблокированы. Самостоятельного перехода напрямую не будет.")
            if (isSystemDns && replacement == null) InlineMessage("Общий DNS останется заблокирован до выбора доступного пути.")
            if (replacement == DIRECT_PATH) InlineMessage("Ты явно выбираешь прямое подключение для затронутых назначений. Эти соединения пойдут вне туннеля.")
        } else Text(if (group) "Группа не назначена маршрутам. Её туннели останутся в списке." else "Туннель не назначен маршрутам. Его можно будет добавить снова через импорт.", color = WaarpMuted)
        OperationFeedback(operation)
        Button(onClick = { operation.submit({ if (group) actions.deleteGroup(id, replacement) else actions.removeTunnel(id, replacement) }) },
            enabled = !operation.busy, modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)) {
            if (operation.busy) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
            Text(if (replacement == null) "Удалить" else "Переназначить и удалить")
        }
        TextButton(onClick = onDismiss, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Отмена") }
    }
}

@Composable
internal fun GroupEditorSheet(state: MobileState, actions: MobileActions, id: String?, onDismiss: () -> Unit, onDelete: () -> Unit) {
    if (id == AUTO_PATH) { AutoDetailsSheet(state, onDismiss); return }
    val existing = state.groups.find { it.id == id }
    val operation = rememberModalOperation(onDismiss)
    if (id != null && existing == null) { PendingRemovalSheet(operation, onDismiss); return }
    var name by rememberSaveable { mutableStateOf(existing?.name.orEmpty()) }
    var policy by rememberSaveable { mutableStateOf(existing?.policy?.name ?: GroupPolicy.FASTEST.name) }
    var members by rememberSaveable { mutableStateOf(existing?.members ?: emptyList()) }
    var query by rememberSaveable { mutableStateOf("") }
    val candidates = remember(state.profiles, query) { state.profiles.filter { !it.revoked && !it.subscriptionMissing && (it.name.contains(query, true) || it.protocol.contains(query, true)) } }
    val names = rememberPathNames(state)
    val membership = remember(members) { members.toHashSet() }
    val hasPublic = remember(state.profiles, membership) { state.profiles.any { it.id in membership && it.source == ProfileSource.PUBLIC } }
    FormSheet(if (id == null) "Новая группа" else "Изменить группу", operation.busy, onDismiss) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Название группы") }, singleLine = true, enabled = !operation.busy)
        Text("Как выбирать туннель", style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GroupPolicy.entries.forEach { option ->
                FilterChip(policy == option.name, onClick = { policy = option.name }, label = { Text(policyLabel(option)) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Text(if (policy == GroupPolicy.FIRST.name) "Первый доступный туннель по порядку ниже. Подними предпочтительный выше."
            else "Выбор среди доступных по измеренной задержке; порядок задаёт предпочтение при равных результатах.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        if (members.isNotEmpty()) {
            SectionHeading("В группе · ${members.size}")
            LazyColumn(Modifier.testTag("group-members").fillMaxWidth().heightIn(max = 280.dp)) {
            items(members.size, key = { members[it] }, contentType = { "member" }) { index ->
                val member = members[index]
                val memberName = names[member] ?: "Недоступный путь"
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${index + 1}", Modifier.width(28.dp), color = WaarpMuted)
                    Text(memberName, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = { members = members.toMutableList().apply { add(index - 1, removeAt(index)) }.toList() }, enabled = index > 0 && !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.ArrowUpward, "Поднять ${memberName}") }
                    IconButton(onClick = { members = members.toMutableList().apply { add(index + 1, removeAt(index)) }.toList() }, enabled = index < members.lastIndex && !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.ArrowDownward, "Опустить ${memberName}") }
                    IconButton(onClick = { members = members - member }, enabled = !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.DeleteOutline, "Убрать ${memberName} из группы") }
                }
            }
            }
        }
        SearchField(query, { query = it }, "Добавить туннели в группу")
        if (candidates.isEmpty()) Text("Доступных туннелей не найдено. Сначала добавь или восстанови профиль.", color = WaarpMuted)
        else LazyColumn(Modifier.testTag("group-candidates").fillMaxWidth().heightIn(max = 280.dp)) {
            items(candidates, key = { it.id }, contentType = { "candidate" }) { profile ->
                Row(Modifier.fillMaxWidth().toggleable(value = profile.id in membership, enabled = !operation.busy, role = Role.Checkbox, onValueChange = { checked -> members = if (checked) members + profile.id else members - profile.id })
                    .heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(profile.id in membership, onCheckedChange = null, enabled = !operation.busy)
                    Column(Modifier.weight(1f)) { Text(profile.name); Text(profile.protocol, style = MaterialTheme.typography.bodySmall, color = WaarpMuted); SourceBadge(profile.source) }
                    HealthLabel(profile.health, profile.latencyMs)
                }
            }
        }
        if (hasPublic) InlineMessage("Группа содержит публичный сервер. Назначай её только маршрутам, для которых доверяешь этим владельцам.")
        OperationFeedback(operation)
        ActionButton("Сохранить группу", operation.busy, name.isNotBlank() && members.isNotEmpty(),
            onClick = { operation.submit({ actions.saveGroup(GroupDraft(id, name.trim(), GroupPolicy.valueOf(policy), members)) }) }, modifier = Modifier.fillMaxWidth())
        if (existing != null) TextButton(onClick = onDelete, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Outlined.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text("Удалить группу") }
    }
}

@Composable
private fun AutoDetailsSheet(state: MobileState, onDismiss: () -> Unit) {
    val automatic = state.groups.find { it.id == AUTO_PATH }
    val eligible = remember(state.profiles) { state.profiles.filter { it.source != ProfileSource.PUBLIC && !it.revoked && !it.subscriptionMissing } }
    FormSheet("Автоматический путь", false, onDismiss) {
        Text("Авто выбирает рабочий путь из собственных туннелей. Публичные, отозванные и пропавшие из подписки профили исключены.", color = WaarpMuted)
        Text("Переключение опирается на проверки доступности; небольшое изменение задержки не должно вызывать постоянную смену сервера.", color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
        automatic?.selectedMemberId?.let { KeyValue("Сейчас выбран", pathName(state, it)) }
        state.status.autoPoolTotal?.let { KeyValue("Рабочий пул", "${state.status.autoPoolLive ?: 0} из $it") }
        SectionHeading("Подходящие туннели", "${eligible.size} профилей")
        if (eligible.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
        items(eligible, key = { it.id }, contentType = { "eligible" }) { profile ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(profile.name, Modifier.weight(1f)); HealthLabel(profile.health, profile.latencyMs)
            }
        }
        }
        if (eligible.isEmpty()) InlineMessage("Добавь собственный туннель, чтобы использовать Авто.")
        InlineMessage("Когда доступных путей нет, назначенные на Авто соединения блокируются. Прямой путь выбирается отдельно.")
        Button(onClick = onDismiss, Modifier.fillMaxWidth().height(50.dp)) { Text("Понятно") }
    }
}

@Composable
internal fun PendingRemovalSheet(operation: UiOperation, onDismiss: () -> Unit) {
    when {
        operation.completions > 0 -> Unit // The retained completion closes the current form.
        operation.busy || operation.error != null -> FormSheet("Применяем изменения", operation.busy, onDismiss) {
            if (operation.busy) {
                CircularProgressIndicator(Modifier.size(28.dp))
                Text("Дожидаемся завершения сохранения и применения настроек VPN.", color = WaarpMuted)
            }
            OperationFeedback(operation)
            if (!operation.busy) Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text("Закрыть") }
        }
        else -> MissingItemSheet(onDismiss)
    }
}
