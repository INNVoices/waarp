package local.waarp.android

import local.waarp.android.core.*
import local.waarp.android.data.*
import local.waarp.android.ui.*
import org.junit.Assert.*
import org.junit.Test

class MobileStateMapperTest {
    private fun profile(id: String, source: String = "personal") = TunnelProfile(id, "Profile $id", "trojan", "192.0.2.10", 443,
        """{"type":"trojan","server":"192.0.2.10","server_port":443,"password":"synthetic-$id","tls":{"enabled":true}}""", source = source)

    private fun snapshot(data: AppData = AppData()) = MobileStateSnapshot(data, RuntimeStatus(RuntimePhase.ON, startedAt = 100),
        emptyMap(), emptyList(), emptyList(), emptyList(), emptyList(), true, false, null,
        0, emptyMap(), emptyList(), CatalogUi(), emptyMap(), null, null, "test")

    @Test fun telemetryKeepsLargeUnchangedSectionsWhileUpdatingCounters() {
        val profiles = List(2000) { profile("p$it") }
        val routes = List(2000) { TrafficRoute("r$it", "Route $it", "custom", "host$it.example.test", "p$it") }
        val groups = List(250) { TunnelGroup("g-$it", "Group $it", members = listOf("p${it * 2}", "p${it * 2 + 1}")) }
        val input = snapshot(AppData(profiles, groups, routes)).copy(apps = List(1000) { AppUi("test.app$it", "App $it", 10000 + it) })
        val mapper = MobileStateMapper()
        val initial = mapper.map(input)
        repeat(200) { tick ->
            val next = mapper.map(input.copy(runtime = input.runtime.copy(downloadBytes = tick.toLong(), downloadBps = tick.toLong())))
            assertSame(initial.profiles, next.profiles)
            assertSame(initial.routes, next.routes)
            assertSame(initial.groups, next.groups)
            assertSame(initial.apps, next.apps)
            assertSame(initial.catalog, next.catalog)
            assertSame(initial.notices, next.notices)
            assertEquals(tick.toLong(), next.status.downloadedBytes)
        }
    }

    @Test fun fallbackCannotClaimWorkingWhenItsLastMeasurementsAreDown() {
        val input = snapshot(AppData(profiles = listOf(profile("one"), profile("two")),
            routes = listOf(TrafficRoute("r", "Route", "custom", "example.test", "one", "two"))))
            .copy(nativeGroups = listOf(RuntimeGroup("fb-r", "selector", true, "p-two", emptyList())),
                measured = mapOf("one" to ProbeHealth(failures = 2, checkedAt = 300), "two" to ProbeHealth(20, 0, 300, 300)))
        val mapper = MobileStateMapper()
        assertEquals(RouteState.FALLBACK, mapper.map(input).routes.single().state)
        val failed = mapper.map(input.copy(measured = input.measured + ("two" to ProbeHealth(failures = 2, checkedAt = 400))))
        assertEquals(RouteState.BLOCKED, failed.routes.single().state)
        assertTrue(failed.routes.single().reason!!.contains("две последовательные"))
        val recovered = mapper.map(input.copy(measured = input.measured + ("two" to ProbeHealth(10, 0, 500, 500))))
        assertEquals(RouteState.FALLBACK, recovered.routes.single().state)
    }

    @Test fun compiledBudgetRejectionIsBlockedOnlyForTheRunningConfiguration() {
        val input = snapshot(AppData(profiles = listOf(profile("one")),
            routes = listOf(TrafficRoute("r", "Route", "custom", "example.test", "one"))))
            .copy(measured = mapOf("one" to ProbeHealth(10, 0, 300, 300)))
        val mapper = MobileStateMapper()
        assertEquals(RouteState.OK, mapper.map(input).routes.single().state)
        val blocked = input.copy(compiledRoutes = listOf(CompiledRoute("r", "one", null)))
        assertEquals(RouteState.BLOCKED, mapper.map(blocked).routes.single().state)
        assertEquals(RouteState.IDLE, mapper.map(blocked.copy(runtime = RuntimeStatus())).routes.single().state)
    }

    @Test fun profileAndGroupRenameAndCatalogDeletionInvalidateTheirOwnProjection() {
        val catalogProfile = profile("public", "public")
        val saved = catalogProfile.copy(id = "saved", name = "Imported")
        val input = snapshot(AppData(profiles = listOf(saved), groups = listOf(TunnelGroup("g-list", "Before", members = listOf(saved.id)))))
            .copy(catalogProfiles = listOf(catalogProfile))
        val mapper = MobileStateMapper()
        val first = mapper.map(input)
        assertTrue(first.catalog.nodes.single().added)
        val data = checkNotNull(input.data)
        val renamed = mapper.map(input.copy(data = data.copy(profiles = listOf(saved.copy(name = "After")),
            groups = listOf(data.groups.single().copy(name = "Renamed group")))))
        assertEquals("After", renamed.profiles.single().name)
        assertEquals("Renamed group", renamed.groups.first().name)
        assertTrue(renamed.catalog.nodes.single().added)
        assertFalse(mapper.map(input.copy(data = AppData())).catalog.nodes.single().added)
    }

    @Test fun logRingPreservesSurvivingRowsAndDistinguishesEqualEvents() {
        val events = List(500) { RuntimeLog(1000, 2, "same event") }
        val projection = LogProjection()
        val first = projection.map(events)
        assertEquals(500, first.map { it.id }.toSet().size)
        assertSame(first, projection.map(events))
        val next = projection.map(events.drop(1) + RuntimeLog(1001, 2, "new event"))
        assertEquals(first.drop(1).map { it.id }, next.dropLast(1).map { it.id })
        assertSame(first[1], next[0])
        assertFalse(first.any { it.id == next.last().id })
        assertTrue(projection.map(emptyList()).isEmpty())
    }
}
