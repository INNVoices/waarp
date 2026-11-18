package local.waarp.android.ui

import androidx.compose.foundation.layout.*
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
import local.waarp.android.data.ConnectionQuality
import local.waarp.android.data.ConnectionUses
import java.text.DateFormat
import java.util.Date

/** A read-only substep of RouteEditorSheet. Selecting returns a draft; only its existing Save writes. */
@Composable
internal fun RouteConnectionCheck(state: MobileState, actions: MobileActions, draft: RouteDraft,
    contextId: String, target: String, onTarget: (String) -> Unit, onBack: () -> Unit,
    onSelect: (String, String) -> Unit) {
    val operation = rememberUiOperation()
    val result = state.diagnostic?.takeIf { it.contextId == contextId }
    var selected by rememberSaveable(contextId) { mutableStateOf<String?>(null) }
    val normalizedTarget = target.trim().let { if (it.contains("://")) it else "https://$it" }
    val targetMatches = result?.target == normalizedTarget
    val canChoose = result != null && !result.running && !result.cancelled && !result.stale &&
        result.proofId != null && targetMatches
    LaunchedEffect(result?.proofId) { selected = result?.suggestedViaId }
    TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) { Text("Назад к маршруту") }
    Text(draft.name.ifBlank { "Выбранный маршрут" }, fontWeight = FontWeight.SemiBold)
    Text(ConnectionUses.label(draft.connectionUse), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
    Text("Сравним сохранённые подключения к выбранному HTTPS-адресу. Текущий маршрут продолжит работать.",
        color = WaarpMuted, style = MaterialTheme.typography.bodyMedium)
    OutlinedTextField(target, { selected = null; onTarget(it) }, Modifier.fillMaxWidth(),
        enabled = !operation.busy && result?.running != true, singleLine = true,
        label = { Text("Адрес для проверки") }, placeholder = { Text("example.com") })
    Text(ConnectionUses.coverage(draft.connectionUse), color = WaarpMuted, style = MaterialTheme.typography.bodySmall)
    if (result?.running == true) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        Text(if (result.plannedChecks > 0) "Проверено ${result.completedChecks} из ${result.plannedChecks}" else "Подготавливаем проверку…",
            style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = { actions.cancelDiagnostic(contextId) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Отменить проверку") }
    } else ActionButton(if (result == null) "Проверить" else "Повторить", operation.busy,
        enabled = target.isNotBlank(), onClick = { operation.run { actions.diagnoseRoute(RouteCheckRequest(contextId, draft, target.trim())) } },
        modifier = Modifier.fillMaxWidth())
    OperationFeedback(operation)
    if (result != null) {
        if (result.stale || !targetMatches) InlineMessage(if (!targetMatches) "Адрес изменён. Выполните проверку для нового адреса." else "Сеть или настройки изменились. Результат сохранён для просмотра; выбор по нему недоступен.")
        result.checkedAt?.let { at -> Text(listOfNotNull(result.networkLabel, DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall, color = WaarpMuted) }
        result.conclusion?.let { InlineMessage(it) }
        result.paths.forEach { path ->
            val allowed = canChoose && path.attempted >= ConnectionQuality.ROUNDS && path.responded == path.attempted
            Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).selectable(selected == path.id, allowed, Role.RadioButton) { selected = path.id }
                .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                RadioButton(selected == path.id, onClick = null, enabled = allowed)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(path.name, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(httpCheckSummary(path), style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                    if (path.id == result.suggestedViaId) Text("Ответил в обеих проверках", style = MaterialTheme.typography.labelSmall, color = WaarpOrange)
                }
                path.latencyMs?.let { Text("${formatMs(it)} мс", style = MaterialTheme.typography.labelMedium) }
            }
        }
        val selectedPath = result.paths.find { it.id == selected && it.attempted >= ConnectionQuality.ROUNDS && it.responded == it.attempted }
        if (result.paths.isNotEmpty()) ActionButton("Выбрать путь", busy = false, enabled = canChoose && selectedPath != null,
            onClick = { val proof = result.proofId; if (proof != null && selectedPath != null) onSelect(selectedPath.id, proof) }, modifier = Modifier.fillMaxWidth())
    }
}

internal fun httpCheckSummary(path: DiagnosticPathUi): String = when {
    path.attempted == 0 -> "HTTPS ещё не проверен"
    path.responded == 0 -> "Нет ответа в ${path.attempted} HTTPS-проверках"
    else -> "HTTPS: ${path.responded} из ${path.attempted} ответов" +
        (path.spreadMs?.let { " · разброс ${it} мс" } ?: "")
}
