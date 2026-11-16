// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.app.Application
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import local.waarp.android.core.RuntimePhase
import local.waarp.android.core.RuntimeLog
import local.waarp.android.data.*
import local.waarp.android.ui.*
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicLong

sealed interface MobileEvent {
    data class Consent(val token: Long, val intent: Intent) : MobileEvent
    data class FileImport(val replaceId: String?) : MobileEvent
    data object QrImport : MobileEvent
    data object ClipboardImport : MobileEvent
    data object SystemVpnSettings : MobileEvent
    data object ShareDiagnostics : MobileEvent
}

class MobileViewModel(application: Application) : AndroidViewModel(application), MobileActions {
    private val app = application as WaarpApplication
    val repository = app.repository
    private val controller = repository.controller
    private val network = app.network
    private val _state = MutableStateFlow(MobileState(appVersion = BuildConfig.VERSION_NAME, engineVersion = BuildConfig.ENGINE_VERSION))
    val state = _state.asStateFlow()
    private val eventsChannel = Channel<MobileEvent>(Channel.BUFFERED)
    val events = eventsChannel.receiveAsFlow()
    private val updates = Channel<Unit>(Channel.CONFLATED)
    private val messageIds = AtomicLong()
    private var apps: List<AppUi> = emptyList()
    private var catalogProfiles: List<TunnelProfile> = emptyList()
    private var catalog = CatalogUi()
    private val catalogHealth = mutableMapOf<String, ProbeHealth>()
    private var diagnostic: DiagnosticUi? = null
    private var message: UiMessage? = null
    private var diagnosticBusy = false
    private var appScanBusy = false
    private var lastLogs: List<RuntimeLog>? = null
    private var lastLogFormat: String? = null
    private var logLines: List<String> = emptyList()
    var pendingConsentToken: Long? = null
        private set
    var pendingConsentIntent: Intent? = null
        private set
    var pendingReplaceId: String? = null

