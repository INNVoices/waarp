// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class PublicCatalogTest {
    private val source = PublicCatalog.SOURCES.first()
    private fun link(host: String = "11.22.33.44", name: String = "sample") =
        "vless://1d954d22-d9b9-4ce1-ae89-62051fa9b117@$host:443?security=tls&type=tcp&sni=example.com#$name"
    private fun node(id: String, host: String = "11.22.33.44", protocol: String = "VLESS", country: String = "") =
        TunnelProfile(id = id, name = id, protocol = protocol, host = host, port = 443, source = "public", country = country,
            config = obj("type" to "vless", "server" to host, "server_port" to 443, "uuid" to id).toString())

    @Test fun registryIsExplicitAndMirrorsAreNotAdditionalSources() {
        assertEquals(7, PublicCatalog.SOURCES.size)
        assertEquals(7, PublicCatalog.SOURCES.map { it.id }.distinct().size)
        assertTrue(PublicCatalog.SOURCES.any { it.id == "barry" && it.provenance.license == "MIT" })
        assertTrue(PublicCatalog.SOURCES.any { it.id == "mahdibland-public" && it.url.endsWith("/Eternity.txt") })
        assertFalse(PublicCatalog.SOURCES.flatMap { it.endpoints }.any { it.contains("Epodonios") || it.contains("EternityAir") })
        assertTrue(PublicCatalog.SOURCES.filter { it.id.startsWith("igareck-") }.all {
            it.mirrors.size == 3 && it.provenance.mirrorDocumentation?.endsWith("MIRRORS.md") == true
        })
    }

    @Test fun linksAndBase64HaveTheSameIdentityAndNoRemoteRuntimeConfigurationIsImported() {
        val raw = link()
        val one = PublicCatalog.parse(source, raw).single()
        val encoded = Base64.getEncoder().encodeToString(raw.toByteArray())
        assertEquals(one.id, PublicCatalog.parse(source, encoded).single().id)
        assertEquals("public", one.source)
        assertThrows(IllegalArgumentException::class.java) { PublicCatalog.parse(source, "<html>${link()}</html>") }
        assertThrows(IllegalArgumentException::class.java) { PublicCatalog.parse(source, "{\"outbounds\":[\"${link()}\"]}") }
        assertThrows(IllegalArgumentException::class.java) { PublicCatalog.parse(source, "proxies:\n  - ${link()}") }
        assertThrows(IllegalArgumentException::class.java) { PublicCatalog.parse(source, link("127.0.0.1")) }
    }

    @Test fun invalidHttp200BodyUsesTheDocumentedMirrorAndCancellationDoesNot() = runBlocking {
        val mirrored = PublicCatalog.SOURCES.first { it.id == "igareck-vless" }
        val tried = mutableListOf<String>()
        val result = PublicCatalog.loadSource(mirrored) { actual, url, limit ->
            assertEquals(mirrored, actual); assertEquals(PublicCatalog.MAX_SOURCE_BYTES, limit)
            tried.add(url)
            if (url == mirrored.url) "<html>blocked</html>" else link()
        }
        assertEquals(listOf(mirrored.url, mirrored.mirrors.first()), tried)
        assertEquals(1, result.size)
        tried.clear()
        try {
            PublicCatalog.loadSource(mirrored) { _, url, _ -> tried.add(url); throw CancellationException("cancel") }
            fail("Cancellation must propagate")
        } catch (_: CancellationException) { /* expected */ }
        assertEquals(listOf(mirrored.url), tried)
    }

    @Test fun aLargeFirstSourceCannotStarveSmallerFeedsAndDuplicatesDoNotConsumeSlots() {
        val large = (1..20).map { node("large-$it", "11.22.33.$it") }
        val small = listOf(node("small", "22.33.44.55"))
        assertEquals(listOf("large-1", "small", "large-2", "large-3"),
            PublicCatalog.fairPool(listOf(large, small), 4).map { it.id })
        assertEquals(4, PublicCatalog.fairPool(listOf(large, listOf(large.first())), 4).size)
    }

    @Test fun refreshKeepsUsefulOldCandidatesAndNeverCopiesPrivateOrRevokedProfilesIntoThePool() {
        val old = (1..8).map { node("old-$it", "11.22.33.$it").copy(addedAt = 10) }
        val fresh = (1..8).map { node("new-$it", "22.33.44.$it") }
        val merged = PublicCatalog.merge(old, fresh, setOf("old-8"), limit = 8)
        assertEquals(8, merged.size)
        assertTrue(merged.any { it.id == "old-8" })
        assertTrue(merged.any { it.id.startsWith("new-") })
        assertTrue(merged.count { it.id.startsWith("old-") } > 1)
        assertEquals(old, PublicCatalog.merge(old, emptyList(), limit = 8))
        val revoked = old.first().copy(revoked = true)
        val privateProfile = node("personal").copy(source = "personal")
        assertTrue(PublicCatalog.merge(listOf(revoked, privateProfile), listOf(old.first())).isEmpty())
        val same = PublicCatalog.merge(listOf(old.first()), listOf(old.first().copy(id = "new-id", addedAt = 99))).single()
        assertEquals("old-1", same.id)
        assertEquals(10L, same.addedAt)
    }

    @Test fun healthExpiresInItsMeasuredNetworkWithoutDeletingColdStartCandidates() {
        val observation = mapOf("node" to ProbeHealth(12, 0, 100, 100))
        assertEquals(observation, PublicCatalog.freshHealth(observation, 7, 7, 101))
        assertTrue(PublicCatalog.freshHealth(observation, 7, 8, 101).isEmpty())
        assertTrue(PublicCatalog.freshHealth(observation, 7, null, 101).isEmpty())
        assertTrue(PublicCatalog.freshHealth(observation, 7, 7, 99).isEmpty())
        assertTrue(PublicCatalog.freshHealth(observation, 7, 7, 101 + PublicCatalog.HEALTH_TTL_MS).isEmpty())
        // Health absence on process restart is not permission to discard the candidate cache.
        assertEquals(1, PublicCatalog.merge(listOf(node("node")), emptyList()).size)
    }

    @Test fun legacyCacheIsRevalidatedBeforeItCanPopulateTheNewPool() {
        val safe = node("saved", "11.22.33.44")
        val legacy = listOf(node("loopback", "127.0.0.1"), node("lan", "192.168.1.1"),
            node("link-local", "169.254.169.254"), node("local-name", "service.local"),
            node("broken-revoked").copy(config = "broken old entry", revoked = true), safe)
        assertEquals(listOf(safe), PublicCatalog.merge(legacy, emptyList()))
        assertEquals(listOf(safe), PublicCatalog.merge(emptyList(), legacy))
    }

    @Test fun groupingUsesOnlySuccessfulMeasuredNodesAndPrefersDifferentNetworksOverTheLowestPings() {
        val profiles = listOf(node("fast", "11.22.33.1"), node("same-host", "11.22.33.1"),
            node("same-subnet", "11.22.33.2"), node("different", "22.33.44.1", "Shadowsocks", "DE"),
            node("unknown", "33.44.55.1"), node("revoked", "44.55.66.1").copy(revoked = true))
        val selected = PublicCatalog.diverseBest(profiles,
            mapOf("fast" to 1, "same-host" to 2, "same-subnet" to 3, "different" to 90, "revoked" to 1).mapValues { it.value.toLong() }, 3)
        assertEquals(listOf("fast", "different", "same-subnet"), selected.map { it.id })
    }
}
