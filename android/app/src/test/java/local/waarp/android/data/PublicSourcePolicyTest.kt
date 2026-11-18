// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.URI
import org.json.JSONObject

class PublicSourcePolicyTest {
    @Test fun redirectsMustStayWithinTheSameRegisteredPublication() {
        val source = PublicCatalog.SOURCES.first { it.id == "igareck-vless" }
        source.endpoints.forEach { PublicSourcePolicy.requireEndpoint(source, URI(it)) }
        val renamed = PublicCatalog.SOURCES.first { it.id == "mahdibland-public" }
        assertEquals(1, renamed.endpoints.size)
        PublicSourcePolicy.requireEndpoint(renamed, URI("https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/Eternity.txt"))
        for (url in listOf(source.url.replace("https:", "http:"), "https://127.0.0.1/feed",
            "https://raw.githubusercontent.com/attacker/repo/main/all", source.url + "?token=secret", source.url + "#fragment",
            PublicCatalog.SOURCES.first { it.id == "igareck-mixed" }.url)) {
            assertThrows(url, IllegalArgumentException::class.java) { PublicSourcePolicy.requireEndpoint(source, URI(url)) }
        }
    }

    @Test fun privateLocalReservedAndEmbeddedPrivateAddressesAreRejected() {
        for (address in listOf("0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
            "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
            "::", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "::ffff:127.0.0.1", "64:ff9b::a00:1")) {
            assertFalse(address, PublicSourcePolicy.publicAddress(InetAddress.getByName(address)))
        }
        for (address in listOf("8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808")) {
            assertTrue(address, PublicSourcePolicy.publicAddress(InetAddress.getByName(address)))
        }
        assertThrows(IllegalArgumentException::class.java) { PublicSourcePolicy.requirePublicAddresses(listOf(
            InetAddress.getByName("8.8.8.8"), InetAddress.getByName("127.0.0.1"))) }
    }

    @Test fun parsingHostnamesPerformsNoDnsLookupAndRejectsLocalNames() {
        assertTrue(PublicSourcePolicy.publicHost("unresolvable-public-host.example"))
        for (host in listOf("localhost", "test.localhost", "printer.local", "service.internal", "127.1")) {
            assertFalse(host, PublicSourcePolicy.publicHost(host))
        }
    }

    @Test fun temporaryProbePinPreservesOriginalTlsIdentityAndRejectsMixedDnsAnswers() {
        val profile = ProfileImporter.link("vless://1d954d22-d9b9-4ce1-ae89-62051fa9b117@edge.example:443?security=tls&type=tcp").copy(source = "public")
        val original = profile.config
        val pinned = PublicSourcePolicy.pinForProbe(profile, mapOf("edge.example" to listOf(InetAddress.getByName("8.8.8.8"))))
        assertEquals(profile.id, pinned.id)
        assertEquals("edge.example", pinned.host)
        assertEquals("8.8.8.8", JSONObject(pinned.config).getString("server"))
        assertEquals("edge.example", JSONObject(pinned.config).getJSONObject("tls").getString("server_name"))
        assertEquals(JSONObject(original).getString("uuid"), JSONObject(pinned.config).getString("uuid"))
        assertEquals(original, profile.config)
        assertThrows(IllegalArgumentException::class.java) {
            PublicSourcePolicy.pinForProbe(profile, mapOf("edge.example" to listOf(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("192.168.1.1"))))
        }
    }

    @Test fun explicitWebsocketHostSurvivesPinningAndAnImplicitHostIsNotGuessed() {
        val base = "vless://1d954d22-d9b9-4ce1-ae89-62051fa9b117@edge.example:443?security=tls&type=ws&path=%2Fsocket"
        val profile = ProfileImporter.link("$base&host=front.example").copy(source = "public")
        val answers = mapOf("edge.example" to listOf(InetAddress.getByName("8.8.8.8")))
        val pinned = JSONObject(PublicSourcePolicy.pinForProbe(profile, answers).config)
        assertEquals("front.example", pinned.getJSONObject("transport").getJSONObject("headers").getString("Host"))
        assertEquals("/socket", pinned.getJSONObject("transport").getString("path"))
        assertThrows(IllegalArgumentException::class.java) { PublicSourcePolicy.pinForProbe(ProfileImporter.link(base).copy(source = "public"), answers) }
    }

    @Test fun everyOpenVpnRemoteMustBePublicAndFamilyPortNetworkAndVerificationArePreserved() {
        val node = obj("type" to "openvpn-client", "network" to "udp", "tls" to obj("server_name" to "expected subject", "server_name_type" to "subject"),
            "servers" to listOf(obj("server" to "one.example", "server_port" to 1194, "network" to "udp4"),
                obj("server" to "two.example", "server_port" to 443, "network" to "tcp6")))
        val profile = TunnelProfile(name = "test", protocol = "OpenVPN", host = "one.example", port = 1194, config = node.toString(), endpoint = true, source = "public")
        val pinned = JSONObject(PublicSourcePolicy.pinForProbe(profile, mapOf(
            "one.example" to listOf(InetAddress.getByName("1.1.1.1")),
            "two.example" to listOf(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("2606:4700:4700::1111")))).config)
        assertEquals("expected subject", pinned.getJSONObject("tls").getString("server_name"))
        val remotes = pinned.getJSONArray("servers")
        assertEquals("1.1.1.1", remotes.getJSONObject(0).getString("server"))
        assertEquals("udp4", remotes.getJSONObject(0).getString("network"))
        assertEquals(1194, remotes.getJSONObject(0).getInt("server_port"))
        assertEquals(InetAddress.getByName("2606:4700:4700::1111"), InetAddress.getByName(remotes.getJSONObject(1).getString("server")))
        assertEquals("tcp6", remotes.getJSONObject(1).getString("network"))
        assertEquals(443, remotes.getJSONObject(1).getInt("server_port"))
        val bad = JSONObject(profile.config).apply { getJSONArray("servers").getJSONObject(1).put("server", "127.0.0.1") }
        assertFalse(PublicSourcePolicy.publicProfile(profile.copy(config = bad.toString())))
        assertThrows(IllegalArgumentException::class.java) { PublicSourcePolicy.pinForProbe(profile, mapOf(
            "one.example" to listOf(InetAddress.getByName("1.1.1.1")), "two.example" to listOf(InetAddress.getByName("10.0.0.1")))) }
    }
}
