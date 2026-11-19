@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package local.waarp.android.ui

import local.waarp.android.i18n.localized

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
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.Hyphens
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.viewmodel.compose.viewModel
import java.util.UUID
import kotlinx.coroutines.launch

internal val LocalDeveloperMode = compositionLocalOf { false }

private data class Destination(val title: String, val icon: ImageVector)


/** Screen tree with local UI preferences. The application owns profiles, VPN consent and network work. */
@Composable
fun WaarpApp(state: MobileState, actions: MobileActions) {
    WaarpTheme {
        val destinations = listOf(
            Destination(localized("WaarpApp.fef7ea07bd57", "Главная"), Icons.Outlined.Home),
            Destination(localized("WaarpApp.3ec6e10eaa23", "Маршруты"), Icons.Outlined.Route),
            Destination(localized("WaarpApp.84fa93393029", "Туннели"), Icons.Outlined.Hub),
            Destination(localized("WaarpApp.9541b6ee7a18", "Диагностика"), Icons.Outlined.MonitorHeart),
        )
        val atlasRegion = rememberAtlasRegion()
        val context = androidx.compose.ui.platform.LocalContext.current.applicationContext
        val prefs = remember(context) { context.getSharedPreferences("waarp-ui", android.content.Context.MODE_PRIVATE) }
        var developer by remember(prefs) { mutableStateOf(prefs.getBoolean("developer", false)) }
        var tab by rememberSaveable { mutableIntStateOf(0) }
        var settings by rememberSaveable { mutableStateOf(false) }
        var sheet by rememberSaveable { mutableStateOf<String?>(null) }
        var modalId by rememberSaveable { mutableStateOf(UUID.randomUUID().toString()) }
        val modalSessions: ModalSessions = viewModel()
        var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
        var suggestedTarget by rememberSaveable { mutableStateOf<String?>(null) }
        var suggestedVia by rememberSaveable { mutableStateOf<String?>(null) }
        val snackbar = remember { SnackbarHostState() }
        val messageScope = rememberCoroutineScope()
        val announce: (String) -> Unit = { text -> messageScope.launch { snackbar.showSnackbar(text, withDismissAction = true) } }
        val screens = rememberSaveableStateHolder()
        val open: (String, String?) -> Unit = { kind, id -> modalSessions.clear(modalId); modalId = UUID.randomUUID().toString(); sheet = kind; selectedId = id }
        val close: () -> Unit = { modalSessions.clear(modalId); sheet = null; selectedId = null; suggestedTarget = null; suggestedVia = null }

        LaunchedEffect(state.message?.id) {
            state.message?.let {
                snackbar.showSnackbar(it.text, withDismissAction = true,
                    duration = if (it.error) SnackbarDuration.Long else SnackbarDuration.Short)
                actions.dismissMessage(it.id)
            }
        }
        BackHandler(enabled = settings && sheet == null) { settings = false }
        BackHandler(enabled = !settings && tab != 0 && sheet == null) { tab = 0 }

        CompositionLocalProvider(LocalOperationMessage provides announce, LocalOperationSnackbar provides snackbar,
            LocalAtlasRegion provides atlasRegion, LocalDeveloperMode provides developer) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val wide = maxWidth >= 840.dp
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {
                            Text(if (settings) localized("WaarpApp.95c82a2a32f0", "Настройки") else if (tab == 0) "waarp" else destinations[tab].title,
                                maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                        },
                        navigationIcon = { if (settings) IconButton(onClick = { settings = false }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, localized("WaarpApp.a0d610dcc37c", "Назад")) } },
                        actions = {
                            val progress = state.backgroundTask
                                ?: localized("WaarpApp.d769079b2d81", "Подбираем параметры подключения…").takeIf { state.tuning?.running == true }
                                ?: localized("WaarpApp.89e7e82dbcb3", "Проверяем передачу данных…").takeIf { state.transfer?.running == true }
                                ?: localized("WaarpApp.c5f201f4557c", "Применяем изменения маршрутов…").takeIf { state.status.recovering }
                            if (progress != null) IconButton(onClick = { announce(progress) }) {
                                CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = progress }, strokeWidth = 2.dp)
                            }
                            if (!settings) IconButton(onClick = { settings = true }) { Icon(Icons.Outlined.Settings, localized("WaarpApp.95c82a2a32f0", "Настройки")) }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                    )
                },
                bottomBar = {
                    if (!wide && !settings) NavigationBar(modifier = Modifier.testTag("waarp-bottom-navigation"), containerColor = MaterialTheme.colorScheme.surface) {
                        destinations.forEachIndexed { index, destination ->
                            NavigationBarItem(selected = index == tab, onClick = { tab = index },
                                icon = { Icon(destination.icon, null) }, label = {
                                    // Keep every label inside its own destination and align icons when
                                    // large text wraps. Material's item grows to the measured label height.
                                    Text(destination.title, Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                                        style = LocalTextStyle.current.copy(lineBreak = LineBreak.Heading,
                                            hyphens = Hyphens.Auto),
                                        minLines = 2, maxLines = 2, textAlign = TextAlign.Center, overflow = TextOverflow.Ellipsis)
                                })
                        }
                    }
                },
                snackbarHost = { if (sheet == null) SnackbarHost(snackbar) },
                floatingActionButton = {
                    if (state.initialized && !settings && (tab == 1 || tab == 2)) {
                        FloatingActionButton(onClick = { open(if (tab == 1) "route" else "import", null) }) {
                            Icon(Icons.Outlined.Add, if (tab == 1) localized("WaarpApp.22b3d2ba6ffa", "Добавить маршрут") else localized("WaarpApp.1c22503d8cba", "Добавить туннель"))
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
                        Column(Modifier.widthIn(max = 1000.dp).fillMaxSize()) {
                            if (state.initialized && (settings || tab != 0)) {
                                if (state.status.phase == ConnectionPhase.ERROR) InlineMessage(
                                    state.status.error ?: localized("WaarpApp.2f90a56412fc", "VPN остановился с ошибкой. Открой главную для восстановления."), error = true,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                            }
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                            screens.SaveableStateProvider(if (!state.initialized) "loading" else if (settings) "settings" else "tab-$tab") {
                            when {
                                !state.initialized -> LoadingState(state, actions)
                                settings -> SettingsScreen(state, actions) { enabled ->
                                    developer = enabled
                                    prefs.edit().putBoolean("developer", enabled).apply()
                                }
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
            }
        }
        if (sheet != null) key(modalId) {
            CompositionLocalProvider(LocalModalSession provides modalSessions.obtain(modalId)) {
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
            Text(localized("WaarpApp.089d96260bc8", "Открываем профили и маршруты…"), style = MaterialTheme.typography.bodyLarge)
        } else {
            InlineMessage(state.error, error = true)
            Spacer(Modifier.height(16.dp))
            ActionButton(localized("WaarpApp.1f130f7941f7", "Повторить"), operation.busy, onClick = { operation.run({ actions.refresh() }) })
            OperationFeedback(operation)
        }
    }
}

@Composable
internal fun MissingItemSheet(onDismiss: () -> Unit) {
    FormSheet(localized("WaarpApp.7d3b374dfe48", "Объект больше недоступен"), false, onDismiss) {
        Text(localized("WaarpApp.96b58442d61c", "Список изменился. Закрой окно и выбери актуальный профиль или маршрут."), color = WaarpMuted)
        Button(onClick = onDismiss, Modifier.fillMaxWidth().height(50.dp)) { Text(localized("WaarpApp.3916c6370326", "Закрыть")) }
    }
}
