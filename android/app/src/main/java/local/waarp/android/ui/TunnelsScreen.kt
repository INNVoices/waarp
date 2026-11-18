@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package local.waarp.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Groups
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

@Composable
internal fun TunnelsScreen(state: MobileState, actions: MobileActions, onTunnel: (String) -> Unit, onGroup: (String) -> Unit,
    onAddGroup: () -> Unit, onImport: () -> Unit) {
    var section by rememberSaveable { mutableStateOf("profiles") }
    val screens = rememberSaveableStateHolder()
    val names = rememberPathNames(state)
    val operation = rememberUiOperation()
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("profiles" to "Добавленные", "groups" to "Группы", "public" to "Публичные").forEach { (key, label) ->
                FilterChip(section == key, onClick = { section = key }, label = { Text(label) }, modifier = Modifier.heightIn(min = 48.dp))
            }
        }
        screens.SaveableStateProvider(section) {
        var query by rememberSaveable { mutableStateOf("") }
        var map by rememberSaveable { mutableStateOf(false) }
        var country by rememberSaveable { mutableStateOf("") }
        val filteredProfiles = remember(state.profiles, query) { state.profiles.filter { p ->
            p.name.contains(query, true) || p.protocol.contains(query, true) || p.host.contains(query, true) } }
        val filteredGroups = remember(state.groups, query) { state.groups.filter { it.id != AUTO_PATH && it.name.contains(query, true) } }
        if (section == "public") {
            PublicCatalog(state, actions)
        } else LazyColumn(
            // Move the existing FAB clearance outside the scrolling viewport in map mode.
            // End padding alone lets the region controls scroll underneath the floating action.
            Modifier.fillMaxSize().padding(bottom = if (section == "profiles" && map) 80.dp else 0.dp),
            contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, if (section == "profiles" && map) 24.dp else 104.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { SearchField(query, { query = it }, if (section == "profiles") "Название, протокол или сервер" else "Найти группу") }
            item {
                SectionHeading(if (section == "profiles") "${state.profiles.size} туннелей" else "Группы и Авто", trailing = {
                    if (section == "profiles") TextButton(onClick = { operation.run({ actions.probeTunnels() }) }, enabled = !operation.busy && state.profiles.isNotEmpty(), modifier = Modifier.heightIn(min = 48.dp)) {
                        if (operation.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp)); Text("Проверить")
                    } else TextButton(onClick = onAddGroup, Modifier.heightIn(min = 48.dp)) { Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Группа") }
                })
                OperationFeedback(operation)
            }
            if (section == "profiles") item {
                AtlasViewChoice(map) { map = it }
                if (map) AtlasMap(filteredProfiles.map { AtlasNode(it.id, it.country, it.health == TunnelHealth.OK) }, country, { country = it })
                else if (country.isNotBlank()) TextButton(onClick = { country = "" }) { Text("Сбросить фильтр региона") }
            }
            if (section == "profiles") {
                val filtered = filteredProfiles.filter { country.isBlank() || atlasCountry(it.country) == country || country == ATLAS_UNKNOWN && atlasCountry(it.country).isBlank() }
                if (filtered.isEmpty()) item {
                    EmptyState(Icons.Outlined.Hub, if (state.profiles.isEmpty()) "Добавь первый туннель" else "Ничего не найдено",
                        if (state.profiles.isEmpty()) "Ссылка, конфигурация, QR-код или подписка. Туннели появятся здесь после успешного импорта." else "Попробуй название сервера или протокол.") {
                        if (state.profiles.isEmpty()) Button(onClick = onImport, modifier = Modifier.heightIn(min = 48.dp)) { Text("Импортировать") }
                    }
                }
                items(filtered, key = { it.id }, contentType = { "tunnel" }) { profile ->
                    Panel {
                        Row(Modifier.fillMaxWidth().clickable { onTunnel(profile.id) }.heightIn(min = 64.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Hub, null, tint = WaarpOrange, modifier = Modifier.size(28.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(profile.name, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(listOfNotNull(profile.protocol, profile.country, profile.host.takeIf { it.isNotBlank() }).joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { HealthLabel(profile.health, profile.latencyMs); SourceBadge(profile.source) }
                            }
                            Icon(Icons.Outlined.ChevronRight, "Открыть туннель")
                        }
                        if (profile.revoked) InlineMessage("Профиль отозван. Назначенные ему маршруты заблокированы до замены пути.", error = true)
                        else if (profile.subscriptionMissing) InlineMessage("Сервер пропал из подписки. Обнови подписку или выбери другой путь.", error = true)
                        else if (profile.subscription) Text("Из подписки · обновление в карточке туннеля", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                    }
                }
                if (state.profiles.isNotEmpty()) item {
                    Text("Проверка измеряет доступность пути в момент запроса. «Не проверен» не означает ошибку.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                }
            } else {
                val own = state.profiles.count { it.source != ProfileSource.PUBLIC && !it.revoked && !it.subscriptionMissing }
                if (query.isBlank() || "Авто".contains(query, true)) item {
                    val automatic = state.groups.find { it.id == AUTO_PATH }
                    Panel {
                        Row(Modifier.fillMaxWidth().clickable { onGroup(AUTO_PATH) }.heightIn(min = 64.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.AutoAwesome, null, tint = WaarpOrange)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Авто", fontWeight = FontWeight.SemiBold)
                                Text("Свои туннели · $own", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                                automatic?.let { HealthLabel(it.health, it.latencyMs) }
                            }
                            Icon(Icons.Outlined.ChevronRight, "Как работает Авто")
                        }
                        Text("Проверяет рабочий пул и меняет путь при необходимости. Публичные серверы сюда не попадают.", color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
                val groups = filteredGroups
                items(groups, key = { it.id }, contentType = { "group" }) { group ->
                    Panel {
                        Row(Modifier.fillMaxWidth().clickable { onGroup(group.id) }.heightIn(min = 64.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Groups, null, tint = WaarpOrange)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(group.name, fontWeight = FontWeight.SemiBold)
                                Text("${group.members.size} туннелей · ${policyLabel(group.policy)}", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                                HealthLabel(group.health, group.latencyMs)
                            }
                            Icon(Icons.Outlined.ChevronRight, "Изменить группу")
                        }
                        group.selectedMemberId?.let { Text("Сейчас: ${names[it] ?: "Недоступный путь"}", style = MaterialTheme.typography.bodySmall) }
                        Text(group.members.take(4).joinToString(" · ") { names[it] ?: "Недоступный путь" } + if (group.members.size > 4) " · ещё ${group.members.size - 4}" else "",
                            style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                    }
                }
                if (groups.isEmpty()) item {
                    EmptyState(Icons.Outlined.Groups, if (query.isBlank()) "Собери свою группу" else "Группы не найдены",
                        "Объедини туннели и выбери: самый быстрый или первый доступный в заданном порядке.") {
                        Button(onClick = onAddGroup, modifier = Modifier.heightIn(min = 48.dp)) { Text("Создать группу") }
                    }
                }
            }
        }
        }
    }
}

@Composable
private fun PublicCatalog(state: MobileState, actions: MobileActions) {
    var query by rememberSaveable { mutableStateOf("") }
    var country by rememberSaveable { mutableStateOf("") }
    var protocol by rememberSaveable { mutableStateOf("") }
    var onlyChecked by rememberSaveable { mutableStateOf(false) }
    var sourcesExpanded by rememberSaveable { mutableStateOf(false) }
    var map by rememberSaveable { mutableStateOf(false) }
    val operation = rememberUiOperation()
    val catalog = state.catalog
    val countries = remember(catalog.nodes) { catalog.nodes.map { it.country }.filter { it.isNotBlank() }.distinct().sorted() }
    val protocols = remember(catalog.nodes) { catalog.nodes.map { it.protocol }.distinct().sorted() }
    LaunchedEffect(countries, protocols) {
        if (country.isNotEmpty() && country !in countries) country = ""
        if (protocol.isNotEmpty() && protocol !in protocols) protocol = ""
    }
    val sortedNodes = remember(catalog.nodes) {
        catalog.nodes.sortedWith(compareBy<PublicNodeUi> { validLatency(it.latencyMs) == null }.thenBy { validLatency(it.latencyMs) ?: Double.MAX_VALUE })
    }
    val nodes = remember(sortedNodes, query, country, protocol, onlyChecked) {
        sortedNodes.filter { node -> (country.isBlank() || node.country == country) && (protocol.isBlank() || node.protocol == protocol) &&
            (!onlyChecked || node.health == TunnelHealth.OK) &&
            (node.name.contains(query, true) || node.host.contains(query, true) || node.country.contains(query, true)) }
    }
    LazyColumn(Modifier.fillMaxSize().padding(bottom = if (map) 80.dp else 0.dp),
        contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, if (map) 24.dp else 104.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { InlineMessage("Публичные серверы принадлежат третьим лицам. Добавление сохраняет туннель, но не меняет маршруты. Используй их только там, где доверяешь владельцу.") }
        item {
            Panel {
                SectionHeading("Каталог серверов", catalog.updatedAtMillis?.let { "Обновлён ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(it))}" } ?: "Ещё не загружен")
                if (catalog.busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(if (catalog.planned > 0) "Проверено ${catalog.checked} из ${catalog.planned}" else "Получаем источники…", style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                }
                ActionButton(if (catalog.nodes.isEmpty()) "Загрузить каталог" else "Обновить каталог", operation.busy || catalog.busy,
                    enabled = catalog.canRefresh, onClick = { operation.run({ actions.refreshCatalog() }) }, modifier = Modifier.fillMaxWidth())
                if (!catalog.canRefresh && !catalog.busy) Text("Обновление сейчас недоступно. Выключи VPN и повтори запрос.", color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
                catalog.error?.let { InlineMessage(it, error = true) }
                OperationFeedback(operation)
                if (catalog.sources.isNotEmpty()) {
                    TextButton(onClick = { sourcesExpanded = !sourcesExpanded }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text("Источники: ${catalog.sources.count { it.ok }} из ${catalog.sources.size} доступны", Modifier.weight(1f)); Icon(Icons.Outlined.ChevronRight, null)
                    }
                    if (sourcesExpanded) catalog.sources.forEach { source ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text("${source.name} · ${source.count}", style = MaterialTheme.typography.bodySmall)
                            if (!source.ok) Text(source.error ?: "Источник недоступен", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
        if (catalog.nodes.isNotEmpty()) {
            item { SearchField(query, { query = it }, "Найти публичный сервер") }
            item {
                AtlasViewChoice(map) { map = it }
                if (map) AtlasMap(sortedNodes.filter { node -> (protocol.isBlank() || node.protocol == protocol) &&
                    (!onlyChecked || node.health == TunnelHealth.OK) && (node.name.contains(query, true) || node.host.contains(query, true) || node.country.contains(query, true)) }
                    .map { AtlasNode(it.id, it.country, it.health == TunnelHealth.OK) }, country, { country = it }, showRegionSelector = false)
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { PathField("Страна", country, listOf(PathChoice("", "Все страны", "Без фильтра")) + countries.map { PathChoice(it, it, "") }) { country = it } }
                    Box(Modifier.weight(1f)) { PathField("Протокол", protocol, listOf(PathChoice("", "Все протоколы", "Без фильтра")) + protocols.map { PathChoice(it, it, "") }) { protocol = it } }
                }
                BooleanOption("Только прошедшие проверку", value = onlyChecked, modifier = Modifier.fillMaxWidth()) { onlyChecked = it }
            }
            item {
                OutlinedButton(onClick = { operation.run({ actions.addBestPublicGroup() }) }, enabled = !operation.busy && !catalog.busy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Icon(Icons.Outlined.Groups, null); Spacer(Modifier.width(8.dp)); Text("Группа из проверенных") }
                Text("За одну проверку — до 8 серверов. В группу входят до 5 лучших успешных результатов этой выборки; её можно назначить маршруту.", style = MaterialTheme.typography.bodySmall, color = WaarpMuted, modifier = Modifier.padding(top = 8.dp))
            }
            item { Text("Показано ${nodes.size} из ${catalog.nodes.size}", style = MaterialTheme.typography.labelMedium, color = WaarpMuted) }
        }
        items(nodes, key = { it.id }, contentType = { "public-node" }) { node -> PublicNodeCard(node, actions, catalog.busy) }
        if (nodes.isEmpty() && !catalog.busy) item {
            EmptyState(Icons.Outlined.Public, if (catalog.nodes.isEmpty()) "Каталог пуст" else "Серверы не найдены",
                if (catalog.nodes.isEmpty()) "Загрузи каталог. Доступность будет показана по реальной проверке." else "Измени страну, протокол или строку поиска.")
        }
    }
}

@Composable
private fun PublicNodeCard(node: PublicNodeUi, actions: MobileActions, catalogBusy: Boolean) {
    val operation = rememberUiOperation()
    Panel {
        SectionHeading(node.name, listOf(node.protocol, node.country).filter { it.isNotBlank() }.joinToString(" · "))
        Text("${node.host}:${node.port}", style = MaterialTheme.typography.bodySmall, color = WaarpMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                HealthLabel(node.health, node.latencyMs)
                Text(node.sourceLabel, style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            }
            OutlinedButton(onClick = { operation.run({ actions.addCatalogNode(node.id) }) }, enabled = !catalogBusy && !operation.busy && !node.added, modifier = Modifier.heightIn(min = 48.dp)) {
                if (operation.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else Text(if (node.added) "Добавлен" else "Добавить")
            }
        }
        OperationFeedback(operation)
    }
}
