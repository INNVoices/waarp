package local.waarp.android.data

import org.json.JSONObject

data class CompiledRoute(val routeId: String, val requested: String, val targetTag: String?, val fallbackTag: String? = null)
data class SystemDnsPolicy(val via: String?, val fallback: String? = null, val routeId: String? = null, val reason: String? = null) {
    val blocked: Boolean get() = reason != null
}
data class CompiledConfiguration(val json: String, val loadedProfiles: List<String>, val groups: List<TunnelGroup>,
    val routes: List<CompiledRoute>, val blockedPaths: Set<String>, val selectorTargets: Map<String, Pair<String, String>>) {
    fun profileTag(id: String) = "p-$id"
}

/** Android policy compiler. No Windows process paths, REST controller or implicit Direct fallback. */
object RoutingCompiler {
    const val AUTO_LIMIT = 16
    const val LIVE_PROFILE_LIMIT = 64
    const val LIVE_ENDPOINT_LIMIT = 16
    private const val BLOCK = "__block"
    private val ruDomains = listOf("ru", "su", "xn--p1ai")

    /** Android 10/11 may attribute system resolver sockets to netd, not their requesting app.
     * Never guess an app UID or silently let its DNS escape through the physical resolver. */
    fun systemDnsPolicy(data: AppData): SystemDnsPolicy {
        val available = data.profiles.filterNot { it.revoked || it.subscriptionMissing }.associateBy { it.id }
        fun valid(path: String): Boolean = path == DIRECT || path in available ||
            (path == AUTO && available.values.any { it.source != "public" }) ||
            data.groups.any { it.id == path && it.members.any(available::containsKey) }
        fun chosen(path: String) = if (valid(path)) SystemDnsPolicy(path) else SystemDnsPolicy(path,
            reason = "Общий DNS-путь недоступен. Выберите доступный туннель в настройках.")
        data.settings.systemDnsVia?.let { return chosen(it) }
        if (data.settings.defaultVia != DIRECT) return chosen(data.settings.defaultVia)
        val appPaths = data.routes.filter { it.enabled && it.kind == "app" && it.via != DIRECT }
        if (appPaths.isEmpty()) return SystemDnsPolicy(DIRECT)
        if (appPaths.any { !valid(it.via) }) return SystemDnsPolicy(null,
            reason = "DNS-путь одного из приложений недоступен. Выберите общий DNS в настройках.")
        val distinct = appPaths.map { route -> route to route.fallback?.takeIf { it != DIRECT && it != route.via && valid(it) } }
            .distinctBy { (route, fallback) -> route.via to fallback }
        if (distinct.size != 1) return SystemDnsPolicy(null,
            reason = "Приложения используют разные DNS-пути. Выберите общий DNS в настройках для запросов, чей отправитель неизвестен Android.")
        val (route, fallback) = distinct.single()
        return SystemDnsPolicy(route.via, fallback, route.id.takeIf { fallback != null })
    }

