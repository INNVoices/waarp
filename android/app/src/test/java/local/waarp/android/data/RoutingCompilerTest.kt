package local.waarp.android.data

import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Validates the generated sing-box policy. Actual socket/TUN behaviour is a separate device test. */
class RoutingCompilerTest {
    private fun proxy(id: String, source: String = "personal", revoked: Boolean = false, missing: Boolean = false): TunnelProfile =
        ProfileImporter.link("trojan://test-$id@192.0.2.1:443").copy(id = id, name = id, source = source, revoked = revoked, subscriptionMissing = missing)
    private fun wg(id: String, version: Int = 0, v6Address: Boolean = false, v6Allowed: Boolean = false): TunnelProfile {
        val key = Base64.getEncoder().encodeToString(ByteArray(32) { (it + 1).toByte() })
        val conf = """
            [Interface]
            PrivateKey = $key
            Address = 10.8.0.2/32${if (v6Address) ", fd00::2/128" else ""}
            DNS = 10.8.0.1
            ${if (version == 1) "Jc = 3" else if (version == 2) "S3 = 4" else ""}
            [Peer]
            PublicKey = $key
            AllowedIPs = 0.0.0.0/0${if (v6Allowed) ", ::/0" else ""}
            Endpoint = 192.0.2.2:51820
        """.trimIndent()
        return ProfileImporter.parse(conf).profiles.single().copy(id = id)
    }
    private fun route(id: String, via: String, kind: String = "custom", match: String = "$id.example.test", fallback: String? = null, enabled: Boolean = true) =
        TrafficRoute(id, id, kind, match, via, fallback, enabled)
    private fun config(data: AppData) = JSONObject(RoutingCompiler.compile(data).json)
    private fun routeRules(node: JSONObject) = node.getJSONObject("route").getJSONArray("rules").objects()
    private fun dnsRules(node: JSONObject) = node.getJSONObject("dns").getJSONArray("rules").objects()

    @Test fun appRulesPrecedeAddressAndPresetRulesRegardlessOfCreationOrder() {
        val data = AppData(profiles = listOf(proxy("app"), proxy("site"), proxy("service")), routes = listOf(
            route("preset", "service", "preset", "youtube"), route("site", "site", match = "youtube.com"),
            route("app", "app", "app", "com.example.browser")), settings = AppSettings(lanDirect = false))
        val rules = routeRules(config(data))
        val app = rules.indexOfFirst { it.stringList("package_name") == listOf("com.example.browser") }
        val site = rules.indexOfFirst { it.stringList("domain_suffix") == listOf("youtube.com") }
        val service = rules.indexOfFirst { it.stringList("domain_suffix").contains("googlevideo.com") }
        assertTrue(app >= 0 && app < site && site < service)
        assertEquals("p-app", rules[app].getString("outbound"))
        assertEquals("p-site", rules[site].getString("outbound"))
    }

    @Test fun missingPrimaryAndMissingDefaultAreExplicitlyRejectedForDnsAndTraffic() {
        val node = config(AppData(routes = listOf(route("gone", "deleted")), settings = AppSettings(defaultVia = "deleted", lanDirect = false)))
        val targeted = routeRules(node).first { it.stringList("domain_suffix") == listOf("gone.example.test") }
        assertEquals("reject", targeted.getString("action"))
        assertFalse(targeted.has("outbound"))
        assertEquals("reject", routeRules(node).last().getString("action"))
        assertEquals("reject", dnsRules(node).last().getString("action"))
        assertTrue(dnsRules(node).any { it.stringList("domain_suffix") == listOf("gone.example.test") && it.optString("action") == "reject" })
    }

    @Test fun fallbackIsAnExplicitTunnelSelectorWithMatchingDnsDetour() {
        val data = AppData(profiles = listOf(proxy("primary"), proxy("backup")), routes = listOf(route("site", "primary", fallback = "backup")))
        val compiled = RoutingCompiler.compile(data)
        val node = JSONObject(compiled.json)
        val selector = node.getJSONArray("outbounds").objects().single { it.optString("tag") == "fb-site" }
        assertEquals(listOf("p-primary", "p-backup"), selector.stringList("outbounds"))
        assertEquals("p-primary", selector.getString("default"))
        assertEquals("primary" to "backup", compiled.selectorTargets["fb-site"])
        val dns = node.getJSONObject("dns").getJSONArray("servers").objects().single { it.getString("tag") == "dns-fb-site" }
        assertEquals("fb-site", dns.getString("detour"))
        assertTrue(dnsRules(node).any { it.stringList("domain_suffix") == listOf("site.example.test") && it.optString("server") == "dns-fb-site" })
    }