    init {
        viewModelScope.launch { for (ignored in updates) { rebuild(); delay(40) } }
        val streams: List<Flow<*>> = listOf(repository.data, repository.loadError, repository.requestedOpen, repository.applying,
            repository.compiled, repository.health, repository.history, controller.status, controller.groups, controller.connections, controller.logs)
        streams.forEach { stream -> viewModelScope.launch { stream.collect { changed() } } }
        viewModelScope.launch {
            val initialIntent = repository.intentGeneration()
            try {
                repository.ready()
                // No suspension between the current intent/settings gate and connect. App discovery is independent
                // and cannot resurrect an old auto-connect request after the user has already switched OFF.
                if (repository.intentGeneration() == initialIntent && repository.data.value?.settings?.autoConnect == true &&
                    !repository.requestedOpen.value && controller.status.value.phase == RuntimePhase.OFF) connect()
                refreshApps()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { changed() }
        }
    }
    private fun changed() { updates.trySend(Unit) }
    fun notifyUser(text: String, error: Boolean = false) {
        message = UiMessage(messageIds.incrementAndGet(), text.take(500), error); changed()
    }
    override fun dismissMessage(id: Long) { if (message?.id == id) { message = null; changed() } }
    private fun event(event: MobileEvent) { viewModelScope.launch { eventsChannel.send(event) } }
    private fun health(value: ProbeHealth?) = when {
        value == null || value.checkedAt == 0L -> TunnelHealth.UNKNOWN
        value.down -> TunnelHealth.DOWN
        value.healthy -> TunnelHealth.OK
        value.holding -> TunnelHealth.DEGRADED
        else -> TunnelHealth.UNKNOWN
    }
    private fun rebuild() {
        val data = repository.data.value ?: AppData()
        val runtime = controller.status.value
        val measured = repository.health.value
        val nativeByTag = controller.groups.value.associateBy { it.tag }
        val profilesById = data.profiles.associateBy { it.id }
        val groupsById = data.groups.associateBy { it.id }
        val appsByPackage = apps.associateBy { it.packageName }
        fun selected(id: String): String? = nativeByTag["grp-$id"]?.selected?.removePrefix("p-")
        fun pathName(id: String?) = when (id) { DIRECT -> "Напрямую"; AUTO -> "Авто"; null -> "Не выбран";
            else -> profilesById[id]?.name ?: groupsById[id]?.name ?: "Недоступный путь" }
        fun viaHealth(id: String): ProbeHealth? = measured[if (id.startsWith("g-")) selected(id) else id]
        val available = data.profiles.filterNot { it.revoked || it.subscriptionMissing }.map { it.id }.toSet()
        val allGroups = data.groups + TunnelGroup(AUTO, "Авто", "fastest", data.profiles.filter { it.id in available && it.source != "public" }.map { it.id })
        val availableGroups = allGroups.filter { it.members.any(available::contains) }.mapTo(HashSet()) { it.id }
        fun pathAvailable(id: String) = id == DIRECT || id in available || id in availableGroups
        val systemDns = RoutingCompiler.systemDnsPolicy(data)
        val systemDnsHint = systemDns.reason ?: when {
            systemDns.via == DIRECT && data.settings.systemDnsVia == DIRECT -> "Системный DNS идёт напрямую: этот путь выбран явно. Правила доменов сохраняют приоритет."
            systemDns.via == DIRECT -> "Системный DNS следует правилам доменов; остальные запросы идут напрямую. Защищённых маршрутов приложений пока нет."
            else -> "Общий DNS-путь: «${pathName(systemDns.via)}»" +
                (systemDns.fallback?.let { "; резерв — «${pathName(it)}»" } ?: "") +
                ". Применяется к системным запросам, для которых Android не передал приложение."
        }
        val routeUi = data.routes.map { route ->
            val fallbackNative = nativeByTag["fb-${route.id}"]?.selected
            val fallback = route.fallback?.takeIf { "p-$it" == fallbackNative || "grp-$it" == fallbackNative }
            val effective = fallback ?: route.via
            val routeHealth = viaHealth(effective)
            val status = when {
                !route.enabled -> RouteState.OFF
                !pathAvailable(route.via) -> RouteState.BLOCKED
                runtime.phase in setOf(RuntimePhase.STARTING, RuntimePhase.STOPPING) -> RouteState.RETRYING
                runtime.phase != RuntimePhase.ON -> RouteState.IDLE
                effective == DIRECT -> RouteState.DIRECT
                fallback != null -> RouteState.FALLBACK
                routeHealth?.down == true -> RouteState.BLOCKED
                routeHealth?.healthy == true -> RouteState.OK
                routeHealth?.holding == true -> RouteState.RETRYING
                else -> RouteState.IDLE
            }
            RouteUi(route.id, when (route.kind) { "app" -> RouteKind.APP; "preset" -> RouteKind.SERVICE; else -> RouteKind.CUSTOM },
                route.name, route.via, route.fallback, route.enabled, route.match.takeIf { route.kind == "app" },
                route.match.takeIf { route.kind == "preset" }, route.match.takeIf { route.kind == "custom" }, status,
                effectiveViaId = effective, reason = when {
                    !pathAvailable(route.via) -> "Путь удалён или недоступен. Назначьте другой; напрямую трафик не перенаправляется."
                    routeHealth?.down == true -> "Удалённый путь не прошёл две последовательные проверки"
                    runtime.phase == RuntimePhase.ON && effective != DIRECT && routeHealth == null -> "Маршрут установлен; удалённый путь ещё не проверен"
                    else -> null
                })
        }
        val flows = controller.connections.value.filter { it.active }.map { connection ->
            val packageName = connection.packages.firstOrNull().orEmpty()
            val host = connection.domain.ifEmpty { connection.destination.substringBeforeLast(':').removePrefix("[").removeSuffix("]") }
            val port = connection.destination.substringAfterLast(':').toIntOrNull() ?: 0
            val outbound = connection.outbound.removePrefix("p-").removePrefix("grp-")
            FlowUi(connection.id, appsByPackage[packageName]?.name ?: packageName,
                packageName, host, port, connection.network, pathName(outbound), connection.rule, connection.downloadBytes, connection.uploadBytes)
        }
        val notices = buildList {
            repository.loadError.value?.let { add(NoticeUi("store", NoticeLevel.BLOCK, "Хранилище недоступно", it)) }
            if (!pathAvailable(data.settings.defaultVia)) add(NoticeUi("global-missing", NoticeLevel.BLOCK, "Общий маршрут недоступен", "Трафик без отдельного правила блокируется до выбора доступного пути."))
            if (systemDns.blocked) add(NoticeUi("system-dns", NoticeLevel.WARNING, "Общий DNS требует выбора", systemDnsHint))
            if (routeUi.any { it.state == RouteState.BLOCKED }) add(NoticeUi("blocked-routes", NoticeLevel.WARNING, "Есть недоступные маршруты", "Откройте «Маршруты» и проверьте назначенные туннели."))
            if (data.profiles.any { it.source == "public" }) add(NoticeUi("public", NoticeLevel.WARNING, "Добавлены публичные узлы", "Их владельцы неизвестны. Они не входят в Авто и используются только при вашем выборе."))
            if (runtime.phase == RuntimePhase.ON && !runtime.lockdown) add(NoticeUi("lockdown", NoticeLevel.INFO, "Постоянная блокировка не включена", "При остановке VPN Android может направить трафик напрямую. Системная настройка «Блокировать соединения без VPN» доступна в настройках."))
            val appRoutes = data.routes.filter { it.enabled && it.kind == "app" }.groupBy { route -> appsByPackage[route.match]?.uid }
            if (appRoutes.any { (uid, routes) -> uid != null && routes.map { it.via }.distinct().size > 1 }) add(NoticeUi("shared-uid", NoticeLevel.WARNING,
                "Приложения разделяют UID", "Android не различает их сетевые сокеты. Для общего UID действует первое подходящее правило."))
        }
        val rawLogs = controller.logs.value
        val format = Locale.getDefault().toLanguageTag() + "|" + TimeZone.getDefault().id
        if (rawLogs !== lastLogs || format != lastLogFormat) {
            val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            logLines = rawLogs.map { "${clock.format(Date(it.timestamp))} [${it.level}] ${it.message}" }
            lastLogs = rawLogs; lastLogFormat = format
        }
        _state.value = MobileState(
            initialized = repository.data.value != null,
            status = ConnectionUi(ConnectionPhase.valueOf(runtime.phase.name), repository.requestedOpen.value,
                recovering = repository.applying.value, recoveryFailed = repository.loadError.value != null, error = runtime.message,
                connectedSinceMillis = runtime.startedAt.takeIf { it > 0 }, downloadBytesPerSecond = runtime.downloadBps,
                uploadBytesPerSecond = runtime.uploadBps, downloadedBytes = runtime.downloadBytes, uploadedBytes = runtime.uploadBytes,
                selectedPathLabel = pathName(data.settings.defaultVia), autoPoolLive = repository.compiled.value?.groups?.find { it.id == AUTO }?.members?.size ?: 0,
                autoPoolTotal = allGroups.last().members.size),
            profiles = data.profiles.map { profile -> TunnelUi(profile.id, profile.name, profile.protocol, profile.host, profile.port,
                profile.addresses, when (profile.source) { "public" -> ProfileSource.PUBLIC; "managed" -> ProfileSource.MANAGED; "warp" -> ProfileSource.WARP; else -> ProfileSource.PERSONAL },
                health(measured[profile.id]), measured[profile.id]?.latencyMs?.toDouble(), profile.country.takeIf(String::isNotBlank),
                profile.revoked, profile.subscription != null, profile.subscriptionMissing, profile.clientPublicKey,
                canRename = profile.source !in setOf("managed", "public"), canReplace = profile.source !in setOf("managed", "public", "warp"), canDelete = profile.source != "managed") },
            groups = allGroups.map { group -> GroupUi(group.id, group.name, if (group.policy == "first") GroupPolicy.FIRST else GroupPolicy.FASTEST,
                group.members, selected(group.id), health(viaHealth(group.id)), viaHealth(group.id)?.latencyMs?.toDouble()) },
            routes = routeUi, apps = apps, presets = Presets.all.map { PresetUi(it.id, it.name, it.hint, it.domains + it.cidrs) },
            settings = SettingsUi(data.settings.defaultVia, data.settings.lastWholeDeviceVia, data.settings.lanDirect, data.settings.ruDirect,
                data.settings.autoConnect, data.settings.notifications, runtime.alwaysOn.takeIf { runtime.phase == RuntimePhase.ON }, runtime.lockdown.takeIf { runtime.phase == RuntimePhase.ON },
                data.settings.systemDnsVia, systemDnsHint, systemDns.blocked),
            catalog = catalog.copy(nodes = catalogProfiles.map { node -> PublicNodeUi(node.id, node.name, node.protocol, node.host, node.port, node.country,
                latencyMs = catalogHealth[node.id]?.latencyMs?.toDouble(), health = health(catalogHealth[node.id])) }),
            flows = flows, latencyHistory = repository.history.value.mapNotNull { (id, samples) -> profilesById[id]?.let { LatencySeriesUi(id, it.name, samples) } },
            diagnostic = diagnostic, logs = logLines,
            notices = notices, error = repository.loadError.value, message = message, appVersion = BuildConfig.VERSION_NAME, engineVersion = runtime.coreVersion,
        )
    }

    private suspend fun action(block: suspend () -> String?): UiResult = try {
        val message = block(); changed(); UiResult(true, message)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) { changed(); UiResult(false, friendly(error)) }
    private fun friendly(error: Throwable): String {
        val text = error.message.orEmpty()
        return if (text.any { it in 'А'..'я' || it == 'ё' } && !Regex("://|[A-Za-z0-9+/]{32,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-").containsMatchIn(text)) text.take(300)
        else when (error) {
            is java.io.IOException -> NetworkTools.safeError(error)
            else -> "Операция не выполнена. Проверьте параметры и состояние VPN."
        }
    }
    override fun connect() {
        if (repository.requestedOpen.value && controller.status.value.phase in setOf(RuntimePhase.ON, RuntimePhase.STARTING)) return
        val token = repository.requestConnect()
        viewModelScope.launch {
            try {
                val consent = controller.prepare()
                if (consent != null) { pendingConsentToken = token; pendingConsentIntent = consent; eventsChannel.send(MobileEvent.Consent(token, consent)) }
                else repository.completeConnect(token)
            } catch (error: Exception) { repository.consentCancelled(token); notifyUser(friendly(error), true) }
        }
    }
    fun onConsentResult(granted: Boolean) {
        val token = pendingConsentToken ?: return
        pendingConsentToken = null
        pendingConsentIntent = null
        if (!granted) { repository.consentCancelled(token); notifyUser("Разрешение VPN не получено", true); return }
        viewModelScope.launch { val result = action { repository.completeConnect(token); null }; if (!result.ok) notifyUser(result.message.orEmpty(), true) }
    }
    override fun disconnect() { pendingConsentToken = null; pendingConsentIntent = null; repository.disconnect() }
    override fun requestFileImport(replaceProfileId: String?) { pendingReplaceId = replaceProfileId; event(MobileEvent.FileImport(replaceProfileId)) }
    override fun requestQrImport() = event(MobileEvent.QrImport)
    override fun requestClipboardImport() = event(MobileEvent.ClipboardImport)
    override fun openSystemVpnSettings() = event(MobileEvent.SystemVpnSettings)
    override fun shareDiagnostics() = event(MobileEvent.ShareDiagnostics)
    override suspend fun refresh() = action { repository.reload(); repository.ready(); "Данные обновлены" }
    @Suppress("DEPRECATION")
    override suspend fun refreshApps() = action {
        check(!appScanBusy) { "Список приложений уже обновляется" }; appScanBusy = true
        try {
            apps = withContext(Dispatchers.IO) {
                val pm = app.packageManager
                pm.getPackagesHoldingPermissions(arrayOf(android.Manifest.permission.INTERNET), 0).mapNotNull { info ->
                    val ai = info.applicationInfo ?: return@mapNotNull null
                    if (info.packageName == app.packageName) return@mapNotNull null
                    AppUi(info.packageName, pm.getApplicationLabel(ai).toString(), ai.uid, ai.flags and ApplicationInfo.FLAG_SYSTEM != 0,
                        runCatching { pm.getApplicationIcon(ai) }.getOrNull())
                }.sortedWith(compareBy<AppUi> { it.system }.thenBy { it.name.lowercase() })
            }; "Приложений: ${apps.size}"
        } finally { appScanBusy = false }
    }
    private fun validPath(data: AppData, id: String): Boolean = id == DIRECT || (id == AUTO && data.profiles.any { !it.revoked && !it.subscriptionMissing && it.source != "public" }) ||
        data.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing } || data.groups.any { group -> group.id == id && group.members.any { member -> data.profiles.any { it.id == member && !it.revoked && !it.subscriptionMissing } } }
    override suspend fun setDefaultRoute(viaId: String) = action {
        repository.edit { value ->
            require(validPath(value, viaId)) { "Выбранный путь недоступен" }
            value.copy(settings = value.settings.copy(defaultVia = viaId, lastWholeDeviceVia = if (viaId == DIRECT) value.settings.lastWholeDeviceVia else viaId))
        }; "Общий маршрут сохранён"
    }
    override suspend fun saveRoute(route: RouteDraft) = action {
        repository.edit { value ->
            require(route.name.isNotBlank() && route.name.length <= 80) { "Укажите название до 80 символов" }
            require(validPath(value, route.viaId)) { "Выбранный путь недоступен" }
            val fallback = route.fallbackViaId?.takeIf { route.viaId != DIRECT && it != route.viaId }
            require(fallback == null || (fallback != DIRECT && validPath(value, fallback))) { "Резерв должен быть доступным туннелем или группой" }
            val kind = when (route.kind) { RouteKind.APP -> "app"; RouteKind.SERVICE -> "preset"; RouteKind.CUSTOM -> "custom" }
            val match = when (route.kind) {
                RouteKind.APP -> route.packageName?.also { name -> require(apps.any { it.packageName == name }) { "Приложение не найдено" } }
                RouteKind.SERVICE -> route.presetId?.also { id -> require(Presets.all.any { it.id == id }) { "Сервис не найден" } }
                RouteKind.CUSTOM -> route.selector?.trim()?.also { text -> require(text.length <= 16_384) }
            } ?: error("Не указана цель маршрута")
            val id = route.id ?: newId("r-")
            if (route.id != null) require(value.routes.any { it.id == id }) { "Маршрут уже удалён" }
            val next = TrafficRoute(id, ProfileImporter.name(route.name), kind, match, route.viaId, fallback, route.enabled)
            value.copy(routes = if (route.id == null) value.routes + next else value.routes.map { if (it.id == id) next else it })
        }; "Маршрут сохранён"
    }
    override suspend fun setRouteEnabled(id: String, enabled: Boolean) = action {
        repository.edit { value -> require(value.routes.any { it.id == id }); value.copy(routes = value.routes.map { if (it.id == id) it.copy(enabled = enabled) else it }) }; null
    }
    override suspend fun deleteRoute(id: String) = action { repository.edit { it.copy(routes = it.routes.filterNot { route -> route.id == id }) }; "Маршрут удалён" }
    override suspend fun importText(text: String, name: String) = action {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_IMPORT_BYTES) { "Конфиг слишком большой: максимум 1 МБ" }
        val subscription = text.trim().takeIf(ProfileImporter::isSubscription)
        val body = if (subscription != null) network.fetch(subscription) else text
        val imported = withContext(Dispatchers.Default) { ProfileImporter.parse(body, if (subscription != null) "" else name) }
        repository.validateProfiles(imported.profiles)
        var added = 0
        repository.edit { value ->
            if (subscription != null && value.profiles.any { it.subscription == subscription }) {
                val merged = Subscriptions.reconcile(value.profiles, imported, subscription); added = merged.added + merged.updated
                value.copy(profiles = merged.profiles)
            } else {
                val known = value.profiles.map(ProfileImporter::identity).toMutableSet()
                val fresh = imported.profiles.filter { known.add(ProfileImporter.identity(it)) }.map {
                    it.copy(subscription = subscription, subscriptionKey = subscription?.let { _ -> ProfileImporter.subscriptionKey(it) })
                }
                added = fresh.size; require(added > 0) { "Эти профили уже добавлены" }; value.copy(profiles = value.profiles + fresh)
            }
        }; "Сохранено профилей: $added${if (imported.skipped > 0) "; пропущено: ${imported.skipped}" else ""}"
    }
    override suspend fun createWireGuard(draft: WireGuardDraft) = action {
        require(listOf(draft.name, draft.address, draft.endpoint, draft.serverPublicKey).all { it.isNotBlank() && it.length <= 256 && !it.contains(Regex("[\\r\\n]")) }) { "Заполните данные сервера без переносов строк" }
        val keys = controller.generateWireGuardKeyPair()
        val config = "[Interface]\nPrivateKey = ${keys.privateKey}\nAddress = ${draft.address.trim()}\n[Peer]\nPublicKey = ${draft.serverPublicKey.trim()}\nEndpoint = ${draft.endpoint.trim()}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n"
        val profile = withContext(Dispatchers.Default) { ProfileImporter.wireGuard(config, draft.name).copy(clientPublicKey = keys.publicKey) }
        repository.validateProfiles(listOf(profile)); repository.edit { it.copy(profiles = it.profiles + profile) }
        "Профиль создан. Добавьте публичный ключ клиента в настройки вашего сервера."
    }
    override suspend fun renameTunnel(id: String, name: String) = action {
        require(name.isNotBlank() && name.length <= 80) { "Укажите название до 80 символов" }
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error("Туннель уже удалён")
            require(old.source !in setOf("managed", "public")) { "Именем управляет источник" }
            value.copy(profiles = value.profiles.map { if (it.id == id) it.copy(name = ProfileImporter.name(name)) else it })
        }; "Название сохранено"
    }
    override suspend fun replaceTunnel(id: String, text: String) = action {
        val result = withContext(Dispatchers.Default) { ProfileImporter.parse(text) }
        require(result.profiles.size == 1 && result.skipped == 0) { "Для замены нужен ровно один профиль" }
        val profile = result.profiles.single(); repository.validateProfiles(listOf(profile))
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error("Туннель уже удалён")
            require(old.source !in setOf("managed", "public", "warp")) { "Профилем управляет источник" }
            value.copy(profiles = value.profiles.map { if (it.id == id) profile.copy(id = old.id, name = old.name, addedAt = old.addedAt) else it })
        }; "Профиль заменён; маршруты сохранили привязку"
    }
    private fun reassign(data: AppData, removed: String, replacement: String?): AppData {
        if (replacement == null) return data
        require(replacement != removed && validPath(data, replacement)) { "Выберите доступную замену" }
        return data.copy(routes = data.routes.map {
            val via = if (it.via == removed) replacement else it.via
            val fallback = if (it.fallback == removed) replacement else it.fallback
            it.copy(via = via, fallback = fallback?.takeUnless { path -> via == DIRECT || path == DIRECT || path == via })
        },
            settings = data.settings.copy(defaultVia = if (data.settings.defaultVia == removed) replacement else data.settings.defaultVia,
                lastWholeDeviceVia = if (data.settings.lastWholeDeviceVia == removed) replacement else data.settings.lastWholeDeviceVia,
                systemDnsVia = if (data.settings.systemDnsVia == removed) replacement else data.settings.systemDnsVia))
    }
    override suspend fun removeTunnel(id: String, replacementId: String?) = action {
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error("Туннель уже удалён")
            require(old.source != "managed") { "Туннелем управляет команда" }
            val updated = reassign(value, id, replacementId)
            val result = updated.copy(profiles = updated.profiles.filterNot { it.id == id }, groups = updated.groups.map { group ->
                group.copy(members = group.members.flatMap { member -> if (member != id) listOf(member) else listOfNotNull(replacementId?.takeIf { replacement -> updated.profiles.any { it.id == replacement } }) }.distinct())
            })
            require(replacementId == null || validPath(result, replacementId)) { "После удаления выбранная группа останется без участников; выберите другой путь" }
            result
        }; if (replacementId == null) "Туннель удалён. Его неназначенные маршруты останутся заблокированы." else "Туннель удалён, пути переназначены"
    }
    override suspend fun refreshSubscription(id: String) = action {
        val profile = repository.ready().profiles.find { it.id == id } ?: error("Туннель уже удалён")
        val subscription = profile.subscription ?: error("Профиль не связан с подпиской")
        val body = network.fetch(subscription)
        val incoming = withContext(Dispatchers.Default) { ProfileImporter.parse(body) }
        require(incoming.skipped == 0) { "Подписка прочитана не полностью. Сохранённые профили оставлены без изменений." }
        repository.validateProfiles(incoming.profiles)
        var summary = ""
        repository.edit { value ->
            require(value.profiles.any { it.id == id && it.subscription == subscription }) { "Подписка изменилась во время загрузки" }
            val merged = Subscriptions.reconcile(value.profiles, incoming, subscription)
            summary = "Обновлено: ${merged.updated}; добавлено: ${merged.added}; исчезло у источника: ${merged.missing}"
            value.copy(profiles = merged.profiles)
        }; summary
    }
    override suspend fun saveGroup(group: GroupDraft) = action {
        repository.edit { value ->
            require(group.name.isNotBlank() && group.name.length <= 80 && group.members.isNotEmpty()) { "Укажите название и участников" }
            require(group.members.distinct().size == group.members.size && group.members.all { id -> value.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing } }) { "В группе есть недоступный участник" }
            require(group.id != AUTO) { "Авто формируется из личных туннелей" }
            val id = group.id ?: newId("g-")
            if (group.id != null) require(value.groups.any { it.id == id }) { "Группа уже удалена" }
            val next = TunnelGroup(id, ProfileImporter.name(group.name), if (group.policy == GroupPolicy.FIRST) "first" else "fastest", group.members)
            value.copy(groups = if (group.id == null) value.groups + next else value.groups.map { if (it.id == id) next else it })
        }; "Группа сохранена"
    }
    override suspend fun deleteGroup(id: String, replacementId: String?) = action {
        require(id != AUTO) { "Авто нельзя удалить" }
        repository.edit { value -> require(value.groups.any { it.id == id }); reassign(value, id, replacementId).let { it.copy(groups = it.groups.filterNot { group -> group.id == id }) } }
        "Группа удалена"
    }
    override suspend fun refreshCatalog() = action {
        check(!catalog.busy) { "Каталог уже обновляется" }; catalog = catalog.copy(busy = true, error = null); changed()
        try {
            val result = network.catalog()
            if (result.profiles.isEmpty()) { catalog = catalog.copy(sources = result.sources, error = "Источники недоступны; предыдущий каталог сохранён"); error("Не удалось обновить публичные источники") }
            catalogProfiles = result.profiles
            catalogHealth.keys.retainAll(catalogProfiles.map { it.id }.toSet())
            catalog = catalog.copy(sources = result.sources, total = result.profiles.size, updatedAtMillis = System.currentTimeMillis(), checked = 0, planned = 0)
            "Публичных узлов: ${result.profiles.size}. Работоспособность ещё не проверена."
        } finally { catalog = catalog.copy(busy = false); changed() }
    }
    override suspend fun addCatalogNode(id: String) = action {
        val profile = catalogProfiles.find { it.id == id } ?: error("Обновите каталог")
        repository.validateProfiles(listOf(profile))
        repository.edit { value ->
            require(value.profiles.none { it.id == id || ProfileImporter.identity(it) == ProfileImporter.identity(profile) }) { "Узел уже добавлен" }
            value.copy(profiles = value.profiles + profile.copy(source = "public"))
        }; "Публичный узел добавлен. Назначьте его маршруту явно."
    }
    override suspend fun addBestPublicGroup() = action {
        check(!catalog.busy) { "Дождитесь завершения операции с каталогом" }
        require(controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING, RuntimePhase.STOPPING)) { "Для проверки новых публичных узлов сначала выключите VPN" }
        require(catalogProfiles.isNotEmpty()) { "Сначала обновите каталог" }
        catalog = catalog.copy(busy = true, checked = 0, planned = minOf(8, catalogProfiles.size)); changed()
        try {
            val results = repository.probe(extra = catalogProfiles)
            results.forEach { sample -> val id = sample.tag.removePrefix("p-"); catalogHealth[id] = (catalogHealth[id] ?: ProbeHealth()).measured(sample.delayMs, sample.checkedAt) }
            catalog = catalog.copy(checked = results.size)
            val good = results.filter { it.delayMs != null }.sortedBy { it.delayMs }.take(5).mapNotNull { sample -> catalogProfiles.find { "p-${it.id}" == sample.tag } }
            require(good.isNotEmpty()) { "В проверенной выборке нет работающих узлов. Повторная проверка возьмёт следующие." }
            repository.validateProfiles(good)
            repository.edit { value ->
                val all = value.profiles.toMutableList()
                val members = good.map { profile -> all.find { ProfileImporter.identity(it) == ProfileImporter.identity(profile) }?.id ?: profile.id.also { all.add(profile.copy(source = "public")) } }
                value.copy(profiles = all, groups = value.groups + TunnelGroup(name = "Публичные узлы ${value.groups.count { it.name.startsWith("Публичные узлы") } + 1}", members = members))
            }; "Создана группа из ${good.size} узлов, прошедших реальную HTTPS-проверку; проверено ${results.size}."
        } finally { catalog = catalog.copy(busy = false); changed() }
    }
    override suspend fun diagnose(target: String) = action {
        check(!diagnosticBusy) { "Диагностика уже выполняется" }
        val uri = network.target(target); diagnosticBusy = true
        diagnostic = DiagnosticUi(uri.toString(), running = true); changed()
        try {
            val layers = network.diagnose(uri.toString())
            diagnostic = diagnostic?.copy(layers = layers); changed()
            val measured = repository.probe(url = uri.toString())
            val profiles = repository.ready().profiles
            val paths = measured.map { sample -> DiagnosticPathUi(sample.tag.removePrefix("p-"),
                profiles.find { "p-${it.id}" == sample.tag }?.name ?: "Туннель", sample.delayMs?.toDouble(),
                if (sample.delayMs != null) ObservationResult.OK else ObservationResult.FAILED) }
            val best = paths.filter { it.result == ObservationResult.OK }.minByOrNull { it.latencyMs ?: Double.MAX_VALUE }
            diagnostic = diagnostic?.copy(paths = paths, suggestedViaId = best?.id, conclusion = when {
                best != null -> "Адрес отвечает через «${best.name}». Можно создать для него отдельный маршрут."
                layers.any { it.name.startsWith("HTTP") && it.result == ObservationResult.OK } -> "Прямой HTTP-ответ получен. В проверенной выборке нет подтверждённого туннеля к этому адресу."
                paths.isEmpty() -> "Проверены прямые сетевые уровни. Доступных туннелей для проверки нет."
                else -> "Проверенные пути не подтвердили доступность. Смотрите, на каком уровне прервалась проверка; это не доказывает причину сбоя."
            }); "Диагностика завершена"
        } finally { diagnosticBusy = false; diagnostic = diagnostic?.copy(running = false); changed() }
    }
    override suspend fun probeTunnels() = action {
        val measured = repository.probe(); require(measured.isNotEmpty()) { "Нет доступных для проверки профилей в текущем режиме" }
        "Проверено: ${measured.size}; ответили: ${measured.count { it.delayMs != null }}. Остальные профили не оценивались."
    }
    override suspend fun readLogs() = action { changed(); "Журнал обновлён" }
    override suspend fun recover() = action {
        disconnect(); withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR } }
        repository.reload(); repository.ready(); "Служба остановлена, защищённое хранилище прочитано. Можно подключаться снова."
    }
    override suspend fun saveSettings(patch: SettingsPatch) = action {
        repository.edit { value -> value.copy(settings = value.settings.copy(lanDirect = patch.lanDirect ?: value.settings.lanDirect,
            ruDirect = patch.ruDirect ?: value.settings.ruDirect, autoConnect = patch.autoConnect ?: value.settings.autoConnect,
            notifications = patch.notifications ?: value.settings.notifications)) }; "Настройки сохранены"
    }
    override suspend fun setSystemDnsPath(viaId: String?) = action {
        repository.edit { value ->
            require(viaId == null || validPath(value, viaId)) { "Выберите доступный путь для общего DNS" }
            value.copy(settings = value.settings.copy(systemDnsVia = viaId))
        }
        "Общий DNS сохранён"
    }

    /** Share only coarse counts, versions and redacted diagnostic outcomes; profiles/endpoints/keys never leave here. */
    fun diagnosticReport(): String {
        val value = state.value
        return buildString {
            appendLine("Waarp Android ${BuildConfig.VERSION_NAME}")
            appendLine("Engine ${BuildConfig.ENGINE_VERSION}; AAR SHA256 ${BuildConfig.ENGINE_SHA256}")
            appendLine("Android API ${android.os.Build.VERSION.SDK_INT}; ${android.os.Build.SUPPORTED_ABIS.joinToString()}")
            appendLine("Phase: ${value.status.phase}; profiles: ${value.profiles.size}; routes: ${value.routes.size}; groups: ${value.groups.size}")
            appendLine("Always-on: ${value.settings.systemAlwaysOn}; lockdown: ${value.settings.systemLockdown}")
            appendLine("Down/up: ${value.status.downloadedBytes}/${value.status.uploadedBytes}; active flows: ${value.flows.size}")
            value.diagnostic?.layers?.forEach { appendLine("${it.name}: ${it.result}") }
            value.diagnostic?.paths?.forEachIndexed { index, path -> appendLine("Path ${index + 1}: ${path.result}; latency ${path.latencyMs ?: "unknown"}") }
            val logCounts = controller.logs.value.groupingBy { it.level }.eachCount()
            appendLine("Log counts by severity: $logCounts")
        }
    }
}
