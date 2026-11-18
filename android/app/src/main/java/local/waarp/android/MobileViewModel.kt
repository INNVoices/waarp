// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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
import local.waarp.android.data.*
import local.waarp.android.ui.*
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

sealed interface MobileEvent {
    data class Consent(val token: Long, val intent: Intent) : MobileEvent
    data class FileImport(val replaceId: String?) : MobileEvent
    data object QrImport : MobileEvent
    data object ClipboardImport : MobileEvent
    data object SystemVpnSettings : MobileEvent
    data object ShareDiagnostics : MobileEvent
    data class RestartApproval(val response: CompletableDeferred<Boolean>) : MobileEvent
}

class MobileViewModel(application: Application, private val savedState: SavedStateHandle) : AndroidViewModel(application), MobileActions {
    private companion object {
        const val IMPORT_REPLACE_ID = "import-replace-id"
        const val IMPORT_PICKER_OPEN = "import-picker-open"
    }
    private val app = application as WaarpApplication
    val repository = app.repository
    private val controller = repository.controller
    private val network = app.network
    private val _state = MutableStateFlow(MobileState(appVersion = BuildConfig.VERSION_NAME, engineVersion = BuildConfig.ENGINE_VERSION))
    val state = _state.asStateFlow()
    private val eventsChannel = Channel<MobileEvent>(Channel.BUFFERED)
    val events = eventsChannel.receiveAsFlow()
    private val restartApprovalRequest: suspend () -> Boolean = {
        StructuralRestartApproval.awaitResponse { response ->
            eventsChannel.send(MobileEvent.RestartApproval(response))
        }
    }
    private val updates = Channel<Unit>(Channel.CONFLATED)
    private val mapper = MobileStateMapper()
    private val messageIds = AtomicLong()
    private var apps: List<AppUi> = emptyList()
    private var catalogProfiles: List<TunnelProfile> = emptyList()
    private var catalog = CatalogUi()
    private var catalogHealth: Map<String, ProbeHealth> = emptyMap()
    private var diagnostic: DiagnosticUi? = null
    private var message: UiMessage? = null
    private var diagnosticBusy = false
    private var appScanBusy = false
    private var tuning: TunnelTuningUi? = null
    private var tuningProof: TuningProof? = null
    private var tuningJob: Job? = null
    private var transferJob: Job? = null
    private var transfer: TransferUi? = null
    private val catalogCache = ProfileStore(application, catalogCache = true)
    var pendingConsentToken: Long? = null
        private set
    var pendingConsentIntent: Intent? = null
        private set
    // SAF can outlive our process. Restore its nonsecret purpose before the result callback;
    // otherwise a selected replacement file would silently become a new imported profile.
    private var pendingReplaceId: String?
        get() = savedState[IMPORT_REPLACE_ID]
        set(value) { savedState[IMPORT_REPLACE_ID] = value }
    private var importPickerOpen: Boolean
        get() = savedState[IMPORT_PICKER_OPEN] ?: false
        set(value) { savedState[IMPORT_PICKER_OPEN] = value }
    internal val imports = ImportCoordinator(viewModelScope, { uri -> readImportDocument(app, uri) },
        { text, name, replacement -> if (replacement == null) importText(text, name) else replaceTunnel(replacement, text) }, ::notifyUser)

