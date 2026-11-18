package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Regression for Android netd-owned DNS: no fabricated package and no implicit Direct escape. */
class SystemDnsPolicyTest {
    private fun proxy(id: String) = ProfileImporter.link("trojan://test-$id@192.0.2.1:443").copy(id = id, name = id)
    private fun app(id: String, via: String, fallback: String? = null) =
        TrafficRoute(id, id, "app", "com.example.$id", via, fallback)
    private fun node(data: AppData) = JSONObject(RoutingCompiler.compile(data).json)
    private fun netd(node: JSONObject) = node.getJSONObject("dns").getJSONArray("rules").objects()
        .single { it.optJSONArray("user_id")?.optInt(0) == 1051 }

    @Test fun serviceOnlyTunnelProtectsSharedDnsAndUnattributedTraffic() {
        val data = AppData(profiles = listOf(proxy("service")), settings = AppSettings(serviceVia = "service"))
        assertEquals("service", RoutingCompiler.systemDnsPolicy(data).via)
        val config = node(data)
        assertEquals("dns-service", netd(config).getString("server"))
        assertTrue(config.getJSONObject("route").getJSONArray("rules").objects()
            .any { it.has("package_name_regex") && it.optBoolean("invert") && it.optString("action") == "reject" })
    }

    @Test fun differentServiceAndAppDnsRequireAnExplicitCommonChoice() {
        val data = AppData(profiles = listOf(proxy("service"), proxy("app")),
            settings = AppSettings(serviceVia = "service"), routes = listOf(app("browser", "app")))
        assertTrue(RoutingCompiler.systemDnsPolicy(data).blocked)
        assertEquals("reject", netd(node(data)).getString("action"))
        val same = data.copy(settings = AppSettings(serviceVia = "app"))
        assertFalse(RoutingCompiler.systemDnsPolicy(same).blocked)
        assertEquals("dns-app", netd(node(same)).getString("server"))
        assertEquals("local", netd(node(data.copy(settings = data.settings.copy(systemDnsVia = DIRECT)))).getString("server"))
        assertEquals("dns-app", netd(node(data.copy(settings = data.settings.copy(defaultVia = "app")))).getString("server"))
    }

    @Test fun oldStoresDefaultToAutomaticAndExplicitDirectSurvivesRoundTrip() {
        assertNull(AppSettings.fromJson(JSONObject("{}" )).systemDnsVia)
        val explicit = AppSettings(systemDnsVia = DIRECT)
        assertEquals(DIRECT, AppSettings.fromJson(explicit.json()).systemDnsVia)
        assertNull(AppSettings.fromJson(explicit.copy(systemDnsVia = null).json()).systemDnsVia)
    }

    @Test fun aSingleProtectedAppPathAlsoProtectsNetdWithoutInventingItsPackage() {
        val data = AppData(profiles = listOf(proxy("one")), routes = listOf(app("browser", "one")))
        val rule = netd(node(data))
        assertEquals("dns-one", rule.getString("server"))
        assertFalse(rule.has("package_name"))
        assertFalse(RoutingCompiler.systemDnsPolicy(data).blocked)
    }

    @Test fun differentAppPathsBlockOnlyUnattributedDnsUntilAnExplicitChoice() {
        val data = AppData(profiles = listOf(proxy("one"), proxy("two")),
            routes = listOf(app("browser", "one"), app("chat", "two")))
        val config = node(data)
        assertEquals("reject", netd(config).getString("action"))
        assertTrue(RoutingCompiler.systemDnsPolicy(data).blocked)
        val attributed = config.getJSONObject("dns").getJSONArray("rules").objects()
            .filter { it.stringList("package_name").any { name -> name.startsWith("com.example.") } }
        assertEquals(setOf("dns-one", "dns-two"), attributed.map { it.getString("server") }.toSet())
        assertEquals("local", netd(node(data.copy(settings = AppSettings(systemDnsVia = DIRECT)))).getString("server"))
    }

    @Test fun explicitDnsOnlyProfileAndGroupAreLoadedAndKeepTheirDetour() {
        val group = TunnelGroup("g-dns", "DNS", members = listOf("dns"))
        val data = AppData(profiles = listOf(proxy("web"), proxy("dns")), groups = listOf(group),
            routes = listOf(app("browser", "web")), settings = AppSettings(systemDnsVia = group.id))
        val compiled = RoutingCompiler.compile(data)
        val config = JSONObject(compiled.json)
        assertEquals(setOf("web", "dns"), compiled.loadedProfiles.toSet())
        assertEquals("dns-${group.id}", netd(config).getString("server"))
        val resolver = config.getJSONObject("dns").getJSONArray("servers").objects().single { it.optString("tag") == "dns-${group.id}" }
        assertEquals("grp-${group.id}", resolver.getString("detour"))
        assertEquals("dns-dns", netd(node(data.copy(settings = AppSettings(systemDnsVia = "dns")))).getString("server"))
    }