    fun compile(data: AppData, selfPackage: String = "local.waarp.android", previousAuto: String? = null,
        checkerProfiles: List<TunnelProfile>? = null): CompiledConfiguration {
        data.checked()
        val available = data.profiles.filterNot { it.revoked || it.subscriptionMissing }.associateBy { it.id }
        val references = (listOfNotNull(data.settings.defaultVia, data.settings.systemDnsVia) +
            data.routes.filter { it.enabled }.flatMap { listOfNotNull(it.via, it.fallback) }).toSet()
        val explicit = linkedSetOf<String>()
        val groups = data.groups.filter { it.id in references }.map { it.copy(members = it.members.filter(available::containsKey)) }.filter { it.members.isNotEmpty() }
        references.filter(available::containsKey).forEach(explicit::add)
        groups.flatMap { it.members }.forEach(explicit::add)
        val explicitEndpoints = explicit.count { available[it]?.endpoint == true }
        if (checkerProfiles == null) {
            require(explicit.size <= LIVE_PROFILE_LIMIT) { "Одновременно можно использовать не более 64 туннелей; уменьшите группы активных маршрутов" }
            require(explicitEndpoints <= LIVE_ENDPOINT_LIMIT) { "Одновременно можно использовать не более 16 WireGuard/AmneziaWG/OpenVPN; уменьшите активные группы" }
        }
        val own = available.values.filter { it.source != "public" }.map { it.id }
        val auto = if (AUTO in references) {
            val head = listOfNotNull(previousAuto?.takeIf { it in own })
            val chosen = mutableListOf<String>(); var extras = 0; var endpoints = explicitEndpoints
            for (id in (head + own.filter { it in explicit } + own).distinct()) {
                if (id in explicit) { chosen.add(id); continue }
                if (extras >= AUTO_LIMIT || explicit.size + extras >= LIVE_PROFILE_LIMIT) continue
                val endpoint = available[id]?.endpoint == true
                if (endpoint && endpoints >= LIVE_ENDPOINT_LIMIT) continue
                chosen.add(id); extras++; if (endpoint) endpoints++
            }
            chosen
        } else emptyList()
        val liveGroups = groups + if (auto.isNotEmpty()) listOf(TunnelGroup(AUTO, "Авто", "fastest", auto)) else emptyList()
        val loaded = checkerProfiles?.filterNot { it.revoked || it.subscriptionMissing }
            ?: (explicit + auto).mapNotNull(available::get)
        val loadedById = loaded.associateBy { it.id }
        val groupById = liveGroups.associateBy { it.id }
        val blocked = linkedSetOf<String>()
        fun tag(via: String): String = when {
            via == DIRECT -> DIRECT
            via in loadedById -> "p-$via"
            via in groupById -> "grp-$via"
            else -> { blocked.add(via); BLOCK }
        }
        fun profileV6(p: TunnelProfile): Boolean {
            if (p.protocol == "OpenVPN") return false
            if (p.protocol !in setOf("WireGuard", "AWG1", "AWG2")) return true
            val peer = JSONObject(p.config).optJSONArray("peers")?.optJSONObject(0)
            return p.addresses.any { it.contains(':') } && peer?.stringList("allowed_ips")?.any { it.contains(':') } == true
        }
        fun v6(via: String): Boolean = via == DIRECT || loadedById[via]?.let(::profileV6) == true ||
            groupById[via]?.members?.let { m -> m.isNotEmpty() && m.all { loadedById[it]?.let(::profileV6) == true } } == true
        val outbounds = mutableListOf<JSONObject>(obj("type" to "direct", "tag" to DIRECT))
        val endpoints = mutableListOf<JSONObject>()
        loaded.forEach { profile ->
            val node = JSONObject(profile.config).put("tag", "p-${profile.id}")
            if (profile.endpoint) {
                if (profile.protocol in setOf("WireGuard", "AWG1", "AWG2")) node.put("system", false)
                endpoints.add(node)
            } else outbounds.add(node)
        }
        if (checkerProfiles != null) {
            return CompiledConfiguration(obj("log" to obj("level" to "warn"),
                "dns" to obj("servers" to listOf(obj("type" to "local", "tag" to "local")), "final" to "local", "strategy" to "ipv4_only"),
                "endpoints" to endpoints, "outbounds" to outbounds,
                "route" to obj("final" to DIRECT, "default_domain_resolver" to "local", "auto_detect_interface" to true)).toString(),
                loaded.map { it.id }, emptyList(), emptyList(), emptySet(), emptyMap())
        }
        liveGroups.forEach { group -> outbounds.add(obj("type" to "selector", "tag" to "grp-${group.id}",
            "outbounds" to group.members.map { "p-$it" }, "default" to "p-${group.members.first()}", "interrupt_exist_connections" to true)) }
        val servers = mutableListOf(obj("type" to "local", "tag" to "local"))
        fun resolver(profile: TunnelProfile?): JSONObject {
            val dns = profile?.dns?.firstOrNull(AddressRules::isIp)
            return if (dns == null) obj("type" to "https", "server" to "1.1.1.1") else obj("type" to "udp", "server" to dns, "server_port" to 53)
        }
        loaded.forEach { servers.add(resolver(it).put("tag", "dns-${it.id}").put("detour", "p-${it.id}")) }
        liveGroups.forEach { group ->
            val resolvers = group.members.map { resolver(loadedById[it]) }
            val common = resolvers.first().takeIf { first -> resolvers.all { it.toString() == first.toString() } } ?: resolver(null)
            servers.add(JSONObject(common.toString()).put("tag", "dns-${group.id}").put("detour", "grp-${group.id}"))
        }
        val rules = mutableListOf(obj("action" to "sniff"), obj("protocol" to "dns", "action" to "hijack-dns"),
            obj("ip_cidr" to listOf("172.19.0.0/30", "fdfe:dcba:9876::/126"), "action" to "reject"))
        val dnsRules = mutableListOf<JSONObject>()
        if (data.settings.lanDirect) rules.add(obj("ip_is_private" to true, "outbound" to DIRECT))
        rules.add(obj("package_name" to listOf(selfPackage), "outbound" to DIRECT))
        dnsRules.add(obj("package_name" to listOf(selfPackage), "server" to "local"))
        if (data.settings.ruDirect) {
            rules.add(obj("domain_suffix" to ruDomains, "outbound" to DIRECT))
            dnsRules.add(obj("domain_suffix" to ruDomains, "server" to "local"))
        }
        val routePlans = mutableListOf<CompiledRoute>()
        val selectorTargets = linkedMapOf<String, Pair<String, String>>()
        fun rule(match: JSONObject, target: String, supportsV6: Boolean) {
            if (!supportsV6 && target != BLOCK) rules.add(JSONObject(match.toString()).put("ip_version", 6).put("action", "reject"))
            rules.add(JSONObject(match.toString()).apply { if (target == BLOCK) put("action", "reject") else put("outbound", target) })
        }
        data.routes.filter { it.enabled }.sortedBy { when (it.kind) { "app" -> 0; "custom" -> 1; else -> 2 } }.forEach { route ->
            val primary = tag(route.via)
            val fallback = route.fallback?.takeIf { it != DIRECT && it != route.via }?.let(::tag)?.takeIf { it != BLOCK }
            var target = primary
            var dns = if (route.via == DIRECT) "local" else "dns-${route.via}"
            if (primary != BLOCK && primary != DIRECT && fallback != null) {
                target = "fb-${route.id}"
                outbounds.add(obj("type" to "selector", "tag" to target, "outbounds" to listOf(primary, fallback), "default" to primary, "interrupt_exist_connections" to true))
                servers.add(resolver(null).put("tag", "dns-$target").put("detour", target))
                dns = "dns-$target"; selectorTargets[target] = route.via to route.fallback!!
            }
            val supportsV6 = v6(route.via) && (fallback == null || v6(route.fallback!!))
            val matches = when (route.kind) {
                "app" -> {
                    require(route.match.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))) { "Некорректное имя пакета Android" }
                    listOf(obj("package_name" to listOf(route.match)))
                }
                "preset" -> {
                    val preset = Presets.all.find { it.id == route.match } ?: error("Неизвестный сервис маршрута")
                    buildList { if (preset.domains.isNotEmpty()) add(obj("domain_suffix" to preset.domains)); if (preset.cidrs.isNotEmpty()) add(obj("ip_cidr" to preset.cidrs)) }
                }
                else -> route.match.split(Regex("[\\s,;]+")).filter { it.isNotBlank() }.map(AddressRules::selector).let { values ->
                    require(values.isNotEmpty()); buildList {
                        values.filterNot { it.second }.map { it.first }.takeIf { it.isNotEmpty() }?.let { add(obj("domain_suffix" to it)) }
                        values.filter { it.second }.map { it.first }.takeIf { it.isNotEmpty() }?.let { add(obj("ip_cidr" to it)) }
                    }
                }
            }
            matches.forEach { match ->
                rule(match, target, supportsV6)
                if (match.has("domain_suffix") || match.has("package_name")) {
                    dnsRules.add(JSONObject(match.toString()).apply { if (primary == BLOCK) put("action", "reject") else put("server", dns) })
                }
            }
            routePlans.add(CompiledRoute(route.id, route.via, target.takeUnless { it == BLOCK }, fallback))
        }
        if (data.settings.defaultVia == DIRECT && data.routes.any { it.enabled && it.kind == "app" && it.via != DIRECT }) {
            // An unavailable socket owner must not turn a protected app flow into Direct.
            // Explicit destination/LAN/self rules above still have their normal priority.
            rules.add(obj("package_name_regex" to listOf(".+"), "invert" to true, "action" to "reject"))
        }
        val rest = tag(data.settings.defaultVia)
        val systemDns = systemDnsPolicy(data)
        val systemDnsTarget = systemDns.via?.let(::tag)
        // AID_DNS is the real OS-reported owner; package attribution above is left intact.
        // Domain rules retain priority. This shared policy only handles netd's DNS requests.
        val sharedDnsRule = obj("user_id" to listOf(1051)).apply {
            if (systemDns.blocked || systemDnsTarget == BLOCK) put("action", "reject")
            else put("server", when {
                systemDns.via == DIRECT -> "local"
                systemDns.routeId != null && "fb-${systemDns.routeId}" in selectorTargets -> "dns-fb-${systemDns.routeId}"
                else -> "dns-${systemDns.via}"
            })
        }
        dnsRules.add(sharedDnsRule)
        // Socket ownership can disappear between a packet and Android's lookup.
        // The pinned core matches no package for nil ProcessInfo; invert catches
        // that case without attributing the request to an invented application.
        dnsRules.add(JSONObject(sharedDnsRule.toString()).apply {
            remove("user_id")
            put("package_name_regex", jsonArray(listOf(".+")))
            put("invert", true)
        })
        if (rest == BLOCK) { rules.add(obj("action" to "reject")); dnsRules.add(obj("action" to "reject")) }
        else if (!v6(data.settings.defaultVia)) rules.add(obj("ip_version" to 6, "action" to "reject"))
        val config = obj("log" to obj("level" to "warn", "timestamp" to false),
            "dns" to obj("servers" to servers, "rules" to dnsRules, "final" to if (rest == DIRECT || rest == BLOCK) "local" else "dns-${data.settings.defaultVia}", "strategy" to "ipv4_only"),
            "inbounds" to listOf(obj("type" to "tun", "tag" to "tun", "interface_name" to "waarp",
                "address" to listOf("172.19.0.1/30", "fdfe:dcba:9876::1/126"), "mtu" to 1400,
                "auto_route" to true, "strict_route" to true, "stack" to "mixed")),
            "endpoints" to endpoints, "outbounds" to outbounds,
            "route" to obj("rules" to rules, "final" to if (rest == BLOCK) DIRECT else rest,
                "auto_detect_interface" to true, "find_process" to true, "default_domain_resolver" to "local"))
        return CompiledConfiguration(config.toString(), loaded.map { it.id }, liveGroups, routePlans, blocked, selectorTargets)
    }
}
