// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MobileLiveRoutingTest {
    private fun proxy(id: String) = TunnelProfile(id, id, "Trojan", "192.0.2.1", 443,
        obj("type" to "trojan", "server" to "192.0.2.1", "server_port" to 443, "password" to "synthetic-$id",
            "tls" to obj("enabled" to true, "server_name" to "example.test")).toString())
    private fun route(id: String, via: String = "one", enabled: Boolean = true) = TrafficRoute(id, id, "custom", "$id.example.test", via, enabled = enabled)
    private fun compile(data: AppData, old: CompiledConfiguration? = null, selected: Map<String, String> = emptyMap()) =
        MobileLiveRouting.compile(data, "local.waarp.test", "two", "/private/routing/test", old, selected)
    private val initial = AppData(profiles = listOf(proxy("one"), proxy("two")), routes = listOf(route("first"), route("second", "two")))
    private fun compatible(old: CompiledConfiguration, next: CompiledConfiguration) = assertEquals(old.live!!.signature, next.live!!.signature)

    @Test fun directToRealAndRealToRealUseTheSameNativeCoreAndEndpointDefinitions() {
        val direct = initial.copy(routes = listOf(route("first", DIRECT)))
        val a = compile(direct)
        val b = compile(direct.copy(routes = listOf(route("first", "one"))), a)
        val c = compile(direct.copy(routes = listOf(route("first", "two"))), b)
        compatible(a, b); compatible(b, c)
        assertEquals("direct", a.live!!.selections["rt-d0"])
        assertEquals("p-one", b.live!!.selections["rt-d0"])
        assertEquals("p-two", c.live!!.selections["rt-d0"])
        assertEquals(a.loadedProfiles.toSet(), c.loadedProfiles.toSet())
        assertTrue(MobileLiveRouting.guards(b.live!!, c.live!!).getValue(MobileLiveRouting.ROUTE_GUARD).contains("first.example.test"))
        assertFalse(MobileLiveRouting.guards(b.live!!, c.live!!).getValue(MobileLiveRouting.ROUTE_GUARD).contains("second.example.test"))
    }

    @Test fun toggleDeleteLastRouteAddAndReorderFitTheRunningSlots() {
        val a = compile(initial)
        val changes = listOf(
            initial.copy(routes = initial.routes.map { it.copy(enabled = false) }),
            initial.copy(routes = listOf(initial.routes.last())),
            initial.copy(routes = emptyList()),
            initial.copy(routes = initial.routes + route("third")),
            initial.copy(routes = initial.routes.reversed()),
            initial.copy(routes = initial.routes + route("disabled", enabled = false)))
        for (data in changes) compatible(a, compile(data, a))
        val empty = compile(initial.copy(routes = emptyList()), a)
        assertTrue(empty.routes.isEmpty())
        assertEquals("direct", empty.live!!.selections["rt-rest"])
        assertEquals(0, JSONObject(empty.live!!.files.getValue("rd0")).getJSONArray("rules").length())
    }

    @Test fun cosmeticInactiveAndLibraryRemovalDoNotGrowOrReplaceLivePool() {
        val many = initial.copy(profiles = (0..99).map { proxy("p$it") }, routes = emptyList())
        val a = compile(many)
        assertTrue(a.loadedProfiles.size <= 8)
        val b = compile(many.copy(profiles = many.profiles.map { it.copy(name = "renamed") }, settings = many.settings.copy(notifications = false)), a)
        compatible(a, b)
        assertEquals(a.live!!.files, b.live!!.files)
        assertEquals(a.loadedProfiles, b.loadedProfiles)
        val removed = compile(many.copy(profiles = many.profiles.drop(1)), b)
        compatible(b, removed)
        assertFalse(removed.groups.any { "p0" in it.members })
        val none = compile(many.copy(profiles = emptyList()), removed)
        compatible(removed, none)
        assertTrue(none.groups.isEmpty())
    }

    @Test fun autoWinnerIsPreservedAcrossNoOpEditsWithoutReorderingThePool() {
        val a = compile(initial.copy(settings = AppSettings(defaultVia = AUTO)))
        val b = compile(initial.copy(settings = AppSettings(defaultVia = AUTO, notifications = false)), a,
            mapOf("grp-$AUTO" to "p-two"))
        compatible(a, b)
        assertEquals("p-two", b.live!!.selections["grp-$AUTO"])
        assertEquals(a.live!!.files, b.live!!.files)
    }

    @Test fun fallbackUsesTheExistingRouteSelectorAndDoesNotAddANativeEndpoint() {
        val a = compile(initial)
        val b = compile(initial.copy(routes = listOf(initial.routes.first().copy(fallback = "two"), initial.routes.last())), a)
        compatible(a, b)
        assertEquals("one" to "two", b.selectorTargets["rt-d0"])
        assertFalse(JSONObject(b.json).getJSONArray("outbounds").objects().any { it.getString("tag").startsWith("fb-") })
    }

    @Test fun defaultsSystemDnsAndServiceRouteSwitchWithoutStructuralReload() {
        val a = compile(initial)
        for (settings in listOf(AppSettings(defaultVia = "two"), AppSettings(systemDnsVia = "two"),
            AppSettings(serviceVia = "one"), AppSettings(lanDirect = false, ruDirect = true))) {
            compatible(a, compile(initial.copy(settings = settings), a))
        }
        val b = compile(initial.copy(settings = AppSettings(serviceVia = "one")), a)
        assertEquals("p-one", b.live!!.selections["rt-service"])
        assertTrue(MobileLiveRouting.guards(a.live!!, b.live!!).getValue(MobileLiveRouting.ROUTE_GUARD).contains("local.waarp.test"))
    }

    @Test fun missingOrRevokedPathsRejectTrafficAndDnsRatherThanSelectingDirect() {
        val a = compile(initial)
        val b = compile(initial.copy(profiles = initial.profiles.map { if (it.id == "one") it.copy(revoked = true) else it }), a)
        compatible(a, b)
        assertNull(b.routes.first { it.routeId == "first" }.targetTag)
        assertEquals(1, JSONObject(b.live!!.files.getValue("xd0")).getJSONArray("rules").length())
        val rejectedDns = b.live!!.files.filterKeys { it.startsWith("dns-") }.values
            .any { it.contains("first.example.test") }
        assertTrue(rejectedDns)
    }

    @Test fun actualCredentialEditAndUnloadedDefinitionRequireExplicitStructuralChange() {
        val a = compile(initial)
        val changed = initial.copy(profiles = listOf(proxy("one").copy(config = proxy("one").config.replace("synthetic-one", "new-key")), proxy("two")))
        assertFalse(a.live!!.compatible(compile(changed, a).live!!))
        val added = initial.copy(profiles = initial.profiles + proxy("new"), routes = listOf(route("first", "new")))
        assertFalse(a.live!!.compatible(compile(added, a).live!!))
    }

    @Test fun watcherBudgetIsBoundedAndLargePoliciesUseTheOrdinaryCompiler() {
        val typical = compile(initial.copy(profiles = (0..99).map { proxy("p$it") }, routes = emptyList()))
        assertTrue(typical.live!!.files.size <= MobileLiveRouting.MAX_WATCHED_SETS)
        assertTrue(typical.loadedProfiles.size <= 4)
        val large = compile(initial.copy(routes = (0..100).map { route("r$it") }))
        assertNull(large.live)
        assertNotNull(large.liveUpdateNote)
        assertEquals(101, large.routes.size)
        assertFalse(JSONObject(large.json).getJSONObject("route").has("rule_set"))
        val constrained = MobileLiveRouting.compile(initial, "local.waarp.test", null, "/private/routing/test", maximumWatchers = 16)
        assertNull(constrained.live)
        assertNotNull(constrained.liveUpdateNote)
    }

    @Test fun disabledCardsBeyondSpareCapacityDoNotConsumeNativeSlots() {
        val a = compile(initial)
        val b = compile(initial.copy(routes = initial.routes + (0..99).map { route("disabled-$it", enabled = false) }), a)
        compatible(a, b)
        assertEquals(a.live!!.files, b.live!!.files)
        assertEquals(a.live!!.selections, b.live!!.selections)
        assertEquals(a.live!!.appSlots, b.live!!.appSlots)
        assertEquals(a.live!!.destinationSlots, b.live!!.destinationSlots)
    }

    @Test(timeout = 10_000) fun maximumActivePolicyFallsBackBeforeBuildingQuadraticDnsExclusions() {
        val data = initial.copy(routes = (0 until 2000).map { route("large-$it") })
        val result = compile(data)
        assertNull(result.live)
        assertNotNull(result.liveUpdateNote)
        assertEquals(2000, result.routes.size)
        val core = JSONObject(result.json)
        assertFalse(core.getJSONObject("route").has("rule_set"))
        assertTrue("Static policy must remain proportional to its route list", result.json.length < 1_000_000)
    }

    @Test fun witnessCannotBeAcknowledgedByBroadBusinessRulesAndUnknownOwnerInversionIsScoped() {
        val file = MobileLiveRouting.withWitness(MobileLiveRouting.body(listOf(obj("domain_regex" to listOf(".*")))), "file.${MobileLiveRouting.CANARY_ZONE}")
        val rules = JSONObject(file).getJSONArray("rules").objects()
        assertEquals(listOf("file.${MobileLiveRouting.CANARY_ZONE}"), rules.first().stringList("domain"))
        assertEquals(listOf("A"), rules.first().stringList("query_type"))
        assertTrue(rules[1].getJSONArray("rules").getJSONObject(0).getBoolean("invert"))
        val cfg = JSONObject(compile(initial).json)
        val dns = cfg.getJSONObject("dns").getJSONArray("rules").objects()
        val unknown = dns.filter { it.optString("type") == "logical" && it.optJSONArray("rules")?.objects()?.any { r -> r.has("package_name_regex") } == true }
        assertTrue(unknown.isNotEmpty())
        assertTrue(unknown.all { !it.optBoolean("invert") && it.getString("mode") == "and" })
        assertTrue(dns.first().getJSONArray("rules").getJSONObject(1).getBoolean("rule_set_ip_cidr_match_source"))
    }
}
