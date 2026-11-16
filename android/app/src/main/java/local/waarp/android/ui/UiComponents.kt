package local.waarp.android.ui

import android.widget.ImageView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class UiOperation(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var message by mutableStateOf<String?>(null)
        private set

    fun clearError() { error = null }

    fun run(work: suspend () -> UiResult, success: () -> Unit = {}) {
        if (busy) return
        busy = true
        error = null
        message = null
        scope.launch {
            try {
                val result = work()
                if (result.ok) {
                    message = result.message
                    success()
                } else error = result.message ?: "Не удалось выполнить действие. Повтори попытку."
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Backend exceptions can include imported credentials. Only its explicit UiResult is displayable.
                error = "Действие не завершилось. Повтори попытку или открой журнал диагностики."
            } finally {
                busy = false
            }
        }
    }
}

@Composable
internal fun rememberUiOperation(): UiOperation {
    val scope = rememberCoroutineScope()
    return remember(scope) { UiOperation(scope) }
}

@Composable
internal fun OperationFeedback(operation: UiOperation) {
    operation.error?.let { InlineMessage(it, error = true) }
    operation.message?.let { InlineMessage(it) }
}

@Composable
internal fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

@Composable
internal fun SectionHeading(title: String, subtitle: String? = null, trailing: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
        }
        trailing?.invoke()
    }
}

@Composable
internal fun InlineMessage(text: String, error: Boolean = false, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            Icon(if (error) Icons.Outlined.ErrorOutline else Icons.Outlined.Info, null, Modifier.size(18.dp),
                tint = if (error) MaterialTheme.colorScheme.onErrorContainer else WaarpMuted)
            Text(text, style = MaterialTheme.typography.bodySmall,
                color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
internal fun EmptyState(icon: ImageVector, title: String, text: String, action: (@Composable () -> Unit)? = null) {
    Panel {
        Icon(icon, null, Modifier.size(30.dp), tint = WaarpOrange)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(text, style = MaterialTheme.typography.bodyMedium, color = WaarpMuted)
        action?.invoke()
    }
}

@Composable
internal fun SearchField(value: String, changed: (String) -> Unit, label: String = "Поиск") {
    OutlinedTextField(value, changed, Modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true,
        leadingIcon = { Icon(Icons.Outlined.Search, null) })
}

@Composable
internal fun KeyValue(label: String, value: String, mono: Boolean = false) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = WaarpMuted)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontFamily = if (mono) FontFamily.Monospace else null)
    }
}

@Composable
internal fun ActionButton(text: String, busy: Boolean, enabled: Boolean = true, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(onClick, modifier = modifier.height(50.dp), enabled = enabled && !busy) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(text)
    }
}

@Composable
internal fun HealthLabel(health: TunnelHealth, latency: Double? = null) {
    val label = when (health) {
        TunnelHealth.OK -> validLatency(latency)?.let { "${formatMs(it)} мс" } ?: "Доступен"
        TunnelHealth.DEGRADED -> "Повторная проверка"
        TunnelHealth.DOWN -> "Не отвечает"
        TunnelHealth.BUSY -> "Ключ занят"
        TunnelHealth.UNKNOWN -> "Не проверен"
    }
    val color = when (health) {
        TunnelHealth.OK -> WaarpGreen
        TunnelHealth.DOWN -> MaterialTheme.colorScheme.error
        TunnelHealth.DEGRADED, TunnelHealth.BUSY -> WaarpWarning
        TunnelHealth.UNKNOWN -> WaarpMuted
    }
    Text(label, color = color, style = MaterialTheme.typography.labelMedium)
}

@Composable
internal fun SourceBadge(source: ProfileSource) {
    when (source) {
        ProfileSource.PUBLIC -> Text("Публичный", color = WaarpWarning, style = MaterialTheme.typography.labelSmall)
        ProfileSource.MANAGED -> Text("Командный", color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.labelSmall)
        ProfileSource.WARP -> Text("WARP", color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.labelSmall)
        ProfileSource.PERSONAL -> Unit
    }
}

@Composable
internal fun AppIcon(app: AppUi?, name: String, modifier: Modifier = Modifier) {
    val drawable = app?.icon
    if (drawable != null) {
        AndroidView(factory = { context -> ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER; importantForAccessibility = ImageView.IMPORTANT_FOR_ACCESSIBILITY_NO } },
            update = { it.setImageDrawable(drawable) }, modifier = modifier.size(36.dp))
    } else {
        Box(modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Text(name.take(1).uppercase(Locale.ROOT), fontWeight = FontWeight.Bold, color = WaarpOrange)
        }
    }
}

