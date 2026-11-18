package local.waarp.android.ui

import local.waarp.android.i18n.localized

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Browsing and selection are draft-only; the parent owns the single Save action. */
@Composable
internal fun RoutePathPicker(state: MobileState, selectedPath: String, onBack: () -> Unit, onSelect: (String) -> Unit) {
    var map by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var country by rememberSaveable { mutableStateOf("") }
    var preview by rememberSaveable { mutableStateOf(selectedPath) }
    val available = remember(state.profiles) { state.profiles.filter { !it.revoked && !it.subscriptionMissing } }
    val searched = remember(available, query) { available.filter { it.name.contains(query, true) || it.host.contains(query, true) || it.protocol.contains(query, true) } }
    val filtered = remember(searched, country) { searched.filter { country.isBlank() || atlasCountry(it.country) == country || country == ATLAS_UNKNOWN && atlasCountry(it.country).isBlank() } }
    TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text(localized("RoutePathPicker.4be8489d2de8", "Назад к маршруту")) }
    Text(localized("RoutePathPicker.533fccc6d2dc", "Сохранённые подключения"), fontWeight = FontWeight.SemiBold)
    SearchField(query, { query = it }, localized("RoutePathPicker.c6afe9e8e60b", "Название или сервер"))
    AtlasViewChoice(map) { map = it }
    if (map) AtlasMap(searched.map { AtlasNode(it.id, it.country, it.health == TunnelHealth.OK) }, country, { country = it },
        selectedCountry = state.profiles.find { it.id == selectedPath }?.country)
    else if (country.isNotBlank()) TextButton(onClick = { country = "" }) { Text(localized("RoutePathPicker.67c9e32ed4f2", "Сбросить фильтр региона")) }
    if (filtered.isEmpty()) Text(if (available.isEmpty()) localized("RoutePathPicker.ac55a0950ad7", "Сначала добавьте подключение в Туннелях.") else localized("RoutePathPicker.7a82f6246579", "Нет подключений по выбранному фильтру."),
        style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 260.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(filtered, key = { it.id }, contentType = { "path-choice" }) { profile ->
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).selectable(preview == profile.id, role = Role.RadioButton) { preview = profile.id }
                .padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(preview == profile.id, onClick = null)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(profile.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(profile.protocol, profile.country?.takeIf { it.isNotBlank() }).joinToString(" · "), color = WaarpMuted, style = MaterialTheme.typography.labelSmall)
                    HealthLabel(profile.health, profile.latencyMs)
                    if (profile.id == selectedPath) Text(localized("RoutePathPicker.4d5849397c33", "Выбран в форме"), style = MaterialTheme.typography.labelSmall, color = WaarpOrange)
                }
            }
        }
    }
    val candidate = filtered.find { it.id == preview }
    ActionButton(localized("RoutePathPicker.d40145a6d16f", "Выбрать"), false, enabled = candidate != null,
        onClick = { candidate?.let { onSelect(it.id) } }, modifier = Modifier.fillMaxWidth())
    Text(localized("RoutePathPicker.effdb11fdbfd", "Выбор вернёт в форму. Маршрут изменится после сохранения."), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
}
