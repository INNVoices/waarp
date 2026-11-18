// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import local.waarp.android.i18n.localized

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
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
    private var catalogHealthNetwork: Long? = null
    private var diagnostic: DiagnosticUi? = null
    private var message: UiMessage? = null
    private var diagnosticBusy = false
    private var diagnosticJob: Deferred<UiResult>? = null
    private var diagnosticIdentity: ConnectionCheckIdentity? = null
    private var diagnosticContext: ConnectionProofContext? = null
    private var connectionProof: ConnectionProof? = null
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
                val restored = withContext(Dispatchers.Default) { PublicCatalog.merge(cached.profiles, emptyList()) }
                if (catalogProfiles.isEmpty()) {
                    catalogProfiles = restored
                    catalog = CatalogUi(total = catalogProfiles.size, updatedAtMillis = cached.revision)
                    changed()
                }
            }
        }
        viewModelScope.launch {
            while (true) {
                _state.subscriptionCount.first { it > 0 }
                delay(15_000)
                if (catalogHealth.isNotEmpty() || connectionProof != null) changed() // Expire observations even while the VPN is OFF.
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
        catalogHealth = PublicCatalog.freshHealth(catalogHealth, catalogHealthNetwork,
            network.physicalNetwork()?.networkHandle, System.currentTimeMillis())
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
        val routeProofCurrent = connectionProof?.let { proof -> connectionContext()?.let { actual ->
            proof.current(actual, SystemClock.elapsedRealtime(), repository.data.value?.profiles.orEmpty()) } } == true
        _state.value = projected.copy(diagnostic = diagnostic?.let { result ->
            if (diagnosticContext != null && diagnosticContext != connectionContext() || result.proofId != null && !routeProofCurrent)
                result.copy(stale = true, proofId = null, suggestedViaId = null) else result
        }, tuning = tuning?.let { it.copy(canApply = it.canApply && proofCurrent) },
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
        action(block).also { result -> if (!result.ok) notifyUser(result.message ?: localized("MobileViewModel.fe387cf42a5d", "Изменения не сохранены"), true) }
    }.await()
    private fun friendly(error: Throwable): String {
        val text = error.message.orEmpty()
        return if (text.any { it in 'А'..'я' || it == 'ё' } && !Regex("://|[A-Za-z0-9+/]{32,}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-").containsMatchIn(text)) text.take(300)
        else when (error) {
            is java.io.IOException -> NetworkTools.safeError(error)
            else -> localized("MobileViewModel.726d42edde4e", "Операция не выполнена. Проверьте параметры и состояние VPN.")
        }
    }
    override fun connect() {
        cancelDiagnostic(); cancelTuning(); cancelTransfer()
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
        if (!granted) { repository.consentCancelled(token); notifyUser(localized("MobileViewModel.07e3d015f260", "Разрешение VPN не получено"), true); return }
        viewModelScope.launch { val result = action { repository.completeConnect(token); null }; if (!result.ok) notifyUser(result.message.orEmpty(), true) }
    }
    override fun disconnect() { cancelDiagnostic(); cancelTuning(); cancelTransfer(); pendingConsentToken = null; pendingConsentIntent = null; repository.disconnect() }
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
        cancelDiagnostic(); cancelTuning(); cancelTransfer(); imports.clearSensitiveInput(); super.onCleared()
    }
    override fun requestClipboardImport() = event(MobileEvent.ClipboardImport)
    override fun openSystemVpnSettings() = event(MobileEvent.SystemVpnSettings)
    override fun shareDiagnostics() = event(MobileEvent.ShareDiagnostics)
    override suspend fun refresh() = action { repository.reload(); repository.ready(); localized("MobileViewModel.11260aabd9ca", "Данные обновлены") }
    @Suppress("DEPRECATION")
    override suspend fun refreshApps() = action {
        check(!appScanBusy) { localized("MobileViewModel.7108b632a1b0", "Список приложений уже обновляется") }; appScanBusy = true
        try {
            apps = withContext(Dispatchers.IO) {
                val pm = app.packageManager
                pm.getPackagesHoldingPermissions(arrayOf(android.Manifest.permission.INTERNET), 0).mapNotNull { info ->
                    val ai = info.applicationInfo ?: return@mapNotNull null
                    if (info.packageName == app.packageName) return@mapNotNull null
                    AppUi(info.packageName, pm.getApplicationLabel(ai).toString(), ai.uid, ai.flags and ApplicationInfo.FLAG_SYSTEM != 0,
                        versionCode = info.longVersionCode)
                }.sortedWith(compareBy<AppUi> { it.system }.thenBy { it.name.lowercase() })
            }; localized("MobileViewModel.3e1c4830c329", "Приложений: {arg1}", apps.size)
        } finally { appScanBusy = false }
    }
    private fun validPath(data: AppData, id: String): Boolean = id == DIRECT || (id == AUTO && data.profiles.any { !it.revoked && !it.subscriptionMissing && it.source != "public" }) ||
        data.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing } || data.groups.any { group -> group.id == id && group.members.any { member -> data.profiles.any { it.id == member && !it.revoked && !it.subscriptionMissing } } }
    override suspend fun setDefaultRoute(viaId: String) = mutation {
        repository.edit { value ->
            require(validPath(value, viaId)) { localized("MobileViewModel.79639e76c85b", "Выбранный путь недоступен") }
            value.copy(settings = value.settings.copy(defaultVia = viaId, lastWholeDeviceVia = if (viaId == DIRECT) value.settings.lastWholeDeviceVia else viaId))
        }; localized("MobileViewModel.35b30c71cd07", "Общий маршрут сохранён")
    }
    override suspend fun saveRoute(route: RouteDraft) = mutation {
        // Repository edit transforms run on Default. Capture the current scan
        // on Main so a concurrent refresh never exposes mutable ViewModel state.
        val availableApps = apps
        val recommendation = route.recommendationProofId?.let { id ->
            connectionProof?.takeIf { it.id == id } ?: error(localized("MobileViewModel.2f19181e0597", "Результат проверки устарел. Проверьте соединение ещё раз или выберите путь вручную."))
        }
        repository.edit(beforeCommit = {
            recommendation?.let { proof ->
                val actual = connectionContext()
                check(actual != null && proof.current(actual, SystemClock.elapsedRealtime(), repository.data.value?.profiles.orEmpty()) &&
                    proof.allows(route.id, routeKind(route.kind), routeMatch(route), route.connectionUse, route.viaId)) {
                    localized("MobileViewModel.ac6d5a3efafa", "Сеть, маршрут или профиль изменились. Проверьте соединение ещё раз или выберите путь вручную.")
                }
            }
        }) { value ->
            require(route.name.isNotBlank() && route.name.length <= 80) { localized("MobileViewModel.87410bb08367", "Укажите название до 80 символов") }
            require(validPath(value, route.viaId)) { localized("MobileViewModel.f3fc0eb82c54", "Выбранный путь недоступен") }
            val fallback = route.fallbackViaId?.takeIf { route.viaId != DIRECT && it != route.viaId }
            require(fallback == null || (fallback != DIRECT && validPath(value, fallback))) { localized("MobileViewModel.8e42a4cc28b1", "Резерв должен быть доступным туннелем или группой") }
            val kind = when (route.kind) { RouteKind.APP -> "app"; RouteKind.SERVICE -> "preset"; RouteKind.CUSTOM -> "custom" }
            val match = when (route.kind) {
                RouteKind.APP -> route.packageName?.also { name -> require(availableApps.any { it.packageName == name }) { localized("MobileViewModel.806cb0837884", "Приложение не найдено") } }
                RouteKind.SERVICE -> route.presetId?.also { id -> require(Presets.all.any { it.id == id }) { localized("MobileViewModel.78c775fa2e9a", "Сервис не найден") } }
                RouteKind.CUSTOM -> route.selector?.trim()?.also { text -> require(text.length <= 16_384) }
            } ?: error(localized("MobileViewModel.9fb76bf2c33a", "Не указана цель маршрута"))
            val id = route.id ?: newId("r-")
            if (route.id != null) require(value.routes.any { it.id == id }) { localized("MobileViewModel.5bda91b8edb9", "Маршрут уже удалён") }
            val next = TrafficRoute(id, ProfileImporter.name(route.name), kind, match, route.viaId, fallback, route.enabled, ConnectionUses.normalize(route.connectionUse))
            value.copy(routes = if (route.id == null) value.routes + next else value.routes.map { if (it.id == id) next else it })
        }; localized("MobileViewModel.aa27dea59b72", "Маршрут сохранён")
    }
    override suspend fun setRouteEnabled(id: String, enabled: Boolean) = mutation {
        repository.edit { value -> require(value.routes.any { it.id == id }); value.copy(routes = value.routes.map { if (it.id == id) it.copy(enabled = enabled) else it }) }; null
    }
    override suspend fun deleteRoute(id: String) = mutation { repository.edit { it.copy(routes = it.routes.filterNot { route -> route.id == id }) }; localized("MobileViewModel.699622b556e4", "Маршрут удалён") }
    override suspend fun importText(text: String, name: String) = mutation {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_IMPORT_BYTES) { localized("MobileViewModel.ae388ef6e796", "Конфиг слишком большой: максимум 1 МБ") }
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
                added = fresh.size; require(added > 0) { localized("MobileViewModel.9b9fe93dfe4b", "Эти профили уже добавлены") }; value.copy(profiles = value.profiles + fresh)
            }
        }; localized("MobileViewModel.378bf3f75d2d", "Сохранено профилей: {arg1}{arg2}", added, if (imported.skipped > 0) localized("MobileViewModel.3bd235aee4a7", "; пропущено: {arg1}", imported.skipped) else "")
    }
    override suspend fun createWireGuard(draft: WireGuardDraft) = mutation {
        require(listOf(draft.name, draft.address, draft.endpoint, draft.serverPublicKey).all { it.isNotBlank() && it.length <= 256 && !it.contains(Regex("[\\r\\n]")) }) { localized("MobileViewModel.93c4b935eb4d", "Заполните данные сервера без переносов строк") }
        val keys = controller.generateWireGuardKeyPair()
        val config = "[Interface]\nPrivateKey = ${keys.privateKey}\nAddress = ${draft.address.trim()}\n[Peer]\nPublicKey = ${draft.serverPublicKey.trim()}\nEndpoint = ${draft.endpoint.trim()}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n"
        val profile = withContext(Dispatchers.Default) { ProfileImporter.wireGuard(config, draft.name).copy(clientPublicKey = keys.publicKey) }
        repository.validateProfiles(listOf(profile)); repository.edit { it.copy(profiles = it.profiles + profile) }
        localized("MobileViewModel.7ca622e5a5f3", "Профиль создан. Добавьте публичный ключ клиента в настройки вашего сервера.")
    }
    override suspend fun renameTunnel(id: String, name: String) = mutation {
        require(name.isNotBlank() && name.length <= 80) { localized("MobileViewModel.47f291833646", "Укажите название до 80 символов") }
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error(localized("MobileViewModel.5b6be2ebdd26", "Туннель уже удалён"))
            require(old.source !in setOf("managed", "public")) { localized("MobileViewModel.a5e570340615", "Именем управляет источник") }
            value.copy(profiles = value.profiles.map { if (it.id == id) it.copy(name = ProfileImporter.name(name)) else it })
        }; localized("MobileViewModel.e5a0e4a7d259", "Название сохранено")
    }
    override suspend fun replaceTunnel(id: String, text: String) = mutation {
        val result = withContext(Dispatchers.Default) { ProfileImporter.parse(text) }
        require(result.profiles.size == 1 && result.skipped == 0) { localized("MobileViewModel.b0edebefcbce", "Для замены нужен ровно один профиль") }
        val profile = result.profiles.single(); repository.validateProfiles(listOf(profile))
        repository.edit { value ->
            val old = value.profiles.find { it.id == id } ?: error(localized("MobileViewModel.2a2c0c1e9b86", "Туннель уже удалён"))
            require(old.source !in setOf("managed", "public", "warp")) { localized("MobileViewModel.bdb29be138eb", "Профилем управляет источник") }
            value.copy(profiles = value.profiles.map { if (it.id == id) profile.copy(id = old.id, name = old.name, addedAt = old.addedAt) else it })
        }; localized("MobileViewModel.76d4ae1e1fc5", "Профиль заменён; маршруты сохранили привязку")
    }
    private fun reassign(data: AppData, removed: String, replacement: String?): AppData {
        if (replacement == null) return data
        require(replacement != removed && validPath(data, replacement)) { localized("MobileViewModel.48d715b05164", "Выберите доступную замену") }
        if (data.settings.serviceVia == removed) require(replacement == DIRECT || data.profiles.any {
            it.id == replacement && it.source == "personal" && !it.revoked && !it.subscriptionMissing
        }) { localized("MobileViewModel.933db02a58af", "Для служебных загрузок выберите личный туннель или прямой путь; группу использовать нельзя") }
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
            val old = value.profiles.find { it.id == id } ?: error(localized("MobileViewModel.61882ba4fc48", "Туннель уже удалён"))
            require(old.source != "managed") { localized("MobileViewModel.cbbb6e1668af", "Туннелем управляет команда") }
            val updated = reassign(value, id, replacementId)
            val result = updated.copy(profiles = updated.profiles.filterNot { it.id == id }, groups = updated.groups.map { group ->
                group.copy(members = group.members.flatMap { member -> if (member != id) listOf(member) else listOfNotNull(replacementId?.takeIf { replacement -> updated.profiles.any { it.id == replacement } }) }.distinct())
            })
            require(replacementId == null || validPath(result, replacementId)) { localized("MobileViewModel.775365be8646", "После удаления выбранная группа останется без участников; выберите другой путь") }
            result
        }; if (replacementId == null) localized("MobileViewModel.6ecec87c785b", "Туннель удалён. Его неназначенные маршруты останутся заблокированы.") else localized("MobileViewModel.82d8309597c2", "Туннель удалён, пути переназначены")
    }
    override suspend fun refreshSubscription(id: String) = action {
        val profile = repository.ready().profiles.find { it.id == id } ?: error(localized("MobileViewModel.a104760b11ad", "Туннель уже удалён"))
        val subscription = profile.subscription ?: error(localized("MobileViewModel.981412e219aa", "Профиль не связан с подпиской"))
        val body = fetchService(subscription)
        val incoming = withContext(Dispatchers.Default) { ProfileImporter.parse(body) }
        require(incoming.skipped == 0) { localized("MobileViewModel.c5a1c17b1bf3", "Подписка прочитана не полностью. Сохранённые профили оставлены без изменений.") }
        repository.validateProfiles(incoming.profiles)
        var summary = ""
        repository.edit { value ->
            require(value.profiles.any { it.id == id && it.subscription == subscription }) { localized("MobileViewModel.a3fad785ea47", "Подписка изменилась во время загрузки") }
            val merged = Subscriptions.reconcile(value.profiles, incoming, subscription)
            summary = localized("MobileViewModel.b4259acb8b6e", "Обновлено: {arg1}; добавлено: {arg2}; исчезло у источника: {arg3}", merged.updated, merged.added, merged.missing)
            value.copy(profiles = merged.profiles)
        }; summary
    }
    override suspend fun saveGroup(group: GroupDraft) = mutation {
        repository.edit { value ->
            require(group.name.isNotBlank() && group.name.length <= 80 && group.members.isNotEmpty()) { localized("MobileViewModel.02cb6919b6ea", "Укажите название и участников") }
            require(group.members.distinct().size == group.members.size && group.members.all { id -> value.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing } }) { localized("MobileViewModel.6fc516e103ae", "В группе есть недоступный участник") }
            require(group.id != AUTO) { localized("MobileViewModel.049c33ef0dc0", "Авто формируется из личных туннелей") }
            val id = group.id ?: newId("g-")
            if (group.id != null) require(value.groups.any { it.id == id }) { localized("MobileViewModel.4dbdf4ff74d3", "Группа уже удалена") }
            val next = TunnelGroup(id, ProfileImporter.name(group.name), if (group.policy == GroupPolicy.FIRST) "first" else "fastest", group.members)
            value.copy(groups = if (group.id == null) value.groups + next else value.groups.map { if (it.id == id) next else it })
        }; localized("MobileViewModel.9edbcabd2a79", "Группа сохранена")
    }
    override suspend fun deleteGroup(id: String, replacementId: String?) = mutation {
        require(id != AUTO) { localized("MobileViewModel.7c1c630b2305", "Авто нельзя удалить") }
        repository.edit { value -> require(value.groups.any { it.id == id }); reassign(value, id, replacementId).let { it.copy(groups = it.groups.filterNot { group -> group.id == id }) } }
        localized("MobileViewModel.861dc063337b", "Группа удалена")
    }
    override suspend fun refreshCatalog() = action {
        check(!catalog.busy) { localized("MobileViewModel.899b7b2fa13f", "Каталог уже обновляется") }; catalog = catalog.copy(busy = true, error = null); changed()
        try {
            val data = repository.ready()
            val intent = repository.intentGeneration()
            val physical = network.physicalNetwork()?.networkHandle
            val result = network.catalog(::fetchPublicCatalog)
            check(repository.data.value?.revision == data.revision && repository.intentGeneration() == intent &&
                network.physicalNetwork()?.networkHandle == physical) { localized("MobileViewModel.673fe41c7f21", "Сеть или служебный путь изменились; предыдущий каталог сохранён") }
            if (result.profiles.isEmpty()) { catalog = catalog.copy(sources = result.sources, error = localized("MobileViewModel.f7d6dfcc6565", "Источники недоступны; предыдущий каталог сохранён")); error(localized("MobileViewModel.9730f2442824", "Не удалось обновить публичные источники")) }
            val fetchedAt = System.currentTimeMillis()
            val freshHealth = PublicCatalog.freshHealth(catalogHealth, catalogHealthNetwork, physical, fetchedAt)
            val protected = freshHealth.filterValues { it.healthy }.keys + data.profiles.filter { it.source == "public" && !it.revoked }.map { it.id }
            val blocked = data.profiles.filter { it.revoked || it.subscriptionMissing }.mapTo(HashSet(), ProfileImporter::identity)
            val merged = withContext(Dispatchers.Default) { PublicCatalog.merge(catalogProfiles, result.profiles, protected, blocked) }
            require(merged.isNotEmpty()) { localized("MobileViewModel.d608e9845c37", "Нет допустимых публичных узлов; предыдущий каталог сохранён") }
            catalogCache.write(AppData(profiles = merged, revision = fetchedAt))
            catalogProfiles = merged
            val currentIds = catalogProfiles.mapTo(HashSet()) { it.id }
            catalogHealth = freshHealth.filterKeys { it in currentIds }
            catalog = catalog.copy(sources = result.sources, total = merged.size, updatedAtMillis = fetchedAt, checked = 0, planned = 0)
            localized("MobileViewModel.7021c1490fca", "В пуле {arg1} публичных узлов; источников ответило {arg2} из {arg3}. Новые и устаревшие узлы требуют проверки в текущей сети.", merged.size, result.sources.count { it.ok }, result.sources.size)
        } finally { catalog = catalog.copy(busy = false); changed() }
    }
    override suspend fun addCatalogNode(id: String) = mutation {
        val profile = catalogProfiles.find { it.id == id } ?: error(localized("MobileViewModel.15e9d3f99d0a", "Обновите каталог"))
        repository.validateProfiles(listOf(profile))
        repository.edit { value ->
            require(value.profiles.none { it.id == id || ProfileImporter.identity(it) == ProfileImporter.identity(profile) }) { localized("MobileViewModel.93ef498a6abb", "Узел уже добавлен") }
            value.copy(profiles = value.profiles + profile.copy(source = "public"))
        }; localized("MobileViewModel.1e57d127d928", "Публичный узел добавлен. Назначьте его маршруту явно.")
    }
    override suspend fun addBestPublicGroup() = mutation {
        check(!diagnosticBusy && tuningJob?.isCompleted != false && transferJob?.isCompleted != false) { localized("MobileViewModel.d4b7ff7528b1", "Дождитесь завершения текущей проверки") }
        check(!catalog.busy) { localized("MobileViewModel.e8072077a8e8", "Дождитесь завершения операции с каталогом") }
        require(controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING, RuntimePhase.STOPPING)) { localized("MobileViewModel.12dfd8cb06a7", "Для проверки новых публичных узлов сначала выключите VPN") }
        require(catalogProfiles.isNotEmpty()) { localized("MobileViewModel.5d13a4643ba6", "Сначала обновите каталог") }
        diagnosticBusy = true
        catalog = catalog.copy(busy = true, checked = 0, planned = minOf(8, catalogProfiles.size)); changed()
        try {
            val physical = network.physicalNetwork()?.networkHandle ?: error(localized("MobileViewModel.bf651cc82e1e", "Нет физического подключения к сети"))
            val intent = repository.intentGeneration()
            val candidates = catalogProfiles
            val results = repository.probe(extra = candidates, preparePublic = network::preparePublicProbe)
            fun current() = network.physicalNetwork()?.networkHandle == physical && repository.intentGeneration() == intent &&
                controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING, RuntimePhase.STOPPING)
            check(current()) { localized("MobileViewModel.50c7214c6dd0", "Сеть или состояние VPN изменились; повторите проверку") }
            catalogHealth = PublicCatalog.freshHealth(catalogHealth, catalogHealthNetwork, physical, System.currentTimeMillis()).toMutableMap().apply {
                results.forEach { sample ->
                    val id = sample.tag.removePrefix("p-")
                    if (sample.checkedAt > 0) this[id] = (this[id] ?: ProbeHealth()).measured(sample.delayMs, sample.checkedAt)
                    else remove(id) // DNS/policy preflight skipped the probe; this is neither OK nor DOWN.
                }
            }
            catalogHealthNetwork = physical
            val measuredCount = results.count { it.checkedAt > 0 }
            catalog = catalog.copy(checked = measuredCount)
            val delays = results.mapNotNull { sample -> sample.delayMs?.let { sample.tag.removePrefix("p-") to it } }.toMap()
            val good = PublicCatalog.diverseBest(candidates, delays)
            require(good.isNotEmpty()) {
                if (measuredCount == 0) localized("MobileViewModel.01a5c7c25b36", "Узлы этой выборки не удалось безопасно проверить. Повторная проверка возьмёт следующие.")
                else localized("MobileViewModel.1fef8c539ce9", "В проверенной выборке нет работающих узлов. Повторная проверка возьмёт следующие.")
            }
            repository.validateProfiles(good)
            check(current()) { localized("MobileViewModel.50c7214c6dd0", "Сеть или состояние VPN изменились; повторите проверку") }
            repository.edit(beforeCommit = { check(current()) { localized("MobileViewModel.022cfbcd87b2", "Сеть или состояние VPN изменились; группа не сохранена") } }) { value ->
                val all = value.profiles.toMutableList()
                val members = good.map { profile -> all.find { ProfileImporter.identity(it) == ProfileImporter.identity(profile) }?.id ?: profile.id.also { all.add(profile.copy(source = "public")) } }
                val names = value.groups.mapTo(mutableSetOf()) { it.name }
                fun publicName(number: Int) = localized("MobileViewModel.fa90347a1c9d", "Публичные узлы {arg1}", number)
                val publicIds = all.filter { it.source == "public" }.mapTo(mutableSetOf()) { it.id }
                val first = value.groups.count { group ->
                    group.id.startsWith("g-public-") || (group.members.isNotEmpty() && group.members.all { it in publicIds })
                } + 1
                val name = generateSequence(first) { it + 1 }.map(::publicName).first { it !in names }
                value.copy(profiles = all, groups = value.groups + TunnelGroup(id = newId("g-public-"), name = name, members = members))
            }; localized("MobileViewModel.304baa4dfd76", "Создана группа из {arg1} разных серверов, ответивших на HTTPS-проверку в текущей сети; проверено {arg2}, пропущено {arg3}.", good.size, measuredCount, results.size - measuredCount)
        } finally { diagnosticBusy = false; catalog = catalog.copy(busy = false); changed() }
    }
    private fun routeKind(kind: RouteKind) = when (kind) { RouteKind.APP -> "app"; RouteKind.SERVICE -> "preset"; RouteKind.CUSTOM -> "custom" }
    private fun routeMatch(route: RouteDraft) = when (route.kind) {
        RouteKind.APP -> route.packageName.orEmpty()
        RouteKind.SERVICE -> route.presetId.orEmpty()
        RouteKind.CUSTOM -> route.selector.orEmpty().trim()
    }
    private fun connectionContext(): ConnectionProofContext? {
        val value = repository.data.value ?: return null
        val physical = network.physicalNetwork()?.networkHandle ?: return null
        val phase = controller.status.value.phase
        if (phase !in setOf(RuntimePhase.ON, RuntimePhase.OFF)) return null
        val selections = controller.groups.value.sortedBy { it.tag }.joinToString(";") { "${it.tag}=${it.selected}" }
        return ConnectionProofContext(value.revision, repository.intentGeneration(), controller.sessionGeneration(), physical, phase.name, selections)
    }
    override fun cancelDiagnostic(contextId: String?) {
        if (contextId != null && diagnostic?.contextId != contextId) return
        if (diagnosticJob?.isActive == true) {
            connectionProof = null
            diagnosticJob?.cancel()
            diagnostic = diagnostic?.copy(running = false, cancelled = true, proofId = null, suggestedViaId = null,
                conclusion = localized("MobileViewModel.759e585eae2a", "Проверка отменена. Маршрут сохранён без изменений."))
            changed()
        }
    }
    override suspend fun diagnose(target: String) = runDiagnostic(target, null)
    override suspend fun diagnoseRoute(request: RouteCheckRequest) = runDiagnostic(request.target, request)

    private suspend fun runDiagnostic(target: String, request: RouteCheckRequest?): UiResult {
        val requested = connectionContext()?.let { ConnectionCheckIdentity(target, request, it) }
        sharedConnectionCheck(diagnosticJob, diagnosticIdentity, requested, repository.applying.value)?.let {
            // Awaiting a duplicate does not own cancellation. Explicit cancel/owner disposal still does.
            return it.await()
        }
        if (diagnosticBusy || diagnosticJob?.isCompleted == false || tuningJob?.isCompleted == false || transferJob?.isCompleted == false)
            return UiResult(false, localized("MobileViewModel.672a4bb9058e", "Дождитесь завершения текущей проверки"))
        val task = viewModelScope.async(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]!!
            try { action {
                val uri = network.target(target)
                val data = repository.ready()
                val origin = connectionContext() ?: error(localized("MobileViewModel.85ec10fb9077", "Нет доступной физической сети или VPN ещё переключается"))
                val draft = request?.draft
                if (request != null && draft != null) {
                    require(request.contextId.isNotBlank() && request.contextId.length <= 80)
                    require(routeMatch(draft).isNotBlank()) { localized("MobileViewModel.ba582ed6ee4c", "Сначала выберите приложение или адрес маршрута") }
                    require(draft.id == null || data.routes.any { it.id == draft.id }) { localized("MobileViewModel.83fb3dba0d8a", "Маршрут уже удалён") }
                }
                fun current() = diagnosticJob === owner && owner.isActive && connectionContext() == origin && !repository.applying.value
                connectionProof = null
                diagnosticContext = origin
                diagnosticIdentity = ConnectionCheckIdentity(target, request, origin)
                diagnosticBusy = true
                val use = ConnectionUses.normalize(draft?.connectionUse)
                diagnostic = DiagnosticUi(uri.toString(), running = true, contextId = request?.contextId,
                    routeName = draft?.name, connectionUse = use, networkLabel = network.networkLabel())
                changed()
                // The route helper measures only explicitly available saved paths. The existing global
                // diagnostic retains its explicitly requested physical-network layered comparison.
                if (request == null) {
                    val layers = network.diagnose(uri.toString())
                    check(current()) { localized("MobileViewModel.e061d9bdfa6b", "Сеть изменилась во время проверки; повторите измерение") }
                    diagnostic = diagnostic?.copy(layers = layers); changed()
                }
                val actualRoute = draft?.id?.let { id -> data.routes.find { it.id == id } }
                val selectedVia = if (draft != null && actualRoute != null && actualRoute.via == draft.viaId && actualRoute.fallback == draft.fallbackViaId)
                    _state.value.routes.find { it.id == draft.id }?.effectiveViaId ?: draft.viaId
                else draft?.viaId
                val currentId = selectedVia?.let { via ->
                    if (via.startsWith("g-")) controller.groups.value.find { it.tag == "grp-$via" }?.selected?.removePrefix("p-") else via
                }
                val eligible = data.profiles.filter { !it.revoked && !it.subscriptionMissing &&
                    (it.source != "public" || it.id == currentId) &&
                    (origin.phase != RuntimePhase.ON.name || it.id in repository.compiled.value?.loadedProfiles.orEmpty()) }
                val candidates = eligible.sortedWith(compareBy<TunnelProfile> { it.id != currentId }
                    .thenBy { repository.health.value[it.id]?.latencyMs ?: Long.MAX_VALUE }.thenBy { it.id })
                    .take(ConnectionQuality.CANDIDATES)
                val samples = candidates.associate { it.id to mutableListOf<HttpPathSample>() }
                val planned = candidates.size * ConnectionQuality.ROUNDS
                diagnostic = diagnostic?.copy(plannedChecks = planned); changed()
                try {
                    withTimeout(ConnectionQuality.TOTAL_TIMEOUT_MS) {
                        repeat(ConnectionQuality.ROUNDS) {
                            for (profile in candidates) {
                                check(current()) { localized("MobileViewModel.e070b1374737", "Сеть или профиль изменились во время проверки; повторите измерение") }
                                val measured = repository.probe(url = uri.toString(), profileIds = setOf(profile.id), timeoutMs = ConnectionQuality.TIMEOUT_MS)
                                check(current()) { localized("MobileViewModel.e070b1374737", "Сеть или профиль изменились во время проверки; повторите измерение") }
                                measured.filter { it.tag == "p-${profile.id}" && it.checkedAt > 0 }.forEach {
                                    samples.getValue(profile.id).add(HttpPathSample(it.delayMs, it.checkedAt))
                                }
                                val rows = candidates.map { p -> ConnectionQuality.assess(p.id, samples.getValue(p.id)) }
                                diagnostic = diagnostic?.copy(paths = rows.map { assessment -> assessment.toUi(candidates) },
                                    completedChecks = rows.sumOf { it.attempted }); changed()
                            }
                        }
                    }
                } catch (_: TimeoutCancellationException) {
                    // The bounded operation ends with partial evidence; unstarted/cancelled checks stay unknown.
                }
                check(current()) { localized("MobileViewModel.e070b1374737", "Сеть или профиль изменились во время проверки; повторите измерение") }
                val rows = candidates.map { ConnectionQuality.assess(it.id, samples.getValue(it.id)) }
                val selected = rows.find { it.id == currentId }
                val positive = rows.filter { it.consistent }
                val suggested = if (request == null) positive.minByOrNull { it.medianMs ?: Double.MAX_VALUE }?.id
                    else ConnectionQuality.recommend(currentId, rows)
                val at = System.currentTimeMillis()
                val proof = if (request != null && draft != null && positive.isNotEmpty()) ConnectionProof(newId("check-"), request.contextId,
                    draft.id, routeKind(draft.kind), routeMatch(draft), use, uri.toString(), origin,
                    SystemClock.elapsedRealtime(), candidates.filter { p -> positive.any { it.id == p.id } }.associate { it.id to it.config }) else null
                connectionProof = proof
                diagnostic = diagnostic?.copy(paths = rows.map { it.toUi(candidates) }, suggestedViaId = suggested,
                    proofId = proof?.id, checkedAt = at, completedChecks = rows.sumOf { it.attempted }, conclusion = when {
                        suggested != null && request == null -> localized("MobileViewModel.41f09b623dd7", "«{arg1}» ответил в двух HTTPS-проверках. Можно создать маршрут для этого адреса.", candidates.find { it.id == suggested }?.name)
                        suggested != null -> localized("MobileViewModel.5e45a6cb2bf9", "Проверяемый путь не ответил в двух HTTPS-проверках; «{arg1}» ответил в обеих. Можно выбрать его для этого маршрута.", candidates.find { it.id == suggested }?.name)
                        selected != null && selected.responded > 0 -> localized("MobileViewModel.90eb869e9e8f", "Проверяемый путь ответил на HTTPS-проверку. Оснований менять его по этой проверке нет.")
                        candidates.isEmpty() -> if (origin.phase == RuntimePhase.ON.name) localized("MobileViewModel.517c349bbb43", "В текущем VPN нет доступных сохранённых профилей для этой проверки. Список и карта остаются доступны.")
                            else localized("MobileViewModel.562719fc4f2c", "Добавьте сохранённое подключение для сравнения путей.")
                        positive.isNotEmpty() -> localized("MobileViewModel.931a111f3e77", "Найдены пути, ответившие в обеих HTTPS-проверках. Выбранный путь не измерен полностью; сравнение с ним не подтверждено.")
                        rows.any { it.responded > 0 } -> localized("MobileViewModel.06b464c02ead", "Получены отдельные HTTPS-ответы; повторная проверка пути не подтверждена. Рекомендация пока недоступна.")
                        else -> localized("MobileViewModel.0ded5db20310", "Проверенная выборка не подтвердила доступность адреса. Причина отказа не установлена.")
                    })
                localized("MobileViewModel.e57502827580", "Диагностика завершена")
            } } catch (cancelled: CancellationException) {
                if (diagnosticJob === owner) diagnostic = diagnostic?.copy(cancelled = true, suggestedViaId = null, proofId = null,
                    conclusion = localized("MobileViewModel.e018759cb308", "Проверка отменена. Маршрут сохранён без изменений."))
                throw cancelled
            } finally {
                if (diagnosticJob === owner) {
                    diagnosticBusy = false
                    diagnosticIdentity = null
                    diagnostic = diagnostic?.copy(running = false,
                        stale = diagnostic?.cancelled != true && connectionProof?.let { proof -> connectionContext()?.let { proof.current(it, SystemClock.elapsedRealtime(), repository.data.value?.profiles.orEmpty()) } != true } == true)
                    changed()
                }
            }
        }
        diagnosticJob = task
        return try { task.await() } catch (cancelled: CancellationException) { task.cancel(); throw cancelled }
    }

    private fun HttpPathAssessment.toUi(profiles: List<TunnelProfile>) = DiagnosticPathUi(id,
        profiles.find { it.id == id }?.name ?: localized("MobileViewModel.855ab4066e41", "Туннель"), medianMs,
        when { responded > 0 -> ObservationResult.OK; attempted > 0 -> ObservationResult.FAILED; else -> ObservationResult.UNKNOWN },
        attempted, responded, spreadMs)
    override suspend fun probeTunnels() = action {
        check(!diagnosticBusy && tuningJob?.isCompleted != false && transferJob?.isCompleted != false) { localized("MobileViewModel.78220f207a7a", "Дождитесь завершения текущей проверки") }
        diagnosticBusy = true
        try {
            val measured = repository.probe(); require(measured.isNotEmpty()) { localized("MobileViewModel.dcaa1a76e2c3", "Нет доступных для проверки профилей в текущем режиме") }
            localized("MobileViewModel.d05fdd773ebd", "Проверено: {arg1}; ответили: {arg2}. Остальные профили не оценивались.", measured.size, measured.count { it.delayMs != null })
        } finally { diagnosticBusy = false; changed() }
    }
    override fun cancelTransfer() {
        transferJob?.cancel(); transfer = transfer?.copy(running = false); changed()
    }
    override suspend fun measureTransfer(profileId: String, uploadEndpoint: String?): UiResult {
        // A cancelled coroutine still owns native cleanup until it completes. Starting the
        // next one earlier lets its predecessor's finally clear a replacement job/UI state.
        if (transferJob?.isCompleted == false || tuningJob?.isCompleted == false || diagnosticBusy) return UiResult(false, localized("MobileViewModel.6c866f85ad21", "Дождитесь завершения текущей проверки"))
        val task = viewModelScope.async(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]!!
            try { action {
                val data = repository.ready()
                val profile = data.profiles.find { it.id == profileId && !it.revoked && !it.subscriptionMissing && it.source == "personal" }
                    ?: error(localized("MobileViewModel.64518bc25b69", "Выберите доступный личный профиль"))
                val phase = controller.status.value.phase
                check(phase in setOf(RuntimePhase.ON, RuntimePhase.OFF) && !repository.applying.value) { localized("MobileViewModel.6ca02721245f", "Дождитесь переключения VPN") }
                val session = controller.sessionGeneration(); val intent = repository.intentGeneration()
                val physical = network.physicalNetwork()?.networkHandle ?: error(localized("MobileViewModel.dbbf7b856145", "Нет физической сети"))
                fun current() = transferJob === owner && owner.isActive && controller.isSessionGeneration(session) && controller.status.value.phase == phase &&
                    repository.intentGeneration() == intent && repository.data.value?.revision == data.revision &&
                    network.physicalNetwork()?.networkHandle == physical && !repository.applying.value
                if (phase == RuntimePhase.ON) require(profileId in repository.compiled.value?.loadedProfiles.orEmpty()) {
                    localized("MobileViewModel.2b5dcaa5bcda", "Профиль не загружен в текущий VPN. Для отдельной проверки выключите VPN.")
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
                check(current()) { localized("MobileViewModel.e9e3ec3c842b", "Сеть или профиль изменились; результат проверки не сохранён") }
                transfer = transfer?.copy(download = down.toUi()); changed()
                val endpoint = uploadEndpoint?.trim()?.takeIf(String::isNotBlank)
                val up = when {
                    endpoint == null -> TransferObservation("not_measured", reason = "no_endpoint")
                    phase != RuntimePhase.ON || data.settings.serviceVia != profileId ||
                        controller.groups.value.none { it.tag == "rt-service" && it.selected == "p-$profileId" } ->
                        TransferObservation("not_measured", reason = "service_path")
                    else -> try {
                        val vpn = network.vpnNetwork() ?: error(localized("MobileViewModel.00decf0edfb8", "Сеть VPN недоступна"))
                        network.uploadCheck(endpoint, vpn)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { TransferObservation("fail", reason = "network") }
                }
                check(current()) { localized("MobileViewModel.e9e3ec3c842b", "Сеть или профиль изменились; результат проверки не сохранён") }
                val at = System.currentTimeMillis()
                transfer = transfer?.copy(running = false, checkedAt = at, upload = up.toUi())
                app.evidence.recordTransfer(at, down, up)
                localized("MobileViewModel.0f495fd9e145", "Проверка передачи завершена; результаты получения и отправки показаны отдельно")
            } } finally {
                if (transferJob === owner) { transfer = transfer?.copy(running = false); transferJob = null; changed() }
            }
        }
        transferJob = task; task.start(); return task.await()
    }
    private fun TransferObservation.toUi() = TransferDirectionUi(state, bytes, elapsedMs, reason)
    override suspend fun readLogs() = action { changed(); localized("MobileViewModel.f510fb126f12", "Журнал обновлён") }
    override suspend fun recover() = action {
        check(!repository.requestedOpen.value && controller.status.value.phase !in setOf(RuntimePhase.ON, RuntimePhase.STARTING)) {
            localized("MobileViewModel.95c8e3d1fb8c", "Сначала выключите VPN главным переключателем. Восстановление не должно неожиданно прерывать соединение.")
        }
        disconnect(); withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR } }
        repository.reload(); repository.ready(); localized("MobileViewModel.a8fb6aad5e21", "Служба остановлена, защищённое хранилище прочитано. Можно подключаться снова.")
    }
    override suspend fun saveSettings(patch: SettingsPatch) = mutation {
        repository.edit { value -> value.copy(settings = value.settings.copy(lanDirect = patch.lanDirect ?: value.settings.lanDirect,
            ruDirect = patch.ruDirect ?: value.settings.ruDirect, autoConnect = patch.autoConnect ?: value.settings.autoConnect,
            notifications = patch.notifications ?: value.settings.notifications)) }; localized("MobileViewModel.9286ab3d79df", "Настройки сохранены")
    }
    override suspend fun setSystemDnsPath(viaId: String?) = mutation {
        repository.edit { value ->
            require(viaId == null || validPath(value, viaId)) { localized("MobileViewModel.fa4cfe5bb6a5", "Выберите доступный путь для общего DNS") }
            value.copy(settings = value.settings.copy(systemDnsVia = viaId))
        }
        localized("MobileViewModel.a999e6193db9", "Общий DNS сохранён")
    }

    override suspend fun setServicePath(id: String) = mutation {
        repository.edit { data ->
            require(id == DIRECT || data.profiles.any { it.id == id && !it.revoked && !it.subscriptionMissing && it.source == "personal" }) {
                localized("MobileViewModel.31e452231855", "Выберите доступный личный туннель или прямое подключение")
            }
            data.copy(settings = data.settings.copy(serviceVia = id))
        }
        localized("MobileViewModel.e7a29c636b6e", "Путь служебных загрузок сохранён")
    }

    /** Public catalogs get strict endpoint/redirect rules, without changing private subscription policy.
     * The pinned native diagnostic HTTP API follows unobservable redirects and is unsuitable for feed recovery.
     * Until a safe per-outbound fetch API exists, use only the selected service path and registered delivery mirrors. */
    private suspend fun fetchPublicCatalog(source: PublicCatalogSource, url: String, maxBytes: Int): String {
        val data = repository.ready(); val via = data.settings.serviceVia
        if (via == DIRECT) return network.fetchPublic(source, url, maxBytes)
        val profile = data.profiles.find { it.id == via && it.source == "personal" && !it.revoked && !it.subscriptionMissing }
            ?: error(localized("MobileViewModel.1cd527a1fe23", "Служебный путь недоступен. Выберите другой в настройках."))
        val session = controller.sessionGeneration(); val intent = repository.intentGeneration()
        val physical = network.physicalNetwork()?.networkHandle
        fun current() = controller.isSessionGeneration(session) && controller.status.value.phase == RuntimePhase.ON &&
            repository.intentGeneration() == intent && repository.data.value?.revision == data.revision &&
            network.physicalNetwork()?.networkHandle == physical &&
            controller.groups.value.any { it.tag == "rt-service" && it.selected == "p-${profile.id}" }
        check(current()) { localized("MobileViewModel.ff2a3a2ca57a", "Для служебной загрузки включите VPN с выбранным личным путём; прямой резерв не используется.") }
        val vpn = network.vpnNetwork() ?: error(localized("MobileViewModel.0898a5985fea", "Сеть VPN ещё не готова"))
        return coroutineScope {
            val owner = currentCoroutineContext()[Job]!!
            val guard = launch {
                while (current()) delay(100)
                owner.cancel(CancellationException(localized("MobileViewModel.c1d5bf631052", "Сеть или выбранный служебный путь изменились")))
            }
            try {
                val body = network.fetchPublic(source, url, maxBytes, physical = false, boundNetwork = vpn)
                check(current()) { localized("MobileViewModel.b91928a26bc8", "Состояние или путь изменились во время загрузки; результат не сохранён") }
                body
            } finally { guard.cancel() }
        }
    }

    /** Binding to the owned VPN network prevents an OFF/revoke from retrying over the physical default route. */
    private suspend fun fetchService(url: String, maxBytes: Int = MAX_IMPORT_BYTES): String {
        val data = repository.ready(); val via = data.settings.serviceVia
        if (via == DIRECT) return network.fetch(url, maxBytes)
        val profile = data.profiles.find { it.id == via && it.source == "personal" && !it.revoked && !it.subscriptionMissing }
            ?: error(localized("MobileViewModel.8c404a4f594c", "Служебный путь недоступен. Выберите другой в настройках."))
        val session = controller.sessionGeneration(); val intent = repository.intentGeneration()
        fun current() = controller.isSessionGeneration(session) && controller.status.value.phase == RuntimePhase.ON &&
            repository.intentGeneration() == intent && repository.data.value?.revision == data.revision &&
            controller.groups.value.any { it.tag == "rt-service" && it.selected == "p-${profile.id}" }
        check(current()) { localized("MobileViewModel.3db693169e55", "Для служебной загрузки включите VPN с выбранным личным путём; прямой резерв не используется.") }
        val vpn = network.vpnNetwork() ?: error(localized("MobileViewModel.007c46bcc3dc", "Сеть VPN ещё не готова"))
        return coroutineScope {
            val owner = currentCoroutineContext()[Job]!!
            val guard = launch { controller.status.first { it.phase != RuntimePhase.ON }; owner.cancel(CancellationException(localized("MobileViewModel.cdbec7cb1169", "VPN выключен"))) }
            try {
                val body = network.fetch(url, maxBytes, physical = false, boundNetwork = vpn)
                check(current()) { localized("MobileViewModel.5976599d8f79", "Состояние или путь изменились во время загрузки; результат не сохранён") }
                body
            } finally { guard.cancel() }
        }
    }

    override suspend fun clearDiagnosticHistory() = action { app.evidence.clear(); localized("MobileViewModel.afd2195234f2", "Сохранённая диагностика удалена") }

    override fun cancelTuning() {
        tuningProof = null; tuningJob?.cancel()
        tuning = tuning?.copy(running = false, canApply = false, message = localized("MobileViewModel.5897a6db33ff", "Подбор отменён или состояние VPN изменилось"))
        changed()
    }

    override suspend fun runTuning(id: String): UiResult {
        if (tuningJob?.isCompleted == false || transferJob?.isCompleted == false || diagnosticBusy) return UiResult(false, localized("MobileViewModel.53459cb18408", "Дождитесь завершения текущей проверки"))
        val task = viewModelScope.async(start = CoroutineStart.LAZY) {
            val owner = currentCoroutineContext()[Job]!!
            try { action {
                val data = repository.ready(); val profile = data.profiles.find { it.id == id } ?: error(localized("MobileViewModel.a7305f4bd7dd", "Профиль удалён"))
                check(!repository.requestedOpen.value && controller.status.value.phase == RuntimePhase.OFF && !repository.applying.value) {
                    localized("MobileViewModel.7ca409141035", "Для подбора вариантов выключите VPN. Действующие соединения не изменяются.")
                }
                val choices = ProfileTuning.variants(profile); require(choices.isNotEmpty()) { localized("MobileViewModel.4a8c88a35a1d", "Для этого профиля нет совместимых вариантов") }
                val physical = network.physicalNetwork()?.networkHandle ?: error(localized("MobileViewModel.dd605687d7f3", "Нет физической сети"))
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
                        currentCoroutineContext().ensureActive(); check(current()) { localized("MobileViewModel.ff709c503099", "Сеть, профиль или состояние VPN изменились") }
                        val result = try {
                            val config = withContext(Dispatchers.Default) { RoutingCompiler.compile(data, app.packageName, checkerProfiles = listOf(choice.profile)) }
                            TransferProof.download(controller.fetchCheckOutbound(config.json, "p-$id", TransferProof.URL,
                                TransferProof.TIMEOUT_MS, TransferProof.MAX_BYTES))
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { TransferObservation("fail", reason = "network") }
                        check(current()) { localized("MobileViewModel.ba95c233095a", "Сеть, профиль или состояние VPN изменились; результат устарел") }
                        if (result.state == "pass") passed += choice.id
                        tuning = tuning?.copy(variants = tuning!!.variants.map { value -> if (value.id == choice.id) value.copy(
                            result = if (result.state == "pass") ObservationResult.OK else ObservationResult.FAILED,
                            latencyMs = result.elapsedMs?.toDouble()) else value })
                        changed()
                        if (choice.id == ProfileTuning.ORIGINAL && result.state == "pass") break
                    }
                }
                check(current()) { localized("MobileViewModel.90dad86ba5d5", "Проверка устарела") }
                val at = System.currentTimeMillis(); tuningProof = proof.copy(checkedAt = at, successful = passed)
                tuning = tuning?.copy(running = false, checkedAt = at, canApply = passed.any { it != ProfileTuning.ORIGINAL }, message =
                    if (ProfileTuning.ORIGINAL in passed) localized("MobileViewModel.426f9624ba9f", "Исходный профиль полностью загрузил контрольный текст. Изменения не нужны.")
                    else if (passed.isEmpty()) localized("MobileViewModel.6cfa6d89e1d4", "Контрольная загрузка не прошла. Это не определяет причину блокировки; исходный профиль сохранён.")
                    else localized("MobileViewModel.8c728020d6fa", "Получение данных проверено в этой сети. Отправка не измерялась. Выберите вариант для явного применения."))
                localized("MobileViewModel.77a342297560", "Проверка вариантов завершена")
            } } catch (_: TimeoutCancellationException) {
                if (tuningJob === owner) tuningProof = null
                UiResult(false, localized("MobileViewModel.5833d1a33635", "Подбор остановлен по лимиту 60 секунд"))
            } finally {
                if (tuningJob === owner) { tuning = tuning?.copy(running = false); tuningJob = null; changed() }
            }
        }
        tuningJob = task; task.start(); return task.await()
    }

    override suspend fun applyTuning(id: String, variantId: String) = mutation {
        val proof = tuningProof ?: error(localized("MobileViewModel.8fa42be1e76c", "Повторите проверку в текущей сети"))
        require(variantId != ProfileTuning.ORIGINAL && variantId in proof.successful) { localized("MobileViewModel.ecda316de564", "Этот вариант не прошёл проверку") }
        repository.edit(beforeCommit = {
            val current = repository.data.value
            require(tuningProof === proof && controller.status.value.phase == RuntimePhase.OFF && !repository.requestedOpen.value &&
                current != null && proof.current(current.profiles.find { it.id == id }, network.physicalNetwork()?.networkHandle,
                    repository.intentGeneration(), current.revision, System.currentTimeMillis())) {
                localized("MobileViewModel.d4dcaf99f924", "Проверка устарела: изменились сеть, профиль или состояние VPN")
            }
        }) { data ->
            val profile = data.profiles.find { it.id == id }
            require(proof.current(profile, network.physicalNetwork()?.networkHandle, repository.intentGeneration(), data.revision, System.currentTimeMillis())) {
                localized("MobileViewModel.d4dcaf99f924", "Проверка устарела: изменились сеть, профиль или состояние VPN")
            }
            val original = profile!!; val variant = ProfileTuning.variants(original).first { it.id == variantId }
            val retained = original.tuning?.takeIf { it.appliedSignature == ProfileTuning.signature(original) }
            val next = variant.profile.copy(tuning = StoredProfileTune(variant.id, variant.label,
                retained?.originalConfig ?: original.config, retained?.originalProtocol ?: original.protocol,
                ProfileTuning.signature(variant.profile), proof.network.toString(), tuning?.networkLabel.orEmpty(), proof.checkedAt))
            data.copy(profiles = data.profiles.map { if (it.id == id) next else it })
        }
        tuningProof = null; tuning = tuning?.copy(canApply = false, selectedVariantId = variantId)
        localized("MobileViewModel.f4b42cd1b6be", "Проверенный вариант сохранён; исходные параметры доступны для возврата")
    }

    override suspend fun resetTuning(id: String) = mutation {
        repository.edit { data ->
            val profile = data.profiles.find { it.id == id } ?: error(localized("MobileViewModel.6db0dcc3cee3", "Профиль удалён"))
            val stored = profile.tuning ?: error(localized("MobileViewModel.108b4c868f7c", "Нет сохранённого варианта"))
            require(stored.appliedSignature == ProfileTuning.signature(profile)) { localized("MobileViewModel.47587d7306f7", "Профиль изменился после подбора; старые параметры не применены") }
            val original = profile.copy(config = stored.originalConfig, protocol = stored.originalProtocol, tuning = null)
            data.copy(profiles = data.profiles.map { if (it.id == id) original else it })
        }
        tuningProof = null; tuning = null
        localized("MobileViewModel.4945f1e70317", "Исходные параметры восстановлены")
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