    @Test fun directFallbackNeverBecomesAnAutomaticEscapePath() {
        val compiled = RoutingCompiler.compile(AppData(profiles = listOf(proxy("primary")), routes = listOf(route("site", "primary", fallback = DIRECT))))
        val node = JSONObject(compiled.json)
        assertTrue(compiled.selectorTargets.isEmpty())
        assertFalse(node.getJSONArray("outbounds").objects().any { it.optString("tag") == "fb-site" })
        assertEquals("p-primary", routeRules(node).first { it.stringList("domain_suffix") == listOf("site.example.test") }.getString("outbound"))
    }

    @Test fun fallbackGroupMembersAreLoadedAndMissingMembersAreExcluded() {
        val group = TunnelGroup("g-backup", "Backup", "first", listOf("b", "missing", "c"))
        val compiled = RoutingCompiler.compile(AppData(profiles = listOf(proxy("a"), proxy("b"), proxy("c")), groups = listOf(group), routes = listOf(route("site", "a", fallback = group.id))))
        assertEquals(setOf("a", "b", "c"), compiled.loadedProfiles.toSet())
        assertEquals(listOf("b", "c"), compiled.groups.single().members)
        val selector = JSONObject(compiled.json).getJSONArray("outbounds").objects().single { it.optString("tag") == "fb-site" }
        assertEquals(listOf("p-a", "grp-g-backup"), selector.stringList("outbounds"))
    }

    @Test fun revokedMissingSubscriptionAndEmptyGroupCannotAcquireDirectRoutes() {
        val data = AppData(profiles = listOf(proxy("revoked", revoked = true), proxy("missing", missing = true)),
            groups = listOf(TunnelGroup("g-empty", "No live members", members = listOf("revoked", "missing"))),
            routes = listOf(route("one", "revoked"), route("two", "missing"), route("three", "g-empty")))
        val compiled = RoutingCompiler.compile(data)
        assertTrue(compiled.loadedProfiles.isEmpty())
        assertEquals(setOf("revoked", "missing", "g-empty"), compiled.blockedPaths)
        assertTrue(compiled.routes.all { it.targetTag == null })
    }

    @Test fun disabledRoutesDoNotStartUnneededTunnelsOrAuto() {
        val compiled = RoutingCompiler.compile(AppData(profiles = listOf(proxy("own")), routes = listOf(route("off", AUTO, enabled = false))))
        assertTrue(compiled.loadedProfiles.isEmpty())
        assertTrue(compiled.groups.isEmpty())
        assertTrue(compiled.routes.isEmpty())
    }

    @Test fun autoPoolIsBoundedStableAndNeverIncludesPublicOrUnavailableProfiles() {
        val profiles = (0 until 200).map { proxy("own-$it") } + listOf(proxy("public", "public"), proxy("revoked", revoked = true), proxy("gone", missing = true))
        val data = AppData(profiles = profiles, routes = listOf(route("pinned", "own-150")), settings = AppSettings(defaultVia = AUTO))
        val compiled = RoutingCompiler.compile(data, previousAuto = "own-180")
        val pool = compiled.groups.single { it.id == AUTO }.members
        assertEquals("own-180", pool.first())
        assertTrue("own-150" in pool)
        assertEquals(RoutingCompiler.AUTO_LIMIT + 1, pool.size)
        assertFalse(pool.any { it in setOf("public", "revoked", "gone") })
        assertEquals(pool, RoutingCompiler.compile(data, previousAuto = "own-180").groups.single { it.id == AUTO }.members)
    }

    @Test fun wireGuardAndBothAmneziaVersionsBlockIpv6UnlessAddressAndAllowedIpsSupportIt() {
        for (version in 0..2) for ((hasAddress, hasAllowed) in listOf(false to false, true to false, false to true, true to true)) {
            val profile = wg("wg", version, hasAddress, hasAllowed)
            val node = config(AppData(profiles = listOf(profile), routes = listOf(route("site", "wg"))))
            val domainRules = routeRules(node).filter { it.stringList("domain_suffix") == listOf("site.example.test") }
            val rejectsV6 = domainRules.any { it.optInt("ip_version") == 6 && it.optString("action") == "reject" }
            assertEquals("protocol=${profile.protocol}, address=$hasAddress, allowed=$hasAllowed", !(hasAddress && hasAllowed), rejectsV6)
            assertFalse(node.getJSONArray("endpoints").getJSONObject(0).getBoolean("system"))
        }
    }

