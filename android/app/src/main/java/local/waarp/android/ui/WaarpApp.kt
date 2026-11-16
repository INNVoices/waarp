@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package local.waarp.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.MonitorHeart
import androidx.compose.material.icons.outlined.Route
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

private data class Destination(val title: String, val icon: ImageVector)
private val destinations = listOf(
    Destination("Главная", Icons.Outlined.Home),
    Destination("Маршруты", Icons.Outlined.Route),
    Destination("Туннели", Icons.Outlined.Hub),
    Destination("Диагностика", Icons.Outlined.MonitorHeart),
)

/** Pure screen tree. The application owns persistence, VPN consent and all network work. */
@Composable
fun WaarpApp(state: MobileState, actions: MobileActions) {
    WaarpTheme {
        var tab by rememberSaveable { mutableIntStateOf(0) }
        var settings by rememberSaveable { mutableStateOf(false) }
        var sheet by rememberSaveable { mutableStateOf<String?>(null) }
        var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
        var suggestedTarget by rememberSaveable { mutableStateOf<String?>(null) }
        var suggestedVia by rememberSaveable { mutableStateOf<String?>(null) }
        val snackbar = remember { SnackbarHostState() }
        val open: (String, String?) -> Unit = { kind, id -> sheet = kind; selectedId = id }
        val close: () -> Unit = { sheet = null; selectedId = null; suggestedTarget = null; suggestedVia = null }

        LaunchedEffect(state.message?.id) {
            state.message?.let {
                snackbar.showSnackbar(it.text, withDismissAction = true,
                    duration = if (it.error) SnackbarDuration.Long else SnackbarDuration.Short)
                actions.dismissMessage(it.id)
            }
        }
        BackHandler(enabled = settings && sheet == null) { settings = false }
        BackHandler(enabled = !settings && tab != 0 && sheet == null) { tab = 0 }

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val wide = maxWidth >= 840.dp
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(if (settings) "Настройки" else if (tab == 0) "waarp" else destinations[tab].title,
                                    fontWeight = FontWeight.SemiBold)
                                if (!settings && tab == 0) Text("ANDROID", style = MaterialTheme.typography.labelSmall, color = WaarpMuted)
                            }
                        },
                        navigationIcon = { if (settings) IconButton(onClick = { settings = false }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Назад") } },
                        actions = { if (!settings) IconButton(onClick = { settings = true }) { Icon(Icons.Outlined.Settings, "Настройки") } },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                    )
                },
                bottomBar = {
                    if (!wide && !settings) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        destinations.forEachIndexed { index, destination ->
                            NavigationBarItem(selected = index == tab, onClick = { tab = index },
                                icon = { Icon(destination.icon, null) }, label = { Text(destination.title, maxLines = 1) })
                        }
                    }
                },
                snackbarHost = { SnackbarHost(snackbar) },
                floatingActionButton = {
                    if (state.initialized && !settings && (tab == 1 || tab == 2)) {
                        FloatingActionButton(onClick = { open(if (tab == 1) "route" else "import", null) }) {
                            Icon(Icons.Outlined.Add, if (tab == 1) "Добавить маршрут" else "Добавить туннель")
                        }
                    }
                },
            ) { insets ->
                Row(Modifier.fillMaxSize().padding(insets)) {
                    if (wide && !settings) NavigationRail(containerColor = MaterialTheme.colorScheme.background) {
                        Spacer(Modifier.height(16.dp))
                        destinations.forEachIndexed { index, destination ->
                            NavigationRailItem(selected = index == tab, onClick = { tab = index },
                                icon = { Icon(destination.icon, null) }, label = { Text(destination.title) },
                                modifier = Modifier.padding(vertical = 8.dp))
                        }
                    }
                    Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                        Box(Modifier.widthIn(max = 1000.dp).fillMaxSize()) {
                            when {
                                !state.initialized -> LoadingState(state, actions)
                                settings -> SettingsScreen(state, actions)
                                tab == 0 -> HomeScreen(state, actions,
                                    onRoutes = { tab = 1 }, onAddTunnel = { open("import", null) },
                                    onWholeDevice = { open("whole", null) })
                                tab == 1 -> RoutesScreen(state, actions, onEdit = { open("route", it) }, onAdd = { open("route", null) })
                                tab == 2 -> TunnelsScreen(state, actions,
                                    onTunnel = { open("tunnel", it) }, onGroup = { open("group", it) },
                                    onAddGroup = { open("group", null) }, onImport = { open("import", null) })
                                else -> DiagnosticsScreen(state, actions, onCreateRoute = { target, via ->
                                    suggestedTarget = target; suggestedVia = via; open("route", null)
                                })
                            }
                        }
                    }
                }
            }
        }
        key(sheet, selectedId) {
            when (sheet) {
                "whole" -> WholeDeviceSheet(state, actions, close)
                "route" -> RouteEditorSheet(state, actions, selectedId, suggestedTarget, suggestedVia, close)
                "import" -> ImportSheet(actions, close, state.message)
                "group" -> GroupEditorSheet(state, actions, selectedId, close, { open("deleteGroup", selectedId) })
                "deleteGroup" -> DeletePathSheet(state, actions, selectedId, group = true, onDismiss = close)
                "tunnel" -> state.profiles.find { it.id == selectedId }?.let { profile ->
                    TunnelDetailsSheet(profile, state, actions, close,
                        onRename = { open("rename", profile.id) }, onReplace = { open("replace", profile.id) },
                        onDelete = { open("deleteTunnel", profile.id) })
                } ?: MissingItemSheet(close)
                "rename" -> state.profiles.find { it.id == selectedId }?.let { RenameTunnelSheet(it, actions, close) } ?: MissingItemSheet(close)
                "replace" -> state.profiles.find { it.id == selectedId }?.let { ReplaceTunnelSheet(it, actions, close, state.message) } ?: MissingItemSheet(close)
                "deleteTunnel" -> DeletePathSheet(state, actions, selectedId, group = false, onDismiss = close)
            }
        }
    }
}

@Composable
private fun LoadingState(state: MobileState, actions: MobileActions) {
    val operation = rememberUiOperation()
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally) {
        if (state.error == null) {
            CircularProgressIndicator()
            Spacer(Modifier.height(20.dp))
            Text("Открываем профили и маршруты…", style = MaterialTheme.typography.bodyLarge)
        } else {
            InlineMessage(state.error, error = true)
            Spacer(Modifier.height(16.dp))
            ActionButton("Повторить", operation.busy, onClick = { operation.run({ actions.refresh() }) })
            OperationFeedback(operation)
        }
    }
}

@Composable
internal fun MissingItemSheet(onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Объект больше недоступен", style = MaterialTheme.typography.titleLarge)
            Text("Список изменился. Закрой окно и выбери актуальный профиль или маршрут.", color = WaarpMuted)
            Button(onClick = onDismiss, Modifier.fillMaxWidth().height(50.dp)) { Text("Закрыть") }
        }
    }
}
