// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Native definitions stay fixed during one VPN session; only selectors and watched sets change. */
data class MobileLivePlan(
    val directory: String,
    val appSlots: List<String>,
    val destinationSlots: List<String>,
    val files: Map<String, String>,
    val selections: Map<String, String>,
    val signature: String,
    val selfPackage: String,
) {
    fun compatible(other: MobileLivePlan): Boolean = directory == other.directory && signature == other.signature
    override fun toString(): String = "MobileLivePlan(files=${files.size}, selectors=${selections.size}, privateRules=[redacted])"
}

/** Uses the pinned core's local rule-set reloads. No second core, peer, REST listener or TUN. */
object MobileLiveRouting {
    const val CANARY_ZONE = "waarp-check.invalid"
    const val CANARY_IP = "127.0.0.9"
    const val ROUTE_GUARD = "update-guard"
    const val DNS_GUARD = "update-dns-guard"
    private const val PRELOAD_LIMIT = 4
    const val MAX_WATCHED_SETS = 112
    private val WATCHER_LIMIT_NOTE get() = localized("MobileLiveRouting.49d5abefe348", "Список правил превышает доступный лимит живого обновления. Изменение активных маршрутов потребует переподключения VPN; выключенные карточки на этот лимит не влияют.")
    private fun watcherBudget(): Int = runCatching {
        (File("/proc/sys/fs/inotify/max_user_instances").readText().trim().toInt() - 16).coerceIn(0, MAX_WATCHED_SETS)
    }.getOrDefault(MAX_WATCHED_SETS)
    private val privateRanges = listOf("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "fc00::/7", "fe80::/10", "::1/128")

    private fun anyTraffic() = obj("network" to listOf("tcp", "udp", "icmp"))
    private fun anyDns() = obj("domain_regex" to listOf(".*"))
    private fun and(vararg rules: JSONObject) = obj("type" to "logical", "mode" to "and", "rules" to rules.toList())
    private fun or(rules: List<JSONObject>) = if (rules.size == 1) rules.single() else obj("type" to "logical", "mode" to "or", "rules" to rules)
    private fun not(rule: JSONObject) = JSONObject(rule.toString()).put("invert", !rule.optBoolean("invert"))
    fun body(rules: List<JSONObject>): String = obj("version" to 3, "rules" to rules).toString()
    fun fileName(tag: String): String {
        require(tag.matches(Regex("[A-Za-z0-9._-]+")))
        return "$tag.json"
    }

    /** A witness is unique to one physical file/version and cannot match a broad user suffix. */
    fun withWitness(content: String, name: String): String {
        val source = JSONObject(content)
        require(source.getInt("version") == 3 && name.endsWith(".$CANARY_ZONE"))
        val rules = source.getJSONArray("rules").objects()
        return body(buildList {
            add(obj("domain" to listOf(name), "query_type" to listOf("A")))
            if (rules.isNotEmpty()) add(and(obj("domain_suffix" to listOf(CANARY_ZONE), "invert" to true), or(rules)))
        })
    }

    private fun fit(ids: List<String>, previous: List<String>?): List<String> {
        if (previous == null) return ids + List(4) { "" }
        if (ids.size > previous.size) return fit(ids, null)
        val result = previous.map { if (it in ids) it else "" }.toMutableList()
        var last = -1
        for ((index, id) in ids.withIndex()) {
            val present = result.indexOf(id)
            if (present >= 0) {
                if (present <= last) return ids + List(previous.size - ids.size) { "" }
                last = present; continue
            }
            val next = ids.drop(index + 1).map(result::indexOf).firstOrNull { it >= 0 } ?: result.size
            val free = (last + 1 until next).firstOrNull { result[it].isEmpty() }
                ?: return ids + List(previous.size - ids.size) { "" }
            result[free] = id; last = free
        }
        return result
    }

    /** Do not prewarm active keepalive peers, credentials aliases or login-based endpoints. */
    private fun preload(data: AppData, previous: CompiledConfiguration?): List<String> {
        val required = (listOfNotNull(data.settings.defaultVia, data.settings.systemDnsVia, data.settings.serviceVia) +
            data.routes.filter { it.enabled }.flatMap { listOfNotNull(it.via, it.fallback) }).toSet()
        val explicit = required + data.groups.filter { it.id in required }.flatMap { it.members }
        val peers = mutableSetOf<String>()
        fun identity(profile: TunnelProfile): String? = if (profile.protocol in setOf("WireGuard", "AWG1", "AWG2")) {
            val node = JSONObject(profile.config)
            node.optString("private_key").takeIf { it.isNotEmpty() }
        } else null
        data.profiles.filter { it.id in explicit || it.id in previous?.loadedProfiles.orEmpty() }.mapNotNull(::identity).forEach(peers::add)
        val extra = (if (previous == null) data.profiles else emptyList()).filter { !it.revoked && !it.subscriptionMissing && it.source != "public" && it.id !in explicit }
            .filter { profile ->
                if (!profile.endpoint) true else if (profile.protocol !in setOf("WireGuard", "AWG1", "AWG2")) false else {
                    val node = JSONObject(profile.config)
                    val rows = node.optJSONArray("peers")?.objects().orEmpty()
                    rows.all { it.optInt("persistent_keepalive_interval") == 0 && AddressRules.isIp(it.optString("address")) } &&
                        identity(profile)?.let(peers::add) == true
                }
            }.take(PRELOAD_LIMIT).map { it.id }
        return previous?.loadedProfiles.orEmpty() + explicit.filter { id -> data.profiles.any { it.id == id } } + extra
    }

    fun compile(data: AppData, selfPackage: String, previousAuto: String?, directory: String,
        previous: CompiledConfiguration? = null, selected: Map<String, String> = emptyMap(),
        maximumWatchers: Int = watcherBudget()): CompiledConfiguration {
        require(maximumWatchers in 0..MAX_WATCHED_SETS)
        val preload = preload(data, previous)
        val stableAuto = previous?.groups?.find { it.id == AUTO }?.members?.firstOrNull() ?: previousAuto
        val base = RoutingCompiler.compile(data, selfPackage, stableAuto, preload = preload, preloadAuto = true,
            autoCandidates = preload.toSet(), preloadGroups = data.groups.filter { it.members.isNotEmpty() && it.members.all(preload::contains) }.map { it.id }.toSet())
        val prior = previous?.live
        val appSlots = fit(data.routes.filter { it.enabled && it.kind == "app" }.map { it.id }, prior?.appSlots)
        val destinationSlots = fit(data.routes.filter { it.enabled && it.kind != "app" }.sortedBy { if (it.kind == "custom") 0 else 1 }.map { it.id }, prior?.destinationSlots)
        // Every slot needs match/reject/IPv6 sets before any DNS priority exclusions.
        // Reject oversized live plans before building quadratic per-bucket DNS rules;
        // the ordinary compiler above already supports the full saved route limit.
        if (2 + 3 * (appSlots.size + destinationSlots.size) > maximumWatchers)
            return base.copy(liveUpdateNote = WATCHER_LIMIT_NOTE)
        val config = JSONObject(base.json)
        val files = linkedMapOf<String, String>()
        val selections = linkedMapOf<String, String>()
        fun set(tag: String, rules: List<JSONObject>) { files[tag] = body(rules) }
        fun gate(tag: String, enabled: Boolean, dns: Boolean = false) = set(tag, if (enabled) listOf(if (dns) anyDns() else anyTraffic()) else emptyList())
        set(ROUTE_GUARD, emptyList()); set(DNS_GUARD, emptyList())

        // Retain dormant native definitions until OFF. Removing an unused library entry
        // must not destroy other connections; revoked paths are absent from new policy.
        fun merge(current: List<JSONObject>, old: List<JSONObject>): List<JSONObject> {
            val fresh = current.associateBy { it.getString("tag") }
            return old.map { installed ->
                val next = fresh[installed.getString("tag")] ?: return@map installed
                if (next.optString("type") == "selector" && installed.stringList("outbounds").containsAll(next.stringList("outbounds"))) installed else next
            } + current.filter { entry -> old.none { it.getString("tag") == entry.getString("tag") } }
        }
        val oldConfig = previous?.takeIf { it.live != null }?.json?.let(::JSONObject)
        val currentOutbounds = config.getJSONArray("outbounds").objects().filterNot { it.getString("tag").startsWith("fb-") }
        val oldOutbounds = oldConfig?.getJSONArray("outbounds")?.objects().orEmpty().filterNot { it.getString("tag").startsWith("rt-") }
        val outbounds = merge(currentOutbounds, oldOutbounds).toMutableList()
        val endpoints = merge(config.getJSONArray("endpoints").objects(), oldConfig?.getJSONArray("endpoints")?.objects().orEmpty())
        val tags = (outbounds.map { it.getString("tag") } + endpoints.map { it.getString("tag") }).distinct()
        val servers = merge(config.getJSONObject("dns").getJSONArray("servers").objects().filterNot { it.getString("tag").startsWith("dns-fb-") },
            oldConfig?.getJSONObject("dns")?.getJSONArray("servers")?.objects().orEmpty().filterNot { it.getString("tag").startsWith("dns-rt-") }).toMutableList()
        val available = data.profiles.filterNot { it.revoked || it.subscriptionMissing }.associateBy { it.id }
        val loaded = base.loadedProfiles.toSet()
        val groups = base.groups.associateBy { it.id }
        base.groups.forEach { group ->
            val groupTag = "grp-${group.id}"
            selections[groupTag] = selected[groupTag]?.takeIf { it.removePrefix("p-") in group.members } ?: "p-${group.members.first()}"
        }
        fun tag(via: String): String? = when { via == DIRECT -> DIRECT; via in loaded -> "p-$via"; via in groups -> "grp-$via"; else -> null }
        fun v6(via: String): Boolean {
            if (via == DIRECT) return true
            val members = groups[via]?.members ?: listOf(via)
            return members.isNotEmpty() && members.all { id ->
                val p = available[id]
                when { p == null || p.protocol == "OpenVPN" -> false
                    p.protocol !in setOf("WireGuard", "AWG1", "AWG2") -> true
                    else -> p.addresses.any { ':' in it } && JSONObject(p.config).optJSONArray("peers")?.optJSONObject(0)?.stringList("allowed_ips")?.any { ':' in it } == true }
            }
        }
        fun selector(name: String, target: String) {
            selections[name] = target
            outbounds += obj("type" to "selector", "tag" to name, "outbounds" to tags, "default" to target, "interrupt_exist_connections" to true)
        }
        fun matches(route: TrafficRoute): List<JSONObject> = when (route.kind) {
            "app" -> listOf(obj("package_name" to listOf(route.match)))
            "preset" -> Presets.all.first { it.id == route.match }.let { preset -> buildList {
                if (preset.domains.isNotEmpty()) add(obj("domain_suffix" to preset.domains))
                if (preset.cidrs.isNotEmpty()) add(obj("ip_cidr" to preset.cidrs))
            } }
            else -> route.match.split(Regex("[\\s,;]+")).filter(String::isNotBlank).map(AddressRules::selector).let { entries -> buildList {
                entries.filterNot { it.second }.map { it.first }.takeIf(List<String>::isNotEmpty)?.let { add(obj("domain_suffix" to it)) }
                entries.filter { it.second }.map { it.first }.takeIf(List<String>::isNotEmpty)?.let { add(obj("ip_cidr" to it)) }
            } }
        }
        val rules = mutableListOf(obj("action" to "sniff"), obj("protocol" to "dns", "action" to "hijack-dns"),
            obj("ip_cidr" to listOf("172.19.0.0/30", "fdfe:dcba:9876::/126"), "action" to "reject"),
            obj("rule_set" to listOf(ROUTE_GUARD), "action" to "reject"))
        gate("lan-direct", data.settings.lanDirect)
        rules += obj("rule_set" to listOf("lan-direct"), "ip_is_private" to true, "outbound" to DIRECT)
        val service = tag(data.settings.serviceVia)
        selector("rt-service", service ?: DIRECT)
        set("service-block", if (service == null) listOf(obj("package_name" to listOf(selfPackage))) else emptyList())
        rules += obj("rule_set" to listOf("service-block"), "action" to "reject")
        rules += obj("package_name" to listOf(selfPackage), "outbound" to "rt-service")
        val ru = if (data.settings.ruDirect) listOf(obj("domain_suffix" to listOf("ru", "su", "xn--p1ai"))) else emptyList()
        set("ru-direct", ru); rules += obj("rule_set" to listOf("ru-direct"), "outbound" to DIRECT)
        val dnsRules = mutableListOf(obj("rule_set" to listOf(DNS_GUARD), "action" to "reject"))
        val dnsBuckets = linkedMapOf<String, MutableList<JSONObject>>()
        dnsBuckets["reject"] = mutableListOf()
        servers.forEach { dnsBuckets[it.getString("tag")] = mutableListOf() }
        val precedingDns = mutableListOf<JSONObject>()
        val plans = mutableListOf<CompiledRoute>()
        val fallbacks = linkedMapOf<String, Pair<String, String>>()
        val routeById = data.routes.associateBy { it.id }
        for ((prefix, slots) in listOf("a" to appSlots, "d" to destinationSlots)) for ((index, id) in slots.withIndex()) {
            val name = "$prefix$index"
            val route = routeById[id]?.takeIf { it.enabled }
            val target = route?.via?.let(::tag)
            val fallback = route?.fallback?.takeIf { it != DIRECT && it != route.via }?.let(::tag)
            val match = route?.let(::matches).orEmpty()
            set("r$name", if (target != null) match else emptyList())
            set("x$name", if (route != null && target == null) match else emptyList())
            set("v$name", if (route != null && target != null && (!v6(route.via) || fallback != null && !v6(route.fallback!!))) match else emptyList())
            selector("rt-$name", target ?: DIRECT)
            rules += obj("rule_set" to listOf("x$name"), "action" to "reject")
            rules += obj("rule_set" to listOf("v$name"), "ip_version" to 6, "action" to "reject")
            rules += obj("rule_set" to listOf("r$name"), "outbound" to "rt-$name")
            servers += obj("type" to "https", "server" to "1.1.1.1", "tag" to "dns-rt-$name", "detour" to "rt-$name")
            dnsBuckets["dns-rt-$name"] = mutableListOf()
            if (route != null) {
                if (target != null && target != DIRECT && fallback != null) fallbacks["rt-$name"] = route.via to route.fallback!!
                val dns = when { target == null -> "reject"; target == DIRECT -> "local"; "rt-$name" in fallbacks -> "dns-rt-$name"; else -> "dns-${route.via}" }
                val dnsMatches = match.filterNot { it.has("ip_cidr") }
                if (dnsMatches.isNotEmpty()) {
                    val own = or(dnsMatches)
                    dnsBuckets.getValue(dns).add(if (precedingDns.isEmpty()) own else and(own, not(or(precedingDns.toList()))))
                    precedingDns += own
                }
                plans += CompiledRoute(route.id, route.via, if (target == null) null else "rt-$name", fallback)
            }
        }
        val ownerGuard = data.settings.defaultVia == DIRECT && (data.settings.serviceVia != DIRECT || data.routes.any { it.enabled && it.kind == "app" && it.via != DIRECT })
        set("owner-guard", if (ownerGuard) listOf(obj("package_name_regex" to listOf(".+"), "invert" to true)) else emptyList())
        rules += obj("rule_set" to listOf("owner-guard"), "action" to "reject")
        val rest = tag(data.settings.defaultVia)
        gate("rest-block", rest == null); gate("rest-v6", rest != null && !v6(data.settings.defaultVia))
        rules += obj("rule_set" to listOf("rest-block"), "action" to "reject")
        rules += obj("rule_set" to listOf("rest-v6"), "ip_version" to 6, "action" to "reject")
        selector("rt-rest", rest ?: DIRECT)
        val system = RoutingCompiler.systemDnsPolicy(data)
        val systemSlot = plans.find { it.routeId == system.routeId }?.targetTag
        val systemServer = when { system.blocked || system.via?.let(::tag) == null -> "reject"
            system.via == DIRECT -> "local"
            systemSlot in fallbacks -> "dns-$systemSlot"
            else -> "dns-${system.via}" }
        val restServer = when { rest == null -> "reject"; rest == DIRECT -> "local"; else -> "dns-${data.settings.defaultVia}" }
        val serviceServer = when { service == null -> "reject"; service == DIRECT -> "local"; else -> "dns-${data.settings.serviceVia}" }
        val serverKeys = dnsBuckets.keys.toList()
        fun dnsRule(target: String, setTag: String) = obj("rule_set" to listOf(setTag)).apply {
            if (target == "reject") put("action", "reject") else put("server", target)
        }
        for ((i, server) in serverKeys.withIndex()) {
            if (server.startsWith("dns-rt-")) continue
            set("service-dns-$i", if (serviceServer == server) listOf(obj("package_name" to listOf(selfPackage))) else emptyList())
            dnsRules += dnsRule(server, "service-dns-$i")
        }
        dnsRules += obj("rule_set" to listOf("ru-direct"), "server" to "local")
        for ((i, server) in serverKeys.withIndex()) {
            set("dns-$i", dnsBuckets.getValue(server))
            dnsRules += dnsRule(server, "dns-$i")
        }
        for ((i, server) in serverKeys.withIndex()) {
            gate("system-dns-$i", systemServer == server, dns = true)
            dnsRules += dnsRule(server, "system-dns-$i").put("user_id", jsonArray(listOf(1051)))
            dnsRules += obj("type" to "logical", "mode" to "and", "rules" to listOf(
                obj("rule_set" to listOf("system-dns-$i")), obj("package_name_regex" to listOf(".+"), "invert" to true))).apply {
                if (server == "reject") put("action", "reject") else put("server", server)
            }
        }
        for ((i, server) in serverKeys.withIndex()) {
            if (server.startsWith("dns-rt-")) continue
            gate("rest-dns-$i", restServer == server, dns = true)
            dnsRules += dnsRule(server, "rest-dns-$i")
        }
        // Each native local rule-set owns an inotify instance on Android. Leave
        // room below the common per-UID limit (128), including other core watchers.
        // A large policy remains supported by the ordinary compiler, with an honest
        // structural update instead of silently starting broken file watchers.
        if (files.size > maximumWatchers) return base.copy(liveUpdateNote = WATCHER_LIMIT_NOTE)
        dnsRules.addAll(0, listOf(
            obj("type" to "logical", "mode" to "and", "rules" to listOf(
                obj("domain_suffix" to listOf(CANARY_ZONE)),
                obj("rule_set" to files.keys.toList(), "rule_set_ip_cidr_match_source" to true)),
                "action" to "predefined", "rcode" to "NOERROR", "answer" to listOf("$CANARY_ZONE. IN A $CANARY_IP")),
            obj("domain_suffix" to listOf(CANARY_ZONE), "action" to "predefined", "rcode" to "NXDOMAIN")))
        config.put("outbounds", jsonArray(outbounds)).put("endpoints", jsonArray(endpoints))
        config.getJSONObject("dns").put("servers", jsonArray(servers)).put("rules", jsonArray(dnsRules)).put("final", "local")
        config.getJSONObject("route").put("rules", jsonArray(rules)).put("final", "rt-rest")
            .put("rule_set", jsonArray(files.keys.map { obj("type" to "local", "format" to "source", "tag" to it, "path" to File(directory, fileName(it)).absolutePath) }))
        val structural = JSONObject(config.toString()).also { root -> root.getJSONArray("outbounds").objects()
            .filter { it.getString("tag").startsWith("rt-") }.forEach { it.remove("default") } }.toString()
        val signature = MessageDigest.getInstance("SHA-256").digest(structural.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val live = MobileLivePlan(directory, appSlots, destinationSlots, files, selections, signature, selfPackage)
        return base.copy(json = config.toString(), loadedProfiles = (outbounds + endpoints).map { it.getString("tag") }.filter { it.startsWith("p-") }.map { it.removePrefix("p-") },
            routes = plans, selectorTargets = fallbacks, live = live)
    }

    /** Only changed match coverage is blocked while file and selector acknowledgements settle. */
    fun guards(before: MobileLivePlan, after: MobileLivePlan): Map<String, String> {
        require(before.compatible(after))
        val routing = mutableListOf<JSONObject>(); val dns = mutableListOf<JSONObject>()
        for (tag in before.files.keys) if (tag !in setOf(ROUTE_GUARD, DNS_GUARD) && before.files[tag] != after.files[tag]) {
            val all = listOf(before.files.getValue(tag), after.files.getValue(tag)).flatMap { JSONObject(it).getJSONArray("rules").objects() }
            if (tag.contains("dns-") || tag == "ru-direct") dns += all
            if (!tag.contains("dns-")) routing += if (tag == "lan-direct") listOf(obj("ip_cidr" to privateRanges)) else all
        }
        for (selector in before.selections.keys) if (before.selections[selector] != after.selections[selector]) {
            if (selector == "rt-rest") routing += anyTraffic()
            else if (selector == "rt-service") routing += obj("package_name" to listOf(before.selfPackage))
            else if (selector.startsWith("grp-")) {
                for (plan in listOf(before, after)) for ((routeSelector, target) in plan.selections) if (target == selector) {
                    if (routeSelector == "rt-rest") routing += anyTraffic()
                    else if (routeSelector.startsWith("rt-") && routeSelector != "rt-service")
                        routing += JSONObject(plan.files.getValue("r" + routeSelector.removePrefix("rt-"))).getJSONArray("rules").objects()
                }
            } else for (plan in listOf(before, after)) routing += JSONObject(plan.files.getValue("r" + selector.removePrefix("rt-"))).getJSONArray("rules").objects()
        }
        return mapOf(ROUTE_GUARD to body(routing.distinctBy(JSONObject::toString)), DNS_GUARD to body(dns.distinctBy(JSONObject::toString)))
    }
}
