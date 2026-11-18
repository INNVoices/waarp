// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import local.waarp.android.core.*
import local.waarp.android.data.*
import local.waarp.android.ui.*
import java.text.SimpleDateFormat
import java.util.Date
import java.util.IdentityHashMap
import java.util.Locale
import java.util.TimeZone

/** Captured on Main before CPU work. No mutable ViewModel field is read by the worker. */
internal data class MobileStateSnapshot(
    val data: AppData?, val runtime: RuntimeStatus, val measured: Map<String, ProbeHealth>,
    val nativeGroups: List<RuntimeGroup>, val connections: List<RuntimeConnection>, val rawLogs: List<RuntimeLog>,
    val apps: List<AppUi>, val requestedOpen: Boolean, val applying: Boolean, val loadError: String?,
    val autoPoolLive: Int, val history: Map<String, List<Double?>>,
    val catalogProfiles: List<TunnelProfile>, val catalog: CatalogUi, val catalogHealth: Map<String, ProbeHealth>,
    val diagnostic: DiagnosticUi?, val message: UiMessage?, val appVersion: String, val backgroundTask: String? = null,
    val compiledRoutes: List<CompiledRoute> = emptyList(), val blockedPaths: Set<String> = emptySet(),
    val liveUpdateNote: String? = null,
)

/** Single worker owns these bounded caches. Stable sections keep their reference across telemetry updates. */
internal class MobileStateMapper {
    private val nativeIndex = Projection<Map<String, RuntimeGroup>>()
    private val compiledIndex = Projection<Map<String, CompiledRoute>>()
    private val profileIndex = Projection<Map<String, TunnelProfile>>()
    private val groupIndex = Projection<Map<String, TunnelGroup>>()
    private val appIndex = Projection<Map<String, AppUi>>()
    private val availableCache = Projection<Set<String>>()
    private val allGroupsCache = Projection<List<TunnelGroup>>()
    private val availableGroupsCache = Projection<Set<String>>()
    private val profilesCache = Projection<List<TunnelUi>>()
    private data class ProfileDetails(val technical: List<Pair<String, String>>, val options: List<TuneVariantUi>)
    private val profileDetails = Projection<Map<String, ProfileDetails>>()
    private val groupsCache = Projection<List<GroupUi>>()
    private val routesCache = Projection<List<RouteUi>>()
    private val flowsCache = Projection<List<FlowUi>>()
    private val catalogCache = Projection<CatalogUi>()
    private val publicIdentityCache = Projection<Set<String>>()
    private val catalogIdentityCache = Projection<Map<String, String>>()
    private val dnsPolicyCache = Projection<SystemDnsPolicy>()
    private val historyCache = Projection<List<LatencySeriesUi>>()
    private val noticesCache = Projection<List<NoticeUi>>()
    private val logs = LogProjection()
    private val presetUi = Presets.all.map { PresetUi(it.id, it.name, it.hint, it.domains + it.cidrs) }