    @Test fun wireGuardDnsUsesItsOwnResolverThroughTheSameTunnel() {
        val node = config(AppData(profiles = listOf(wg("wg")), routes = listOf(route("site", "wg"))))
        val resolver = node.getJSONObject("dns").getJSONArray("servers").objects().single { it.getString("tag") == "dns-wg" }
        assertEquals("udp", resolver.getString("type"))
        assertEquals("10.8.0.1", resolver.getString("server"))
        assertEquals("p-wg", resolver.getString("detour"))
    }

    @Test fun selfPackageExemptionUsesActualBuildApplicationId() {
        val compiled = RoutingCompiler.compile(AppData(), selfPackage = "local.waarp.android.debug")
        val node = JSONObject(compiled.json)
        val rule = routeRules(node).single { it.stringList("package_name") == listOf("local.waarp.android.debug") }
        assertEquals(DIRECT, rule.getString("outbound"))
        assertEquals("local", dnsRules(node).single { it.stringList("package_name") == listOf("local.waarp.android.debug") }.getString("server"))
    }

    @Test fun addressValidationRejectsAmbiguousIpAndInvalidCidr() {
        listOf("999.0.0.1", "10.0.0.1/33", "2001:db8::1/129", "fe80::1%wlan0", "example.com/path", "user@example.com").forEach {
            assertThrows(RuntimeException::class.java) { AddressRules.selector(it) }
        }
        assertEquals("xn--e1afmkfd.xn--p1ai" to false, AddressRules.selector("https://пример.рф/"))
        assertEquals("2001:db8::1/128" to true, AddressRules.selector("2001:db8::1"))
        assertEquals("example.com" to false, AddressRules.selector("*.example.com"))
    }

    @Test fun totalLiveBudgetRejectsExplicitOverflowAndCapsAutoWithoutDroppingRequiredProfiles() {
        val profiles = (0 until RoutingCompiler.LIVE_PROFILE_LIMIT + 10).map { proxy("proxy-$it") }
        val tooMany = TunnelGroup("g-many", "Explicit", members = profiles.take(RoutingCompiler.LIVE_PROFILE_LIMIT + 1).map { it.id })
        assertThrows(RuntimeException::class.java) {
            RoutingCompiler.compile(AppData(profiles = profiles, groups = listOf(tooMany), settings = AppSettings(defaultVia = tooMany.id)))
        }
        val pinned = tooMany.copy(members = profiles.take(RoutingCompiler.LIVE_PROFILE_LIMIT - 1).map { it.id })
        val compiled = RoutingCompiler.compile(AppData(profiles = profiles, groups = listOf(pinned),
            routes = listOf(route("pinned", pinned.id)), settings = AppSettings(defaultVia = AUTO)))
        assertEquals(RoutingCompiler.LIVE_PROFILE_LIMIT, compiled.loadedProfiles.size)
        assertTrue(compiled.loadedProfiles.containsAll(pinned.members))
        assertEquals(pinned.members, compiled.groups.single { it.id == pinned.id }.members)
    }

    @Test fun endpointBudgetCapsAutoAndRejectsExplicitHeavyGroupOverflow() {
        val endpoints = (0..RoutingCompiler.LIVE_ENDPOINT_LIMIT).map { wg("wg-$it", version = it % 3) }
        val tooMany = TunnelGroup("g-heavy", "Heavy", members = endpoints.map { it.id })
        assertThrows(RuntimeException::class.java) {
            RoutingCompiler.compile(AppData(profiles = endpoints, groups = listOf(tooMany), settings = AppSettings(defaultVia = tooMany.id)))
        }
        val pinned = tooMany.copy(members = endpoints.take(RoutingCompiler.LIVE_ENDPOINT_LIMIT - 1).map { it.id })
        val profiles = endpoints + (0 until 20).map { proxy("proxy-$it") }
        val compiled = RoutingCompiler.compile(AppData(profiles = profiles, groups = listOf(pinned),
            routes = listOf(route("pinned", pinned.id)), settings = AppSettings(defaultVia = AUTO)), previousAuto = endpoints.last().id)
        val node = JSONObject(compiled.json)
        assertEquals(RoutingCompiler.LIVE_ENDPOINT_LIMIT, node.getJSONArray("endpoints").length())
        assertTrue(compiled.loadedProfiles.containsAll(pinned.members))
        assertTrue(endpoints.last().id in compiled.loadedProfiles)
        assertFalse(endpoints[endpoints.lastIndex - 1].id in compiled.loadedProfiles)
        assertTrue(compiled.loadedProfiles.size <= RoutingCompiler.LIVE_PROFILE_LIMIT)
    }
}