    init {
        repository.confirmStructuralRestart = restartApprovalRequest
        // Remove unrelated values restored from an older Activity state before
        // workers/callbacks can use it or Android saves it again. Only these two
        // typed, nonsecret picker fields belong in SavedStateHandle.
        savedState.keys().filterNot { it == IMPORT_REPLACE_ID || it == IMPORT_PICKER_OPEN }
            .forEach { savedState.remove<Any?>(it) }
        if (savedState.get<Any?>(IMPORT_REPLACE_ID) !is String) savedState.remove<Any?>(IMPORT_REPLACE_ID)
        if (savedState.get<Any?>(IMPORT_PICKER_OPEN) !is Boolean) savedState.remove<Any?>(IMPORT_PICKER_OPEN)
        viewModelScope.launch {
            for (ignored in updates) {
                // Telemetry continues in the VPN service; UI projections sleep while no screen observes them.
                _state.subscriptionCount.first { it > 0 }
                rebuild()
                delay(40)
            }
        }
        val streams: List<Flow<*>> = listOf(repository.data, repository.loadError, repository.requestedOpen, repository.applying,
            repository.compiled, repository.health, repository.history, controller.status, controller.groups, controller.connections, controller.logs, imports.state,
            app.evidence.report)
        streams.forEach { stream -> viewModelScope.launch { stream.collect { changed() } } }
        viewModelScope.launch {
            runCatching { catalogCache.read() }.getOrNull()?.takeIf { it.profiles.isNotEmpty() }?.let { cached ->
                if (catalogProfiles.isEmpty()) {
                    catalogProfiles = cached.profiles
                    catalog = CatalogUi(total = cached.profiles.size, updatedAtMillis = cached.revision)
                    changed()
                }
            }
        }
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
    private suspend fun rebuild() {
        // Capture all inputs together on Main; mapping and formatting never block rendering.
        val compiled = repository.compiled.value
        val snapshot = MobileStateSnapshot(repository.data.value, controller.status.value, repository.health.value,
            controller.groups.value, controller.connections.value, controller.logs.value, apps,
            repository.requestedOpen.value, repository.applying.value, repository.loadError.value,
            compiled?.groups?.find { it.id == AUTO }?.members?.size ?: 0,
            repository.history.value, catalogProfiles, catalog, catalogHealth, diagnostic, message, BuildConfig.VERSION_NAME, imports.state.value.taskLabel,
            compiled?.routes.orEmpty(), compiled?.blockedPaths.orEmpty(), compiled?.liveUpdateNote)
        val projected = withContext(Dispatchers.Default) { mapper.map(snapshot) }
        val current = controller.status.value
        if (snapshot.data !== repository.data.value || snapshot.requestedOpen != repository.requestedOpen.value ||
            snapshot.runtime.phase != current.phase || snapshot.runtime.startedAt != current.startedAt || snapshot.message !== message) {
            // A save, OFF, or a new session supersedes an in-flight projection. Telemetry-only changes can coalesce.
            changed()
            return
        }
        val proofCurrent = tuningProof?.let { proof ->
            proof.current(repository.data.value?.profiles?.find { it.id == proof.profileId }, network.physicalNetwork()?.networkHandle,
                repository.intentGeneration(), repository.data.value?.revision ?: -1, System.currentTimeMillis())
        } == true
        _state.value = projected.copy(tuning = tuning?.let { it.copy(canApply = it.canApply && proofCurrent) },
            savedDiagnostics = app.evidence.report.value, transfer = transfer)
    }

    private suspend fun action(block: suspend () -> String?): UiResult = try {
        val message = block(); changed(); UiResult(true, message)
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: Exception) { changed(); UiResult(false, friendly(error)) }
    // A row can leave composition during native validation, before Repository's atomic
    // commit begins. Once accepted, its mutation belongs to this ViewModel, not that row.
    // Failures remain visible even when the originating card/settings screen has gone.
    private suspend fun mutation(block: suspend () -> String?): UiResult = viewModelScope.async {
        action(block).also { result -> if (!result.ok) notifyUser(result.message ?: "Изменения не сохранены", true) }
    }.await()
    private fun friendly(error: Throwable): String {
        val text = error.message.orEmpty()
        return if (text.any { it in 'А'..'я' || it == 'ё' } && !Regex("://|[A-Za-z0-9+/]{32,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-").containsMatchIn(text)) text.take(300)
        else when (error) {
            is java.io.IOException -> NetworkTools.safeError(error)
            else -> "Операция не выполнена. Проверьте параметры и состояние VPN."
        }
    }
    override fun connect() {
        cancelTuning(); cancelTransfer()
        if (repository.requestedOpen.value && (pendingConsentToken != null || controller.status.value.phase in setOf(RuntimePhase.ON, RuntimePhase.STARTING))) return
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
    override fun disconnect() { cancelTuning(); cancelTransfer(); pendingConsentToken = null; pendingConsentIntent = null; repository.disconnect() }
    override fun requestFileImport(replaceProfileId: String?) {
        if (importPickerOpen || imports.state.value.busy) return
        importPickerOpen = true; pendingReplaceId = replaceProfileId; event(MobileEvent.FileImport(replaceProfileId))
    }
    override fun requestQrImport() {
        if (importPickerOpen || imports.state.value.busy) return
        importPickerOpen = true; event(MobileEvent.QrImport)
    }
    fun onDocumentsPicked(uris: List<Uri>) {
        val replacement = pendingReplaceId
        cancelImportPicker()
        imports.importDocuments(uris.toList(), replacement)
    }
    fun onQrResult(text: String?) { cancelImportPicker(); text?.let(imports::importText) }
    fun cancelImportPicker() { importPickerOpen = false; pendingReplaceId = null }
    fun isCurrentConsent(token: Long) = pendingConsentToken == token && repository.requestedOpen.value && repository.intentGeneration() == token
    fun currentConsentIntent(): Intent? = pendingConsentToken?.takeIf(::isCurrentConsent)?.let { pendingConsentIntent }
    fun onForeground() {
        viewModelScope.launch { controller.refreshSystemStatus() }
        changed()
    }
    override fun onCleared() {
        if (repository.confirmStructuralRestart === restartApprovalRequest) repository.confirmStructuralRestart = null
        cancelTuning(); cancelTransfer(); imports.clearSensitiveInput(); super.onCleared()
    }
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
                        versionCode = info.longVersionCode)
                }.sortedWith(compareBy<AppUi> { it.system }.thenBy { it.name.lowercase() })
            }; "Приложений: ${apps.size}"
        } finally { appScanBusy = false }
    }
    private fun validPath(data: AppData, id: String): Boolean = id == DIRECT || (id == AUTO && data.profiles.any { !it.revoked && !it.subscriptionMissing && it.source != "public" }) ||
        data.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing } || data.groups.any { group -> group.id == id && group.members.any { member -> data.profiles.any { it.id == member && !it.revoked && !it.subscriptionMissing } } }
    override suspend fun setDefaultRoute(viaId: String) = mutation {
        repository.edit { value ->
            require(validPath(value, viaId)) { "Выбранный путь недоступен" }
            value.copy(settings = value.settings.copy(defaultVia = viaId, lastWholeDeviceVia = if (viaId == DIRECT) value.settings.lastWholeDeviceVia else viaId))
        }; "Общий маршрут сохранён"
    }
    override suspend fun saveRoute(route: RouteDraft) = mutation {
        // Repository edit transforms run on Default. Capture the current scan
        // on Main so a concurrent refresh never exposes mutable ViewModel state.
        val availableApps = apps
        repository.edit { value ->
            require(route.name.isNotBlank() && route.name.length <= 80) { "Укажите название до 80 символов" }
            require(validPath(value, route.viaId)) { "Выбранный путь недоступен" }
            val fallback = route.fallbackViaId?.takeIf { route.viaId != DIRECT && it != route.viaId }
            require(fallback == null || (fallback != DIRECT && validPath(value, fallback))) { "Резерв должен быть доступным туннелем или группой" }
            val kind = when (route.kind) { RouteKind.APP -> "app"; RouteKind.SERVICE -> "preset"; RouteKind.CUSTOM -> "custom" }
            val match = when (route.kind) {
                RouteKind.APP -> route.packageName?.also { name -> require(availableApps.any { it.packageName == name }) { "Приложение не найдено" } }
                RouteKind.SERVICE -> route.presetId?.also { id -> require(Presets.all.any { it.id == id }) { "Сервис не найден" } }
                RouteKind.CUSTOM -> route.selector?.trim()?.also { text -> require(text.length <= 16_384) }
            } ?: error("Не указана цель маршрута")
            val id = route.id ?: newId("r-")
            if (route.id != null) require(value.routes.any { it.id == id }) { "Маршрут уже удалён" }
            val next = TrafficRoute(id, ProfileImporter.name(route.name), kind, match, route.viaId, fallback, route.enabled)
            value.copy(routes = if (route.id == null) value.routes + next else value.routes.map { if (it.id == id) next else it })
        }; "Маршрут сохранён"
    }
    override suspend fun setRouteEnabled(id: String, enabled: Boolean) = mutation {
        repository.edit { value -> require(value.routes.any { it.id == id }); value.copy(routes = value.routes.map { if (it.id == id) it.copy(enabled = enabled) else it }) }; null
    }
    override suspend fun deleteRoute(id: String) = mutation { repository.edit { it.copy(routes = it.routes.filterNot { route -> route.id == id }) }; "Маршрут удалён" }
    override suspend fun importText(text: String, name: String) = mutation {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_IMPORT_BYTES) { "Конфиг слишком большой: максимум 1 МБ" }
        val subscription = text.trim().takeIf(ProfileImporter::isSubscription)
        val body = if (subscription != null) fetchService(subscription) else text
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
    override suspend fun createWireGuard(draft: WireGuardDraft) = mutation {
        require(listOf(draft.name, draft.address, draft.endpoint, draft.serverPublicKey).all { it.isNotBlank() && it.length <= 256 && !it.contains(Regex("[\\r\\n]")) }) { "Заполните данные сервера без переносов строк" }
        val keys = controller.generateWireGuardKeyPair()
        val config = "[Interface]\nPrivateKey = ${keys.privateKey}\nAddress = ${draft.address.trim()}\n[Peer]\nPublicKey = ${draft.serverPublicKey.trim()}\nEndpoint = ${draft.endpoint.trim()}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n"
        val profile = withContext(Dispatchers.Default) { ProfileImporter.wireGuard(config, draft.name).copy(clientPublicKey = keys.publicKey) }
        repository.validateProfiles(listOf(profile)); repository.edit { it.copy(profiles = it.profiles + profile) }
        "Профиль создан. Добавьте публичный ключ клиента в настройки вашего сервера."
    }
    override suspend fun renameTunnel(id: String, name: String) = mutation {
        require(name.isNotBlank() && name.length <= 80) { "Укажите название до 80 символов" }
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error("Туннель уже удалён")
            require(old.source !in setOf("managed", "public")) { "Именем управляет источник" }
            value.copy(profiles = value.profiles.map { if (it.id == id) it.copy(name = ProfileImporter.name(name)) else it })
        }; "Название сохранено"
    }
    override suspend fun replaceTunnel(id: String, text: String) = mutation {
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
        if (data.settings.serviceVia == removed) require(replacement == DIRECT || data.profiles.any {
            it.id == replacement && it.source == "personal" && !it.revoked && !it.subscriptionMissing
        }) { "Для служебных загрузок выберите личный туннель или прямой путь; группу использовать нельзя" }
        return data.copy(routes = data.routes.map {
            val via = if (it.via == removed) replacement else it.via
            val fallback = if (it.fallback == removed) replacement else it.fallback
            it.copy(via = via, fallback = fallback?.takeUnless { path -> via == DIRECT || path == DIRECT || path == via })
        },
            settings = data.settings.copy(defaultVia = if (data.settings.defaultVia == removed) replacement else data.settings.defaultVia,
                lastWholeDeviceVia = if (data.settings.lastWholeDeviceVia == removed) replacement else data.settings.lastWholeDeviceVia,
                systemDnsVia = if (data.settings.systemDnsVia == removed) replacement else data.settings.systemDnsVia,
                serviceVia = if (data.settings.serviceVia == removed) replacement else data.settings.serviceVia))
    }
    override suspend fun removeTunnel(id: String, replacementId: String?) = mutation {
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
        val body = fetchService(subscription)
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
    override suspend fun saveGroup(group: GroupDraft) = mutation {
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
    override suspend fun deleteGroup(id: String, replacementId: String?) = mutation {
        require(id != AUTO) { "Авто нельзя удалить" }
        repository.edit { value -> require(value.groups.any { it.id == id }); reassign(value, id, replacementId).let { it.copy(groups = it.groups.filterNot { group -> group.id == id }) } }
        "Группа удалена"
    }
    override suspend fun refreshCatalog() = action {
        check(!catalog.busy) { "Каталог уже обновляется" }; catalog = catalog.copy(busy = true, error = null); changed()
        try {
            val result = network.catalog(::fetchService)
            if (result.profiles.isEmpty()) { catalog = catalog.copy(sources = result.sources, error = "Источники недоступны; предыдущий каталог сохранён"); error("Не удалось обновить публичные источники") }
            val fetchedAt = System.currentTimeMillis()
            catalogCache.write(AppData(profiles = result.profiles, revision = fetchedAt))
            catalogProfiles = result.profiles
            val currentIds = catalogProfiles.mapTo(HashSet()) { it.id }
            catalogHealth = catalogHealth.filterKeys { it in currentIds }
            catalog = catalog.copy(sources = result.sources, total = result.profiles.size, updatedAtMillis = fetchedAt, checked = 0, planned = 0)
            "Публичных узлов: ${result.profiles.size}. Работоспособность ещё не проверена."
        } finally { catalog = catalog.copy(busy = false); changed() }
    }
    override suspend fun addCatalogNode(id: String) = mutation {
        val profile = catalogProfiles.find { it.id == id } ?: error("Обновите каталог")
        repository.validateProfiles(listOf(profile))
        repository.edit { value ->
            require(value.profiles.none { it.id == id || ProfileImporter.identity(it) == ProfileImporter.identity(profile) }) { "Узел уже добавлен" }
            value.copy(profiles = value.profiles + profile.copy(source = "public"))
        }; "Публичный узел добавлен. Назначьте его маршруту явно."
    }
    override suspend fun addBestPublicGroup() = mutation {
        check(!diagnosticBusy && tuningJob?.isCompleted != false && transferJob?.isCompleted != false) { "Дождитесь завершения текущей проверки" }
        check(!catalog.busy) { "Дождитесь завершения операции с каталогом" }
        require(controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING, RuntimePhase.STOPPING)) { "Для проверки новых публичных узлов сначала выключите VPN" }
        require(catalogProfiles.isNotEmpty()) { "Сначала обновите каталог" }
        diagnosticBusy = true
        catalog = catalog.copy(busy = true, checked = 0, planned = minOf(8, catalogProfiles.size)); changed()
        try {
            val results = repository.probe(extra = catalogProfiles)
            catalogHealth = catalogHealth.toMutableMap().apply {
                results.forEach { sample -> val id = sample.tag.removePrefix("p-"); this[id] = (this[id] ?: ProbeHealth()).measured(sample.delayMs, sample.checkedAt) }
            }
            catalog = catalog.copy(checked = results.size)
            val good = results.filter { it.delayMs != null }.sortedBy { it.delayMs }.take(5).mapNotNull { sample -> catalogProfiles.find { "p-${it.id}" == sample.tag } }
            require(good.isNotEmpty()) { "В проверенной выборке нет работающих узлов. Повторная проверка возьмёт следующие." }
            repository.validateProfiles(good)
            repository.edit { value ->
                val all = value.profiles.toMutableList()
                val members = good.map { profile -> all.find { ProfileImporter.identity(it) == ProfileImporter.identity(profile) }?.id ?: profile.id.also { all.add(profile.copy(source = "public")) } }
                value.copy(profiles = all, groups = value.groups + TunnelGroup(name = "Публичные узлы ${value.groups.count { it.name.startsWith("Публичные узлы") } + 1}", members = members))
            }; "Создана группа из ${good.size} узлов, прошедших реальную HTTPS-проверку; проверено ${results.size}."
        } finally { diagnosticBusy = false; catalog = catalog.copy(busy = false); changed() }
    }
    override suspend fun diagnose(target: String) = action {
        check(!diagnosticBusy && tuningJob?.isCompleted != false && transferJob?.isCompleted != false) { "Дождитесь завершения текущей проверки" }
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
        check(!diagnosticBusy && tuningJob?.isCompleted != false && transferJob?.isCompleted != false) { "Дождитесь завершения текущей проверки" }
        diagnosticBusy = true
        try {
            val measured = repository.probe(); require(measured.isNotEmpty()) { "Нет доступных для проверки профилей в текущем режиме" }
            "Проверено: ${measured.size}; ответили: ${measured.count { it.delayMs != null }}. Остальные профили не оценивались."
        } finally { diagnosticBusy = false; changed() }
    }
    override fun cancelTransfer() {
        transferJob?.cancel(); transfer = transfer?.copy(running = false); changed()
    }
    override suspend fun measureTransfer(profileId: String, uploadEndpoint: String?): UiResult {
        // A cancelled coroutine still owns native cleanup until it completes. Starting the
        // next one earlier lets its predecessor's finally clear a replacement job/UI state.
        if (transferJob?.isCompleted == false || tuningJob?.isCompleted == false || diagnosticBusy) return UiResult(false, "Дождитесь завершения текущей проверки")
        val task = viewModelScope.async(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]!!
            try { action {
                val data = repository.ready()
                val profile = data.profiles.find { it.id == profileId && !it.revoked && !it.subscriptionMissing && it.source == "personal" }
                    ?: error("Выберите доступный личный профиль")
                val phase = controller.status.value.phase
                check(phase in setOf(RuntimePhase.ON, RuntimePhase.OFF) && !repository.applying.value) { "Дождитесь переключения VPN" }
                val session = controller.sessionGeneration(); val intent = repository.intentGeneration()
                val physical = network.physicalNetwork()?.networkHandle ?: error("Нет физической сети")
                fun current() = transferJob === owner && owner.isActive && controller.isSessionGeneration(session) && controller.status.value.phase == phase &&
                    repository.intentGeneration() == intent && repository.data.value?.revision == data.revision &&
                    network.physicalNetwork()?.networkHandle == physical && !repository.applying.value
                if (phase == RuntimePhase.ON) require(profileId in repository.compiled.value?.loadedProfiles.orEmpty()) {
                    "Профиль не загружен в текущий VPN. Для отдельной проверки выключите VPN."
                }
                transfer = TransferUi(profileId, running = true); changed()
                val down = try {
                    val reply = if (phase == RuntimePhase.ON) controller.fetchOutbound("p-$profileId", TransferProof.URL,
                        TransferProof.TIMEOUT_MS, TransferProof.MAX_BYTES, session)
                    else {
                        val config = withContext(Dispatchers.Default) { RoutingCompiler.compile(data, app.packageName, checkerProfiles = listOf(profile)) }
                        controller.fetchCheckOutbound(config.json, "p-$profileId", TransferProof.URL, TransferProof.TIMEOUT_MS, TransferProof.MAX_BYTES)
                    }
                    TransferProof.download(reply)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { TransferObservation("fail", reason = "network") }
                check(current()) { "Сеть или профиль изменились; результат проверки не сохранён" }
                transfer = transfer?.copy(download = down.toUi()); changed()
                val endpoint = uploadEndpoint?.trim()?.takeIf(String::isNotBlank)
                val up = when {
                    endpoint == null -> TransferObservation("not_measured", reason = "no_endpoint")
                    phase != RuntimePhase.ON || data.settings.serviceVia != profileId ||
                        controller.groups.value.none { it.tag == "rt-service" && it.selected == "p-$profileId" } ->
                        TransferObservation("not_measured", reason = "service_path")
                    else -> try {
                        val vpn = network.vpnNetwork() ?: error("Сеть VPN недоступна")
                        network.uploadCheck(endpoint, vpn)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { TransferObservation("fail", reason = "network") }
                }
                check(current()) { "Сеть или профиль изменились; результат проверки не сохранён" }
                val at = System.currentTimeMillis()
                transfer = transfer?.copy(running = false, checkedAt = at, upload = up.toUi())
                app.evidence.recordTransfer(at, down, up)
                "Проверка передачи завершена; результаты получения и отправки показаны отдельно"
            } } finally {
                if (transferJob === owner) { transfer = transfer?.copy(running = false); transferJob = null; changed() }
            }
        }
        transferJob = task; task.start(); return task.await()
    }
    private fun TransferObservation.toUi() = TransferDirectionUi(state, bytes, elapsedMs, reason)
    override suspend fun readLogs() = action { changed(); "Журнал обновлён" }
    override suspend fun recover() = action {
        check(!repository.requestedOpen.value && controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING)) {
            "Сначала выключите VPN главным переключателем. Восстановление не должно неожиданно прерывать соединение."
        }
        disconnect(); withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR } }
        repository.reload(); repository.ready(); "Служба остановлена, защищённое хранилище прочитано. Можно подключаться снова."
    }
    override suspend fun saveSettings(patch: SettingsPatch) = mutation {
        repository.edit { value -> value.copy(settings = value.settings.copy(lanDirect = patch.lanDirect ?: value.settings.lanDirect,
            ruDirect = patch.ruDirect ?: value.settings.ruDirect, autoConnect = patch.autoConnect ?: value.settings.autoConnect,
            notifications = patch.notifications ?: value.settings.notifications)) }; "Настройки сохранены"
    }
    override suspend fun setSystemDnsPath(viaId: String?) = mutation {
        repository.edit { value ->
            require(viaId == null || validPath(value, viaId)) { "Выберите доступный путь для общего DNS" }
            value.copy(settings = value.settings.copy(systemDnsVia = viaId))
        }
        "Общий DNS сохранён"
    }

    override suspend fun setServicePath(id: String) = mutation {
        repository.edit { data ->
            require(id == DIRECT || data.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing && it.source == "personal" }) {
                "Выберите доступный личный туннель или прямое подключение"
            }
            data.copy(settings = data.settings.copy(serviceVia = id))
        }
        "Путь служебных загрузок сохранён"
    }

    /** Binding to the owned VPN network prevents an OFF/revoke from retrying over the physical default route. */
    private suspend fun fetchService(url: String, maxBytes: Int = MAX_IMPORT_BYTES): String {
        val data = repository.ready(); val via = data.settings.serviceVia
        if (via == DIRECT) return network.fetch(url, maxBytes)
        val profile = data.profiles.find { it.id == via && it.source == "personal" && !it.revoked && !it.subscriptionMissing }
            ?: error("Служебный путь недоступен. Выберите другой в настройках.")
        val session = controller.sessionGeneration(); val intent = repository.intentGeneration()
        fun current() = controller.isSessionGeneration(session) && controller.status.value.phase == RuntimePhase.ON &&
            repository.intentGeneration() == intent && repository.data.value?.revision == data.revision &&
            controller.groups.value.any { it.tag == "rt-service" && it.selected == "p-${profile.id}" }
        check(current()) { "Для служебной загрузки включите VPN с выбранным личным путём; прямой резерв не используется." }
        val vpn = network.vpnNetwork() ?: error("Сеть VPN ещё не готова")
        return coroutineScope {
            val owner = currentCoroutineContext()[Job]!!
            val guard = launch { controller.status.first { it.phase != RuntimePhase.ON }; owner.cancel(CancellationException("VPN выключен")) }
            try {
                val body = network.fetch(url, maxBytes, physical = false, boundNetwork = vpn)
                check(current()) { "Состояние или путь изменились во время загрузки; результат не сохранён" }
                body
            } finally { guard.cancel() }
        }
    }

    override suspend fun clearDiagnosticHistory() = action { app.evidence.clear(); "Сохранённая диагностика удалена" }

    override fun cancelTuning() {
        tuningProof = null; tuningJob?.cancel()
        tuning = tuning?.copy(running = false, canApply = false, message = "Подбор отменён или состояние VPN изменилось")
        changed()
    }

    override suspend fun runTuning(id: String): UiResult {
        if (tuningJob?.isCompleted == false || transferJob?.isCompleted == false || diagnosticBusy) return UiResult(false, "Дождитесь завершения текущей проверки")
        val task = viewModelScope.async(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]!!
            try { action {
                val data = repository.ready(); val profile = data.profiles.find { it.id == id } ?: error("Профиль удалён")
                check(!repository.requestedOpen.value && controller.status.value.phase == RuntimePhase.OFF && !repository.applying.value) {
                    "Для подбора вариантов выключите VPN. Действующие соединения не изменяются."
                }
                val choices = ProfileTuning.variants(profile); require(choices.isNotEmpty()) { "Для этого профиля нет совместимых вариантов" }
                val physical = network.physicalNetwork()?.networkHandle ?: error("Нет физической сети")
                val token = repository.intentGeneration()
                val proof = TuningProof(id, ProfileTuning.signature(profile), physical, token, data.revision, System.currentTimeMillis(), emptySet())
                fun current() = tuningJob === owner && owner.isActive && proof.current(repository.data.value?.profiles?.find { it.id == id }, network.physicalNetwork()?.networkHandle,
                    repository.intentGeneration(), repository.data.value?.revision ?: -1, System.currentTimeMillis()) &&
                    !repository.requestedOpen.value && controller.status.value.phase == RuntimePhase.OFF && !repository.applying.value
                tuningProof = null
                tuning = TunnelTuningUi(id, running = true, networkLabel = network.networkLabel(),
                    variants = choices.map { TuneVariantUi(it.id, it.label, it.detail) })
                changed()
                val passed = mutableSetOf<String>()
                withTimeout(60_000) {
                    for (choice in choices) {
                        currentCoroutineContext().ensureActive(); check(current()) { "Сеть, профиль или состояние VPN изменились" }
                        val result = try {
                            val config = withContext(Dispatchers.Default) { RoutingCompiler.compile(data, app.packageName, checkerProfiles = listOf(choice.profile)) }
                            TransferProof.download(controller.fetchCheckOutbound(config.json, "p-$id", TransferProof.URL,
                                TransferProof.TIMEOUT_MS, TransferProof.MAX_BYTES))
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { TransferObservation("fail", reason = "network") }
                        check(current()) { "Сеть, профиль или состояние VPN изменились; результат устарел" }
                        if (result.state == "pass") passed += choice.id
                        tuning = tuning?.copy(variants = tuning!!.variants.map { value -> if (value.id == choice.id) value.copy(
                            result = if (result.state == "pass") ObservationResult.OK else ObservationResult.FAILED,
                            latencyMs = result.elapsedMs?.toDouble()) else value })
                        changed()
                        if (choice.id == ProfileTuning.ORIGINAL && result.state == "pass") break
                    }
                }
                check(current()) { "Проверка устарела" }
                val at = System.currentTimeMillis(); tuningProof = proof.copy(checkedAt = at, successful = passed)
                tuning = tuning?.copy(running = false, checkedAt = at, canApply = passed.any { it != ProfileTuning.ORIGINAL }, message =
                    if (ProfileTuning.ORIGINAL in passed) "Исходный профиль полностью загрузил контрольный текст. Изменения не нужны."
                    else if (passed.isEmpty()) "Контрольная загрузка не прошла. Это не определяет причину блокировки; исходный профиль сохранён."
                    else "Получение данных проверено в этой сети. Отправка не измерялась. Выберите вариант для явного применения.")
                "Проверка вариантов завершена"
            } } catch (_: TimeoutCancellationException) {
                if (tuningJob === owner) tuningProof = null
                UiResult(false, "Подбор остановлен по лимиту 60 секунд")
            } finally {
                if (tuningJob === owner) { tuning = tuning?.copy(running = false); tuningJob = null; changed() }
            }
        }
        tuningJob = task; task.start(); return task.await()
    }

    override suspend fun applyTuning(id: String, variantId: String) = mutation {
        val proof = tuningProof ?: error("Повторите проверку в текущей сети")
        require(variantId != ProfileTuning.ORIGINAL && variantId in proof.successful) { "Этот вариант не прошёл проверку" }
        repository.edit(beforeCommit = {
            val current = repository.data.value
            require(tuningProof === proof && controller.status.value.phase == RuntimePhase.OFF && !repository.requestedOpen.value &&
                current != null && proof.current(current.profiles.find { it.id == id }, network.physicalNetwork()?.networkHandle,
                    repository.intentGeneration(), current.revision, System.currentTimeMillis())) {
                "Проверка устарела: изменились сеть, профиль или состояние VPN"
            }
        }) { data ->
            val profile = data.profiles.find { it.id == id }
            require(proof.current(profile, network.physicalNetwork()?.networkHandle, repository.intentGeneration(), data.revision, System.currentTimeMillis())) {
                "Проверка устарела: изменились сеть, профиль или состояние VPN"
            }
            val original = profile!!; val variant = ProfileTuning.variants(original).first { it.id == variantId }
            val retained = original.tuning?.takeIf { it.appliedSignature == ProfileTuning.signature(original) }
            val next = variant.profile.copy(tuning = StoredProfileTune(variant.id, variant.label,
                retained?.originalConfig ?: original.config, retained?.originalProtocol ?: original.protocol,
                ProfileTuning.signature(variant.profile), proof.network.toString(), tuning?.networkLabel.orEmpty(), proof.checkedAt))
            data.copy(profiles = data.profiles.map { if (it.id == id) next else it })
        }
        tuningProof = null; tuning = tuning?.copy(canApply = false, selectedVariantId = variantId)
        "Проверенный вариант сохранён; исходные параметры доступны для возврата"
    }

    override suspend fun resetTuning(id: String) = mutation {
        repository.edit { data ->
            val profile = data.profiles.find { it.id == id } ?: error("Профиль удалён")
            val stored = profile.tuning ?: error("Нет сохранённого варианта")
            require(stored.appliedSignature == ProfileTuning.signature(profile)) { "Профиль изменился после подбора; старые параметры не применены" }
            val original = profile.copy(config = stored.originalConfig, protocol = stored.originalProtocol, tuning = null)
            data.copy(profiles = data.profiles.map { if (it.id == id) original else it })
        }
        tuningProof = null; tuning = null
        "Исходные параметры восстановлены"
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
            appendLine("Saved session evidence (no raw logs, endpoints or configuration):")
            appendLine(app.evidence.report.value ?: "Not available")
        }
    }
}
