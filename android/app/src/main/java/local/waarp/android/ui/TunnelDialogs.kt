@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import local.waarp.android.i18n.localized

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
    FormSheet(localized("TunnelDialogs.5dc2541299bb", "Добавить туннель"), operation.busy, onDismiss) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { actions.requestFileImport() }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.Description, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.aaed16b5f27c", "Файл")) }
            OutlinedButton(onClick = actions::requestQrImport, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.b98d90e55bd2", "QR-код")) }
            OutlinedButton(onClick = actions::requestClipboardImport, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.ContentPaste, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.da9cb5399119", "Буфер")) }
        }
        externalFeedback?.takeIf { it.error }?.let { InlineMessage(it.text, error = true) }
        HorizontalDivider()
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("text" to localized("TunnelDialogs.f010566ef175", "Текст / ссылка"), "subscription" to localized("TunnelDialogs.2374b80feb07", "Подписка"), "wireguard" to "WireGuard").forEach { (key, label) ->
                FilterChip(mode == key, onClick = { mode = key; operation.clearError() }, label = { Text(label) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(if (mode == "wireguard") localized("TunnelDialogs.a96da5c173f7", "Название") else localized("TunnelDialogs.4a825d0bf490", "Название (необязательно)")) }, singleLine = true, enabled = !operation.busy)
        if (mode == "wireguard") {
            Text(localized("TunnelDialogs.c1eff4c2970c", "Создать конфигурацию WireGuard для своего сервера"), style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.383b483789e4", "Адрес клиента с маской")) }, placeholder = { Text(localized("TunnelDialogs.77bf65774af2", "10.8.0.2/32")) }, singleLine = true, enabled = !operation.busy)
            OutlinedTextField(endpoint, { endpoint = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.b8dc14f4b7de", "Адрес сервера и порт")) }, placeholder = { Text(localized("TunnelDialogs.c4f753f80f1b", "vpn.example.com:51820")) }, singleLine = true, enabled = !operation.busy)
            OutlinedTextField(publicKey, { publicKey = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.cf3d48bed973", "Публичный ключ сервера")) }, minLines = 2, maxLines = 3, enabled = !operation.busy)
            InlineMessage(localized("TunnelDialogs.45bf6ae68f45", "Waarp создаст ключ клиента. После сохранения добавь его публичный ключ на сервер — он будет в карточке туннеля. Для готовой конфигурации используй импорт."))
        } else {
            OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), enabled = !operation.busy,
                label = { Text(if (mode == "subscription") localized("TunnelDialogs.aab831ba8c0d", "URL подписки") else localized("TunnelDialogs.3f1207c320fc", "Конфигурация или ссылка")) },
                placeholder = { Text(if (mode == "subscription") "https://…" else localized("TunnelDialogs.56634bf849f5", "Вставь данные подключения")) },
                minLines = if (mode == "subscription") 2 else 5, maxLines = 8,
                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = { IconButton(onClick = { visible = !visible }) { Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) localized("TunnelDialogs.3a5a12f51528", "Скрыть данные") else localized("TunnelDialogs.3b82d92b46bc", "Показать данные")) } })
            Text(if (mode == "subscription") localized("TunnelDialogs.76a179615674", "Ссылка может содержать личный токен. Импортированные серверы обновляются из карточки подписки.")
                else localized("TunnelDialogs.94dfdf86b119", "Ссылки, .conf, .ovpn и JSON outbound MASQUE. Для WARP нужны свои ключи и адреса из регистрации. Данные проверяются перед сохранением."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        }
        OperationFeedback(operation)
        ActionButton(if (mode == "wireguard") localized("TunnelDialogs.f1161d4dec2e", "Создать WireGuard") else localized("TunnelDialogs.ee026773c6b6", "Импортировать"), operation.busy,
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
                KeyValue(localized("TunnelDialogs.3f9595680c1f", "Протокол"), profile.protocol)
                if (profile.host.isNotBlank()) KeyValue(localized("TunnelDialogs.3ae115e250c9", "Сервер"), "${profile.host}${if (profile.port > 0) ":${profile.port}" else ""}", mono = true)
                if (LocalDeveloperMode.current && profile.addresses.isNotEmpty()) KeyValue(localized("TunnelDialogs.e86019f06866", "Адреса клиента"), profile.addresses.joinToString("\n"), mono = true)
                if (LocalDeveloperMode.current) profile.clientPublicKey?.let { KeyValue(localized("TunnelDialogs.6672d4be32eb", "Публичный ключ клиента"), it, mono = true) }
                if (LocalDeveloperMode.current) profile.technical.forEach { (label, value) -> KeyValue(label, value, mono = true) }
            }
        }
        if (profile.revoked) InlineMessage(localized("TunnelDialogs.1cdc7d34eed2", "Этот профиль отозван и не используется для новых соединений."), error = true)
        if (profile.subscriptionMissing) InlineMessage(localized("TunnelDialogs.8d2263ce593f", "Сервер отсутствует в последней версии подписки. Маршруты сохраняются до твоего решения."), error = true)
        if (profile.source == ProfileSource.PUBLIC) InlineMessage(localized("TunnelDialogs.60d0d7064385", "Это публичный сервер третьей стороны. Он не включается в Авто; назначение маршрутам всегда явное."))
        val routes = state.routes.filter { it.viaId == profile.id || it.fallbackViaId == profile.id }
        val groups = state.groups.filter { profile.id in it.members }
        val usage = buildList {
            add(localized("TunnelDialogs.090109ed1ce7", "{arg1} маршрутов", routes.size))
            add(localized("TunnelDialogs.18919b3fcdd5", "{arg1} групп", groups.count { it.id != AUTO_PATH }))
            if (state.settings.defaultViaId == profile.id) add(localized("TunnelDialogs.56cf874d5ac6", "общий путь устройства"))
            if (state.settings.systemDnsViaId == profile.id) add(localized("TunnelDialogs.f0aaff390ca0", "Общий DNS Android"))
        }
        Text(localized("TunnelDialogs.c833b128f9b6", "Используется: {arg1}", usage.joinToString(" · ")),
            color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
        if (profile.canTune || profile.tuneLabel != null) TunnelTuningControls(profile, state, actions)
        if (profile.subscription) {
            OutlinedButton(onClick = { operation.run({ actions.refreshSubscription(profile.id) }) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
                Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.9254f229cea4", "Обновить подписку"))
            }
        }
        OperationFeedback(operation)
        if (profile.canRename) OutlinedButton(onClick = onRename, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.Edit, null); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.38dd21d70183", "Переименовать")) }
        if (profile.canReplace) OutlinedButton(onClick = onReplace, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.SwapHoriz, null); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.98c1132fb33b", "Заменить конфигурацию")) }
        if (profile.canDelete) TextButton(onClick = onDelete, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Icon(Icons.Outlined.DeleteOutline, null, tint = MaterialTheme.colorScheme.error); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.3a77e3e3ec0c", "Удалить туннель"), color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
internal fun RenameTunnelSheet(profile: TunnelUi, actions: MobileActions, onDismiss: () -> Unit) {
    val operation = rememberModalOperation(onDismiss)
    var name by rememberSaveable(profile.id) { mutableStateOf(profile.name) }
    FormSheet(localized("TunnelDialogs.33d3dcdfa9e4", "Название туннеля"), operation.busy, onDismiss) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.60704ce0eae2", "Название")) }, singleLine = true, enabled = !operation.busy)
        OperationFeedback(operation)
        ActionButton(localized("TunnelDialogs.847b93445b16", "Сохранить"), operation.busy, name.isNotBlank() && profile.canRename,
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
    FormSheet(localized("TunnelDialogs.5988b8b99080", "Заменить {arg1}", profile.name), operation.busy, onDismiss) {
        Text(localized("TunnelDialogs.567d5fb9d684", "Новая конфигурация займёт место этого туннеля. Его назначения в маршрутах и группах сохранятся."), color = WaarpMuted)
        OutlinedButton(onClick = { actions.requestFileImport(profile.id) }, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
            Icon(Icons.Outlined.Description, null); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.15619d1b414c", "Выбрать файл замены"))
        }
        externalFeedback?.takeIf { it.error }?.let { InlineMessage(it.text, error = true) }
        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.f1a63957221b", "Новая конфигурация или ссылка")) }, minLines = 5, maxLines = 8, enabled = !operation.busy,
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace), visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { IconButton(onClick = { visible = !visible }) { Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) localized("TunnelDialogs.f6dd5b4cbadd", "Скрыть данные") else localized("TunnelDialogs.9789b05b018a", "Показать данные")) } })
        OperationFeedback(operation)
        ActionButton(localized("TunnelDialogs.6e2c32084b5c", "Проверить и заменить"), operation.busy, text.isNotBlank() && profile.canReplace,
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
    val choices = listOf(PathChoice("", localized("TunnelDialogs.bc53d29bfd67", "Без переназначения"), localized("TunnelDialogs.e58f4a928a31", "Сохранить заблокированные назначения"))) + rememberPathChoices(state, excluded = excluded)
    FormSheet(localized("TunnelDialogs.7b42b70b6bc0", "Удалить {arg1}?", if (group) localized("TunnelDialogs.945946ffed05", "группу") else localized("TunnelDialogs.34c76b7c8767", "туннель")), operation.busy, onDismiss) {
        Text(pathName(state, id), style = MaterialTheme.typography.titleMedium)
        if (affectedRoutes.isNotEmpty() || affectedGroups.isNotEmpty() || isDefault || isSystemDns) {
            Text(localized("TunnelDialogs.33a13446b9e5", "Затронутые назначения"), fontWeight = FontWeight.SemiBold)
            if (isDefault) Text(localized("TunnelDialogs.963d36942724", "• Общий путь устройства"), style = MaterialTheme.typography.bodyMedium)
            if (isSystemDns) Text(localized("TunnelDialogs.5afd88d09361", "• Общий DNS Android"), style = MaterialTheme.typography.bodyMedium)
            if (affectedRoutes.isNotEmpty() || affectedGroups.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
                items(affectedRoutes, key = { "route-${it.id}" }, contentType = { "assignment" }) { route ->
                    Text(localized("TunnelDialogs.4d90df1199ff", "• {arg1} — {arg2} путь", route.name, if (route.viaId == id) localized("TunnelDialogs.979ce0214339", "основной") else localized("TunnelDialogs.7c18b83d2ccd", "резервный")), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                }
                items(affectedGroups, key = { "group-${it.id}" }, contentType = { "assignment" }) { item ->
                    Text(localized("TunnelDialogs.de00ac0571cf", "• Группа «{arg1}»", item.name), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                }
            }
            PathField(localized("TunnelDialogs.aa392d4e1322", "Куда переназначить маршруты"), replacement ?: "", choices, !operation.busy) { replacement = it.takeIf(String::isNotBlank) }
            if (replacement == null) InlineMessage(localized("TunnelDialogs.b0f91d289bbe", "Маршруты, которым больше некуда подключаться, останутся заблокированы. Самостоятельного перехода напрямую не будет."))
            if (isSystemDns && replacement == null) InlineMessage(localized("TunnelDialogs.4fce5f60628c", "Общий DNS останется заблокирован до выбора доступного пути."))
            if (replacement == DIRECT_PATH) InlineMessage(localized("TunnelDialogs.f419e90dfa3b", "Ты явно выбираешь прямое подключение для затронутых назначений. Эти соединения пойдут вне туннеля."))
        } else Text(if (group) localized("TunnelDialogs.f7fd0c59c4cd", "Группа не назначена маршрутам. Её туннели останутся в списке.") else localized("TunnelDialogs.31583767fdb1", "Туннель не назначен маршрутам. Его можно будет добавить снова через импорт."), color = WaarpMuted)
        OperationFeedback(operation)
        Button(onClick = { operation.submit({ if (group) actions.deleteGroup(id, replacement) else actions.removeTunnel(id, replacement) }) },
            enabled = !operation.busy, modifier = Modifier.fillMaxWidth().height(50.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.errorContainer, contentColor = MaterialTheme.colorScheme.onErrorContainer)) {
            if (operation.busy) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)) }
            Text(if (replacement == null) localized("TunnelDialogs.5096e41e08a3", "Удалить") else localized("TunnelDialogs.73c7b10d4b07", "Переназначить и удалить"))
        }
        TextButton(onClick = onDismiss, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(localized("TunnelDialogs.b6b055911fd0", "Отмена")) }
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
    FormSheet(if (id == null) localized("TunnelDialogs.f3bcb33678d4", "Новая группа") else localized("TunnelDialogs.cdff20c08be9", "Изменить группу"), operation.busy, onDismiss) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(localized("TunnelDialogs.93153f0dab95", "Название группы")) }, singleLine = true, enabled = !operation.busy)
        Text(localized("TunnelDialogs.68713d1534e3", "Как выбирать туннель"), style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GroupPolicy.entries.forEach { option ->
                FilterChip(policy == option.name, onClick = { policy = option.name }, label = { Text(policyLabel(option)) }, enabled = !operation.busy, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        Text(if (policy == GroupPolicy.FIRST.name) localized("TunnelDialogs.cb09838572e2", "Первый доступный туннель по порядку ниже. Подними предпочтительный выше.")
            else localized("TunnelDialogs.b38d636a45c4", "Выбор среди доступных по измеренной задержке; порядок задаёт предпочтение при равных результатах."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
        if (members.isNotEmpty()) {
            SectionHeading(localized("TunnelDialogs.1818f557a24b", "В группе · {arg1}", members.size))
            LazyColumn(Modifier.testTag("group-members").fillMaxWidth().heightIn(max = 280.dp)) {
            items(members.size, key = { members[it] }, contentType = { "member" }) { index ->
                val member = members[index]
                val memberName = names[member] ?: localized("TunnelDialogs.24260ac4f37e", "Недоступный путь")
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(localized("TunnelDialogs.a94c47d5b83b", "{arg1}", index + 1), Modifier.width(28.dp), color = WaarpMuted)
                    Text(memberName, Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = { members = members.toMutableList().apply { add(index - 1, removeAt(index)) }.toList() }, enabled = index > 0 && !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.ArrowUpward, localized("TunnelDialogs.4d7acc65c22d", "Поднять {arg1}", memberName)) }
                    IconButton(onClick = { members = members.toMutableList().apply { add(index + 1, removeAt(index)) }.toList() }, enabled = index < members.lastIndex && !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.ArrowDownward, localized("TunnelDialogs.7e486c9cd345", "Опустить {arg1}", memberName)) }
                    IconButton(onClick = { members = members - member }, enabled = !operation.busy, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.DeleteOutline, localized("TunnelDialogs.69c318c6a34b", "Убрать {arg1} из группы", memberName)) }
                }
            }
            }
        }
        SearchField(query, { query = it }, localized("TunnelDialogs.e0a38f229cdc", "Добавить туннели в группу"))
        if (candidates.isEmpty()) Text(localized("TunnelDialogs.f55d85af4096", "Доступных туннелей не найдено. Сначала добавь или восстанови профиль."), color = WaarpMuted)
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
        if (hasPublic) InlineMessage(localized("TunnelDialogs.ed5f27102ea1", "Группа содержит публичный сервер. Назначай её только маршрутам, для которых доверяешь этим владельцам."))
        OperationFeedback(operation)
        ActionButton(localized("TunnelDialogs.c7e3d3760c99", "Сохранить группу"), operation.busy, name.isNotBlank() && members.isNotEmpty(),
            onClick = { operation.submit({ actions.saveGroup(GroupDraft(id, name.trim(), GroupPolicy.valueOf(policy), members)) }) }, modifier = Modifier.fillMaxWidth())
        if (existing != null) TextButton(onClick = onDelete, enabled = !operation.busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Icon(Icons.Outlined.DeleteOutline, null); Spacer(Modifier.width(8.dp)); Text(localized("TunnelDialogs.dae519c58d36", "Удалить группу")) }
    }
}

@Composable
private fun AutoDetailsSheet(state: MobileState, onDismiss: () -> Unit) {
    val automatic = state.groups.find { it.id == AUTO_PATH }
    val eligible = remember(state.profiles) { state.profiles.filter { it.source != ProfileSource.PUBLIC && !it.revoked && !it.subscriptionMissing } }
    FormSheet(localized("TunnelDialogs.320d5bc2c6f5", "Автоматический путь"), false, onDismiss) {
        Text(localized("TunnelDialogs.2bf0856d1919", "Авто выбирает рабочий путь из собственных туннелей. Публичные, отозванные и пропавшие из подписки профили исключены."), color = WaarpMuted)
        Text(localized("TunnelDialogs.b5d622bdf73c", "Переключение опирается на проверки доступности; небольшое изменение задержки не должно вызывать постоянную смену сервера."), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
        automatic?.selectedMemberId?.let { KeyValue(localized("TunnelDialogs.89a9b3620744", "Сейчас выбран"), pathName(state, it)) }
        state.status.autoPoolTotal?.let { KeyValue(localized("TunnelDialogs.c722175f3043", "Рабочий пул"), localized("TunnelDialogs.8cdaef56543e", "{arg1} из {arg2}", state.status.autoPoolLive ?: 0, it)) }
        SectionHeading(localized("TunnelDialogs.5fbda6db22a8", "Подходящие туннели"), localized("TunnelDialogs.d4379bc0d146", "{arg1} профилей", eligible.size))
        if (eligible.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
        items(eligible, key = { it.id }, contentType = { "eligible" }) { profile ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(profile.name, Modifier.weight(1f)); HealthLabel(profile.health, profile.latencyMs)
            }
        }
        }
        if (eligible.isEmpty()) InlineMessage(localized("TunnelDialogs.869c20db58e7", "Добавь собственный туннель, чтобы использовать Авто."))
        InlineMessage(localized("TunnelDialogs.9c804bf221b6", "Когда доступных путей нет, назначенные на Авто соединения блокируются. Прямой путь выбирается отдельно."))
        Button(onClick = onDismiss, Modifier.fillMaxWidth().height(50.dp)) { Text(localized("TunnelDialogs.d3995388b34d", "Понятно")) }
    }
}

@Composable
internal fun PendingRemovalSheet(operation: UiOperation, onDismiss: () -> Unit) {
    when {
        operation.completions > 0 -> Unit // The retained completion closes the current form.
        operation.busy || operation.error != null -> FormSheet(localized("TunnelDialogs.659c07e0ac42", "Применяем изменения"), operation.busy, onDismiss) {
            if (operation.busy) {
                CircularProgressIndicator(Modifier.size(28.dp))
                Text(localized("TunnelDialogs.05a1f0172263", "Дожидаемся завершения сохранения и применения настроек VPN."), color = WaarpMuted)
            }
            OperationFeedback(operation)
            if (!operation.busy) Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text(localized("TunnelDialogs.86362a8c73ce", "Закрыть")) }
        }
        else -> MissingItemSheet(onDismiss)
    }
}