    @Test fun deletedRevokedAndEmptyExplicitDnsPathsStayBlocked() {
        val unavailable = proxy("gone").copy(revoked = true)
        for (path in listOf("deleted", "gone", "g-empty")) {
            val data = AppData(profiles = listOf(proxy("live"), unavailable),
                groups = listOf(TunnelGroup("g-empty", "Empty", members = listOf("gone"))),
                settings = AppSettings(defaultVia = "live", systemDnsVia = path))
            val compiled = RoutingCompiler.compile(data)
            assertEquals("reject", netd(JSONObject(compiled.json)).getString("action"))
            assertTrue(path in compiled.blockedPaths)
            assertTrue(RoutingCompiler.systemDnsPolicy(data).blocked)
        }
    }

    @Test fun commonPrimaryAndFallbackUseTheSameLiveSelectorForSystemDns() {
        val data = AppData(profiles = listOf(proxy("one"), proxy("two")),
            routes = listOf(app("browser", "one", "two"), app("chat", "one", "two")))
        val config = node(data)
        val tag = netd(config).getString("server")
        val resolver = config.getJSONObject("dns").getJSONArray("servers").objects().single { it.optString("tag") == tag }
        val selector = config.getJSONArray("outbounds").objects().single { it.optString("tag") == resolver.getString("detour") }
        assertEquals(listOf("p-one", "p-two"), selector.stringList("outbounds"))
        assertFalse(RoutingCompiler.systemDnsPolicy(data).blocked)
        val conflicting = data.copy(routes = data.routes + app("mail", "one"))
        assertEquals("reject", netd(node(conflicting)).getString("action"))
    }

    @Test fun domainRulesKeepPriorityAndWholeDevicePathSuppliesSharedDns() {
        val data = AppData(profiles = listOf(proxy("global"), proxy("web")),
            routes = listOf(app("browser", "web"), TrafficRoute("domain", "Domain", "custom", "example.test", "web")),
            settings = AppSettings(defaultVia = "global"))
        val config = node(data)
        assertEquals("dns-global", netd(config).getString("server"))
        val rules = config.getJSONObject("dns").getJSONArray("rules").objects()
        assertTrue(rules.indexOfFirst { it.has("domain_suffix") } < rules.indexOfFirst { it.has("user_id") })
    }

    @Test fun explicitDnsCannotBypassTheNativeResourceBudget() {
        val profiles = (0..RoutingCompiler.LIVE_PROFILE_LIMIT).map { proxy("p$it") }
        val full = TunnelGroup("g-full", "Full", members = profiles.dropLast(1).map { it.id })
        assertThrows(IllegalArgumentException::class.java) {
            RoutingCompiler.compile(AppData(profiles = profiles, groups = listOf(full),
                settings = AppSettings(defaultVia = full.id, systemDnsVia = profiles.last().id)))
        }
    }

    @Test fun whenAutoCannotFitAFullNativeBudgetSharedDnsKeepsTheRealPrimary() {
        val public = (0 until RoutingCompiler.LIVE_PROFILE_LIMIT).map { proxy("public$it").copy(source = "public") }
        val full = TunnelGroup("g-full", "Full", members = public.map { it.id })
        val data = AppData(profiles = public + proxy("private"), groups = listOf(full),
            routes = listOf(app("browser", public.first().id, AUTO),
                TrafficRoute("domain", "Domain", "custom", "example.test", full.id)))
        val compiled = RoutingCompiler.compile(data)
        assertEquals(RoutingCompiler.LIVE_PROFILE_LIMIT, compiled.loadedProfiles.size)
        assertTrue(compiled.groups.none { it.id == AUTO })
        assertTrue(compiled.selectorTargets.isEmpty())
        val config = JSONObject(compiled.json)
        assertEquals("dns-${public.first().id}", netd(config).getString("server"))
        assertTrue(config.getJSONObject("dns").getJSONArray("servers").objects()
            .any { it.optString("tag") == netd(config).getString("server") })
    }

    @Test fun temporarilyUnknownOwnersUseTheSameProtectedOrBlockedDnsPolicyAsNetd() {
        val data = AppData(profiles = listOf(proxy("one"), proxy("two")), routes = listOf(app("browser", "one")))
        for (value in listOf(data, data.copy(routes = data.routes + app("chat", "two")))) {
            val config = node(value)
            val unknown = config.getJSONObject("dns").getJSONArray("rules").objects().single { it.has("package_name_regex") }
            assertEquals(listOf(".+"), unknown.stringList("package_name_regex"))
            assertTrue(unknown.getBoolean("invert"))
            assertEquals(netd(config).optString("server"), unknown.optString("server"))
            assertEquals(netd(config).optString("action"), unknown.optString("action"))
        }
    }

    @Test fun unknownTrafficCannotEscapeProtectedAppRulesThroughDefaultDirect() {
        val data = AppData(profiles = listOf(proxy("one")), routes = listOf(app("browser", "one")))
        val rules = node(data).getJSONObject("route").getJSONArray("rules").objects()
        val guard = rules.single { it.has("package_name_regex") }
        assertTrue(guard.getBoolean("invert"))
        assertEquals("reject", guard.getString("action"))
        assertTrue(rules.indexOf(guard) > rules.indexOfFirst { it.stringList("package_name") == listOf("com.example.browser") })
        for (value in listOf(data.copy(settings = AppSettings(defaultVia = "one")), data.copy(routes = emptyList()))) {
            assertFalse(node(value).getJSONObject("route").getJSONArray("rules").objects().any { it.has("package_name_regex") })
        }
    }
}