    private fun health(value: ProbeHealth?) = when {
        value == null || value.checkedAt == 0L -> TunnelHealth.UNKNOWN
        value.down -> TunnelHealth.DOWN
        value.healthy -> TunnelHealth.OK
        value.holding -> TunnelHealth.DEGRADED
        else -> TunnelHealth.UNKNOWN
    }
    fun map(input: MobileStateSnapshot): MobileState {
        val apps = input.apps
        val catalogProfiles = input.catalogProfiles
        val catalog = input.catalog
        val catalogHealth = input.catalogHealth
        val data = input.data ?: AppData()
        val runtime = input.runtime
        val measured = input.measured
        val compiledById = compiledIndex.get(input.compiledRoutes) { input.compiledRoutes.associateBy { it.routeId } }
        val nativeByTag = nativeIndex.get(input.nativeGroups) { input.nativeGroups.associateBy { it.tag } }
        val profilesById = profileIndex.get(data.profiles) { data.profiles.associateBy { it.id } }
        // Building variants hashes/copies native JSON. Only profile changes need that work;
        // new latency observations must reuse the safe, nonsecret metadata.
        val detailsById = profileDetails.get(data.profiles) { data.profiles.associate { profile -> profile.id to
            ProfileDetails(ProfileTuning.technical(profile), ProfileTuning.variants(profile).map { TuneVariantUi(it.id, it.label, it.detail) }) } }
        val groupsById = groupIndex.get(data.groups) { data.groups.associateBy { it.id } }
        val appsByPackage = appIndex.get(apps) { apps.associateBy { it.packageName } }
        fun selected(id: String): String? = nativeByTag["grp-$id"]?.selected?.removePrefix("p-")
        fun pathName(id: String?) = when (id) { DIRECT -> "Напрямую"; AUTO -> "Авто"; null -> "Не выбран";
            else -> profilesById[id]?.name ?: groupsById[id]?.name ?: "Недоступный путь" }
        fun viaHealth(id: String): ProbeHealth? = measured[if (id.startsWith("g-")) selected(id) else id]
        val available = availableCache.get(data.profiles) { data.profiles.filterNot { it.revoked || it.subscriptionMissing }.mapTo(HashSet()) { it.id } }
        val allGroups = allGroupsCache.get(data.groups, data.profiles) { data.groups + TunnelGroup(AUTO, "Авто", "fastest", data.profiles.filter { it.id in available && it.source != "public" }.map { it.id }) }
        val availableGroups = availableGroupsCache.get(allGroups, available) { allGroups.filter { it.members.any(available::contains) }.mapTo(HashSet()) { it.id } }
        val autoReferenced = data.settings.defaultVia == AUTO || data.settings.systemDnsVia == AUTO ||
            data.routes.any { it.enabled && (it.via == AUTO || it.fallback == AUTO) }
        val showAutoPool = autoReferenced && runtime.phase == RuntimePhase.ON
        fun pathAvailable(id: String) = id == DIRECT || id in available || id in availableGroups
        val systemDns = dnsPolicyCache.get(data) { RoutingCompiler.systemDnsPolicy(data) }
        // A saved policy is not evidence of an active VPN. In particular, OFF
        // must never claim that this app is currently blocking DNS or traffic.
        val policyActive = runtime.phase == RuntimePhase.ON
        val policyContext = when (runtime.phase) {
            RuntimePhase.ON -> ""
            RuntimePhase.OFF -> "VPN выключен. Сохранённая настройка DNS: "
            RuntimePhase.STARTING -> "VPN включается. Запланированная настройка DNS: "
            RuntimePhase.STOPPING -> "VPN выключается. Настройка DNS для следующего включения: "
            RuntimePhase.ERROR -> "Ошибка VPN. Настройка DNS для успешного включения: "
        }
        val systemDnsHint = policyContext + when {
            systemDns.blocked -> systemDns.reason + " " + if (policyActive)
                "Системные DNS-запросы, для которых Android не определил приложение, блокируются."
            else "При работе VPN системные DNS-запросы, для которых Android не определил приложение, будут блокироваться."
            systemDns.via == DIRECT && data.settings.systemDnsVia == DIRECT ->
                (if (policyActive) "Системный DNS идёт напрямую" else "При работе VPN системный DNS пойдёт напрямую") +
                    ": этот путь выбран явно. Правила доменов сохраняют приоритет."
            systemDns.via == DIRECT ->
                (if (policyActive) "Системный DNS следует правилам доменов; остальные запросы идут напрямую."
                 else "При работе VPN системный DNS будет следовать правилам доменов; остальные запросы пойдут напрямую.") +
                    " Защищённых маршрутов приложений пока нет."
            else -> "Общий DNS-путь: «${pathName(systemDns.via)}»" +
                (systemDns.fallback?.let { "; резерв — «${pathName(it)}»" } ?: "") +
                (if (policyActive) ". Применяется" else ". При работе VPN будет применяться") +
                " к системным запросам, для которых Android не определил приложение."
        }
        val routeUi = routesCache.get(data.routes, available, availableGroups, input.nativeGroups, measured, runtime.phase, input.compiledRoutes) { data.routes.map { route ->
            val fallbackNative = nativeByTag[compiledById[route.id]?.targetTag ?: "fb-${route.id}"]?.selected
            val fallback = route.fallback?.takeIf { "p-$it" == fallbackNative || "grp-$it" == fallbackNative }
            val effective = fallback ?: route.via
            val routeHealth = viaHealth(effective)
            val compiledBlocked = runtime.phase == RuntimePhase.ON && compiledById[route.id]?.let { it.targetTag == null } == true
            val status = when {
                !route.enabled -> RouteState.OFF
                !pathAvailable(route.via) -> RouteState.BLOCKED
                runtime.phase in setOf(RuntimePhase.STARTING, RuntimePhase.STOPPING) -> RouteState.RETRYING
                runtime.phase != RuntimePhase.ON -> RouteState.IDLE
                compiledBlocked -> RouteState.BLOCKED
                effective == DIRECT -> RouteState.DIRECT
                // Public-site reachability is an observation. A private-prefix
                // tunnel can keep carrying its assigned traffic when those
                // sites are unreachable; only the compiler proves rejection.
                routeHealth?.down == true -> RouteState.CHECK_FAILED
                fallback != null -> RouteState.FALLBACK
                routeHealth?.healthy == true -> RouteState.OK
                routeHealth?.holding == true -> RouteState.RETRYING
                else -> RouteState.IDLE
            }
            RouteUi(route.id, when (route.kind) { "app" -> RouteKind.APP; "preset" -> RouteKind.SERVICE; else -> RouteKind.CUSTOM },
                route.name, route.via, route.fallback, route.enabled, route.match.takeIf { route.kind == "app" },
                route.match.takeIf { route.kind == "preset" }, route.match.takeIf { route.kind == "custom" }, status,
                effectiveViaId = effective, connectionUse = ConnectionUses.normalize(route.connectionUse), reason = when {
                    !pathAvailable(route.via) -> "Путь удалён или недоступен. Назначьте другой; напрямую трафик не перенаправляется."
                    compiledBlocked -> "Путь не вошёл в текущую конфигурацию VPN. Уменьши число активных туннелей или измени назначение."
                    routeHealth?.down == true -> "Две последовательные проверки внешних сайтов не прошли. Маршрут остаётся назначенным."
                    runtime.phase == RuntimePhase.ON && effective != DIRECT && routeHealth == null -> "Маршрут установлен; удалённый путь ещё не проверен"
                    else -> null
                })
        } }
        val flows = flowsCache.get(input.connections, apps, data.profiles, data.groups) { input.connections.filter { it.active }.map { connection ->
            val packageName = connection.packages.firstOrNull().orEmpty()
            val host = connection.domain.ifEmpty { connection.destination.substringBeforeLast(':').removePrefix("[").removeSuffix("]") }
            val port = connection.destination.substringAfterLast(':').toIntOrNull() ?: 0
            val outbound = connection.outbound.removePrefix("p-").removePrefix("grp-")
            FlowUi(connection.id, appsByPackage[packageName]?.name ?: packageName,
                packageName, host, port, connection.network, pathName(outbound), connection.rule, connection.downloadBytes, connection.uploadBytes)
        } }
        val notices = noticesCache.get(data, routeUi, apps, input.loadError, runtime.phase, runtime.lockdown, systemDnsHint, input.blockedPaths, input.liveUpdateNote) { buildList {
            input.loadError?.let { add(NoticeUi("store", NoticeLevel.BLOCK, "Хранилище недоступно", it)) }
            if (policyActive) input.liveUpdateNote?.let { add(NoticeUi("live-update-limit", NoticeLevel.WARNING,
                "Обновление большой таблицы маршрутов", it)) }
            if (!pathAvailable(data.settings.defaultVia)) add(NoticeUi("global-missing", NoticeLevel.BLOCK, "Общий маршрут недоступен",
                if (policyActive) "Трафик без отдельного правила блокируется до выбора доступного пути."
                else "При работе VPN трафик без отдельного правила будет блокироваться до выбора доступного пути."))
            if (runtime.phase == RuntimePhase.ON && data.settings.defaultVia in input.blockedPaths) add(NoticeUi("global-budget", NoticeLevel.BLOCK,
                "Общий путь не загружен", "Он не вошёл в текущую конфигурацию VPN. Трафик без отдельного правила заблокирован; выбери другой путь или уменьши число активных туннелей."))
            if (systemDns.blocked) add(NoticeUi("system-dns", NoticeLevel.WARNING, "Общий DNS требует выбора", systemDnsHint))
            if (routeUi.any { it.state == RouteState.BLOCKED }) add(NoticeUi("blocked-routes", NoticeLevel.WARNING, "Есть недоступные маршруты", "Откройте «Маршруты» и проверьте назначенные туннели."))
            if (routeUi.any { it.state == RouteState.CHECK_FAILED }) add(NoticeUi("route-checks", NoticeLevel.WARNING,
                "Есть ошибки проверки маршрутов", "Проверки внешних сайтов не прошли. Назначения сохранены; подробности — в «Маршрутах»."))
            if (data.profiles.any { it.source == "public" }) add(NoticeUi("public", NoticeLevel.WARNING, "Добавлены публичные узлы", "Их владельцы неизвестны. Они не входят в Авто и используются только при вашем выборе."))
            if (runtime.phase == RuntimePhase.ON && !runtime.lockdown) add(NoticeUi("lockdown", NoticeLevel.INFO, "Постоянная блокировка не включена", "При остановке VPN Android может направить трафик напрямую. Системная настройка «Блокировать соединения без VPN» доступна в настройках."))
            val appRoutes = data.routes.filter { it.enabled && it.kind == "app" }.groupBy { route -> appsByPackage[route.match]?.uid }
            if (appRoutes.any { (uid, routes) -> uid != null && routes.map { it.via }.distinct().size > 1 }) add(NoticeUi("shared-uid", NoticeLevel.WARNING,
                "Приложения разделяют UID", "Android не различает их сетевые сокеты. Для общего UID действует первое подходящее правило."))
        } }
        val knownPublicIdentities = if (catalogProfiles.isEmpty()) emptySet() else publicIdentityCache.get(data.profiles) { data.profiles.mapTo(HashSet(), ProfileImporter::identity) }
        val catalogIdentities = catalogIdentityCache.get(catalogProfiles) { catalogProfiles.associate { it.id to ProfileImporter.identity(it) } }
        return MobileState(
            initialized = input.data != null,
            status = ConnectionUi(ConnectionPhase.valueOf(runtime.phase.name), input.requestedOpen,
                recovering = input.applying, recoveryFailed = input.loadError != null, error = runtime.message,
                connectedSinceMillis = runtime.startedAt.takeIf { it > 0 }, downloadBytesPerSecond = runtime.downloadBps,
                uploadBytesPerSecond = runtime.uploadBps, downloadedBytes = runtime.downloadBytes, uploadedBytes = runtime.uploadBytes,
                selectedPathLabel = if (data.settings.defaultVia == DIRECT) "Только выбранное · общий путь напрямую"
                    else "Всё устройство · ${pathName(data.settings.defaultVia)}",
                autoPoolLive = input.autoPoolLive.takeIf { showAutoPool },
                autoPoolTotal = allGroups.last().members.size.takeIf { showAutoPool }),
            profiles = profilesCache.get(data.profiles, measured) { data.profiles.map { profile -> TunnelUi(profile.id, profile.name, profile.protocol, profile.host, profile.port,
                profile.addresses, when (profile.source) { "public" -> ProfileSource.PUBLIC; "managed" -> ProfileSource.MANAGED; "warp" -> ProfileSource.WARP; else -> ProfileSource.PERSONAL },
                health(measured[profile.id]), measured[profile.id]?.latencyMs?.toDouble(), profile.country.takeIf(String::isNotBlank),
                profile.revoked, profile.subscription != null, profile.subscriptionMissing, profile.clientPublicKey,
                canRename = profile.source !in setOf("managed", "public"), canReplace = profile.source !in setOf("managed", "public", "warp"), canDelete = profile.source != "managed",
                technical = detailsById.getValue(profile.id).technical, canTune = detailsById.getValue(profile.id).options.isNotEmpty(),
                tuneLabel = profile.tuning?.label,
                tuneOptions = detailsById.getValue(profile.id).options) } },
            groups = groupsCache.get(allGroups, measured, input.nativeGroups) { allGroups.map { group -> GroupUi(group.id, group.name, if (group.policy == "first") GroupPolicy.FIRST else GroupPolicy.FASTEST,
                group.members, selected(group.id), health(viaHealth(group.id)), viaHealth(group.id)?.latencyMs?.toDouble()) } },
            routes = routeUi, apps = apps, presets = presetUi,
            settings = SettingsUi(data.settings.defaultVia, data.settings.lastWholeDeviceVia, data.settings.lanDirect, data.settings.ruDirect,
                data.settings.autoConnect, data.settings.notifications, runtime.alwaysOn.takeIf { runtime.phase == RuntimePhase.ON }, runtime.lockdown.takeIf { runtime.phase == RuntimePhase.ON },
                data.settings.systemDnsVia, systemDnsHint, systemDns.blocked, data.settings.serviceVia),
            catalog = catalogCache.get(catalog, catalogProfiles, catalogHealth, knownPublicIdentities, profilesById) { catalog.copy(nodes = catalogProfiles.map { node -> PublicNodeUi(node.id, node.name, node.protocol, node.host, node.port, node.country,
                latencyMs = catalogHealth[node.id]?.latencyMs?.toDouble(), health = health(catalogHealth[node.id]), added = node.id in profilesById || catalogIdentities[node.id] in knownPublicIdentities) }) },
            flows = flows, latencyHistory = historyCache.get(input.history, data.profiles) { input.history.mapNotNull { (id, samples) -> profilesById[id]?.let { LatencySeriesUi(id, it.name, samples) } } },
            diagnostic = input.diagnostic, logs = logs.map(input.rawLogs),
            notices = notices, error = input.loadError, message = input.message, appVersion = input.appVersion, engineVersion = runtime.coreVersion, backgroundTask = input.backgroundTask,
        )
    }

}

