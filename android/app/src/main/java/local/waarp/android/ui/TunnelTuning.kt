package local.waarp.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

/** A small opt-in panel in the existing tunnel sheet, not another settings screen. */
@Composable
internal fun TunnelTuningControls(profile: TunnelUi, state: MobileState, actions: MobileActions) {
    var expanded by rememberSaveable(profile.id) { mutableStateOf(false) }
    var selected by rememberSaveable(profile.id) { mutableStateOf<String?>(null) }
    val operation = rememberUiOperation()
    val result = state.tuning?.takeIf { it.profileId == profile.id }
    val running = result?.running == true
    val options = result?.variants?.takeIf { it.isNotEmpty() } ?: profile.tuneOptions
    val busy = operation.busy || running
    LaunchedEffect(result?.checkedAt, result?.selectedVariantId) { if (selected == null) selected = result?.selectedVariantId }

    OutlinedButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) {
        Text(if (expanded) "Скрыть параметры подключения" else "Подобрать рабочий вариант")
    }
    if (!expanded) return
    profile.tuneLabel?.let { Text("Сохранён вариант: $it", style = MaterialTheme.typography.bodySmall) }
    Text("Проверяем несколько совместимых настроек. Сервер, ключи и проверка его подлинности сохраняются. Исходник можно вернуть.",
        style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
    if (state.status.requestedOpen || state.status.phase != ConnectionPhase.OFF) {
        Text("Отключи VPN перед проверкой: один профиль не должен работать в двух экземплярах одновременно.",
            style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
    }
    options.forEach { option ->
        val eligible = !busy && result?.canApply == true && option.id != "original" && option.result == ObservationResult.OK
        Row(Modifier.fillMaxWidth().selectable(selected == option.id, enabled = eligible, role = Role.RadioButton,
            onClick = { selected = option.id }).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected == option.id, onClick = null, enabled = eligible)
            Column(Modifier.weight(1f)) {
                Text(option.label, style = MaterialTheme.typography.bodyMedium)
                Text(option.detail, style = MaterialTheme.typography.bodySmall, color = WaarpMuted)
                Text(when (option.result) {
                    ObservationResult.OK -> "Ответ получен${option.latencyMs?.let { " · ${it.toInt()} мс" }.orEmpty()}"
                    ObservationResult.FAILED -> "Проверка не прошла"
                    ObservationResult.SKIPPED -> "Не проверялся"
                    ObservationResult.UNKNOWN -> if (running) "Ожидает проверки" else "Пока не проверен"
                }, style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
            }
        }
    }
    result?.checkedAt?.let { at -> Text("Проверено: ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(at))}${result.networkLabel.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()}",
        style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
    result?.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = WaarpMuted) }
    OperationFeedback(operation)
    if (running) OutlinedButton(onClick = actions::cancelTuning, modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text("Остановить проверку") }
    else ActionButton("Проверить варианты", operation.busy,
        enabled = profile.canTune && !state.status.requestedOpen && state.status.phase == ConnectionPhase.OFF,
        onClick = { selected = null; operation.run { actions.runTuning(profile.id) } }, modifier = Modifier.fillMaxWidth())
    val chosen = selected?.takeIf { id -> options.any { it.id == id && it.result == ObservationResult.OK && it.id != "original" } }
        ?: result?.selectedVariantId?.takeIf { it != "original" }
    if (result != null) ActionButton("Применить выбранный вариант", busy,
        enabled = result.canApply && chosen != null, onClick = { chosen?.let { id -> operation.run { actions.applyTuning(profile.id, id) } } }, modifier = Modifier.fillMaxWidth())
    if (profile.tuneLabel != null) OutlinedButton(onClick = { operation.run { actions.resetTuning(profile.id) } }, enabled = !busy,
        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp)) { Text("Вернуть исходную конфигурацию") }
}