internal data class PathChoice(val id: String, val name: String, val detail: String, val enabled: Boolean = true)

internal fun pathChoices(state: MobileState, allowDirect: Boolean = true, excluded: Set<String> = emptySet()): List<PathChoice> {
    val eligible = state.profiles.filter { !it.revoked && !it.subscriptionMissing }.mapTo(HashSet()) { it.id }
    return buildList {
    if (allowDirect) add(PathChoice(DIRECT_PATH, "Напрямую", "Обычное подключение устройства"))
    val own = state.profiles.filter { !it.revoked && !it.subscriptionMissing && it.source != ProfileSource.PUBLIC }
    if (own.isNotEmpty()) add(PathChoice(AUTO_PATH, "Авто", "Только свои туннели · ${own.size}"))
    state.groups.forEach { group ->
        if (group.id != AUTO_PATH) add(PathChoice(group.id, group.name, "Группа · ${group.members.size} · ${policyLabel(group.policy)}", group.members.any(eligible::contains)))
    }
    state.profiles.forEach { profile ->
        val trust = if (profile.source == ProfileSource.PUBLIC) " · публичный" else ""
        val unavailable = when { profile.revoked -> " · отозван"; profile.subscriptionMissing -> " · пропал из подписки"; else -> "" }
        add(PathChoice(profile.id, profile.name, profile.protocol + trust + unavailable, !profile.revoked && !profile.subscriptionMissing))
    }
    }.filterNot { it.id in excluded }
}

internal fun pathName(state: MobileState, id: String?): String = when (id) {
    null -> "Не выбран"
    DIRECT_PATH -> "Напрямую"
    AUTO_PATH -> "Авто"
    else -> state.profiles.find { it.id == id }?.name ?: state.groups.find { it.id == id }?.name ?: "Недоступный путь"
}

@Composable
internal fun PathField(label: String, value: String?, choices: List<PathChoice>, enabled: Boolean = true, selected: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val current = choices.find { it.id == value }
    Box(Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { query = ""; expanded = true }, enabled = enabled, modifier = Modifier.fillMaxWidth().height(64.dp), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                Text(current?.name ?: if (value == null) "Не выбран" else "Недоступный путь", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Outlined.KeyboardArrowDown, null)
        }
    }
    if (expanded) {
        val filtered = remember(choices, query) { choices.filter { it.name.contains(query, true) || it.detail.contains(query, true) } }
        AlertDialog(onDismissRequest = { expanded = false }, title = { Text(label) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (choices.size > 6) SearchField(query, { query = it })
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
                    items(filtered, key = { it.id }) { option ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = option.enabled) { expanded = false; selected(option.id) }
                            .heightIn(min = 56.dp).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(option.name, fontWeight = if (option.id == value) FontWeight.Bold else FontWeight.Normal,
                                    color = if (option.enabled) MaterialTheme.colorScheme.onSurface else WaarpMuted)
                                if (option.detail.isNotBlank()) Text(option.detail, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                            }
                            if (option.id == value) Icon(Icons.Outlined.Check, "Выбрано", tint = WaarpOrange, modifier = Modifier.size(20.dp))
                        }
                    }
                    if (filtered.isEmpty()) item { Text(if (choices.isEmpty()) "Сначала добавь туннель" else "Ничего не найдено", Modifier.padding(vertical = 16.dp), color = WaarpMuted) }
                }
            }
        }, confirmButton = { TextButton(onClick = { expanded = false }) { Text("Закрыть") } })
    }
}

internal fun policyLabel(policy: GroupPolicy) = if (policy == GroupPolicy.FIRST) "Первый доступный" else "Самый быстрый"
internal fun validLatency(value: Double?): Double? = value?.takeIf { it.isFinite() && it >= 0 }
internal fun formatMs(value: Double): String = String.format(Locale.getDefault(), if (value < 10) "%.1f" else "%.0f", value)
internal fun formatBytes(value: Long): String {
    val n = value.coerceAtLeast(0).toDouble()
    return when {
        n >= 1024 * 1024 * 1024 -> String.format(Locale.getDefault(), "%.2f ГБ", n / (1024 * 1024 * 1024))
        n >= 1024 * 1024 -> String.format(Locale.getDefault(), "%.1f МБ", n / (1024 * 1024))
        n >= 1024 -> String.format(Locale.getDefault(), "%.1f КБ", n / 1024)
        else -> "${n.toLong()} Б"
    }
}

internal fun formatDuration(milliseconds: Long): String {
    val seconds = (milliseconds.coerceAtLeast(0) / 1000)
    return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
    else "%02d:%02d".format(seconds / 60, seconds % 60)
}