private class Projection<T : Any> {
    private var inputs: Array<out Any?>? = null
    private var value: T? = null
    fun get(vararg keys: Any?, build: () -> T): T {
        if (inputs?.contentEquals(keys) != true) { value = build(); inputs = keys }
        return checkNotNull(value)
    }
}

/** Equal messages are separate events. Keep ids for surviving objects when the native ring advances. */
internal class LogProjection {
    private var nextId = 0L
    private var previous: List<RuntimeLog>? = null
    private var format: String? = null
    private var entries = IdentityHashMap<RuntimeLog, LogLineUi>()
    private var lines: List<LogLineUi> = emptyList()
    fun map(logs: List<RuntimeLog>): List<LogLineUi> {
        val key = Locale.getDefault().toLanguageTag() + "|" + TimeZone.getDefault().id
        if (logs === previous && key == format) return lines
        val clock = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
        val updated = IdentityHashMap<RuntimeLog, LogLineUi>()
        lines = logs.map { event ->
            val old = entries[event]
            val line = if (old != null && key == format) old else LogLineUi(old?.id ?: ++nextId,
                "${clock.format(Date(event.timestamp))} [${event.level}] ${event.message}")
            updated[event] = line
            line
        }
        entries = updated; previous = logs; format = key
        return lines
    }
}
