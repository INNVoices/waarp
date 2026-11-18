package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MasqueImporterTest {
    private fun fixture() = JSONObject(checkNotNull(javaClass.classLoader?.getResource("masque-export.json")).readText())
    private fun parse(j: JSONObject) = ProfileImporter.parse(j.toString()).profiles.single()
    private fun rejected(j: JSONObject) { assertTrue("Rejected MASQUE document", runCatching { ProfileImporter.parse(j.toString()) }.isFailure) }

    @Test fun importsOnlyNodeExportsWithoutLosingCredentialsOrMode() {
        for (mode in listOf("auto", "h2", "h3")) {
            val input = fixture().put("vhttp", mode)
            val p = parse(input); val config = JSONObject(p.config)
            assertEquals(mode, config.getString("vhttp"))
            assertEquals(input.getString("private_key"), config.getString("private_key"))
            assertEquals(input.getString("public_key"), config.getString("public_key"))
            assertEquals("172.16.0.2/32", config.getString("ip"))
            assertEquals("2606:4700:110:1234::2/128", config.getString("ipv6"))
            assertEquals("personal", p.source)
            assertFalse(p.endpoint)
            assertFalse(config.has("tag"))
            assertEquals(p, TunnelProfile.fromJson(p.json()))
            assertFalse(p.toString().contains(input.getString("private_key")))
            assertFalse(ProfileTuning.technical(p).toString().contains("fixture-token"))
        }
        val envelope = obj("outbounds" to listOf(fixture(), fixture()))
        val result = ProfileImporter.parse(envelope.toString(), limit = 1)
        assertEquals(1, result.profiles.size)
        assertEquals(1, result.skipped)
    }

    @Test fun standardHasOnlyTheImplementedTransportAndRequiresUri() {
        val standard = obj("type" to "masque", "profile" to "standard", "server" to "connect.example.test", "ip" to "10.5.0.2",
            "uri" to "https://connect.example.test/.well-known/masque/ip/*/*/")
        assertEquals("h3", JSONObject(parse(standard).config).getString("vhttp"))
        assertTrue(ProfileTuning.variants(parse(standard)).isEmpty())
        rejected(JSONObject(standard.toString()).put("vhttp", "h2"))
        rejected(JSONObject(standard.toString()).put("vhttp", "auto"))
        rejected(JSONObject(standard.toString()).apply { remove("uri") })
    }

    @Test fun rejectsIgnoredFieldsUnsafeTlsInvalidKeysAndRuntimeSettings() {
        for ((field, value) in listOf(
            "private_key" to "invalid-secret", "public_key" to fixture().getString("private_key"),
            "server" to "invalid host", "server_port" to "443", "server_port" to 65536,
            "ip" to "10.0.0.2/33", "ipv6" to "10.0.0.1", "profile" to "custom", "vhttp" to "http3",
            "network" to "h3", "detour" to "direct", "mtu" to 1279, "mtu" to 9001, "udp_fragment" to "true",
            "uri" to "http://host.example/", "uri" to "https://user:secret@host.example/", "uri" to "https://host.example/#secret",
            "idle_timeout" to "25h", "network_list" to jsonArray(listOf("icmp")),
            "tls" to obj("enabled" to false), "tls" to obj("insecure" to true), "tls" to obj("insecure" to "false"),
            "tls" to obj("certificate_path" to "/private/file"), "tls" to obj("alpn" to listOf("h3")),
            "tls" to obj("utls" to obj("enabled" to true, "fingerprint" to "chrome")),
        )) rejected(fixture().put(field, value))
        rejected(fixture().put("vhttp", "h3").put("tls", obj("record_fragment" to true)))
        for (field in listOf("inbounds", "route", "dns", "experimental")) rejected(obj("outbounds" to listOf(fixture()), field to JSONObject()))
    }

    @Test fun helperPreservesEndpointKeysAndSourceUntilExplicitApply() {
        val profile = parse(fixture())
        val before = profile.config
        val candidates = ProfileTuning.variants(profile)
        assertEquals(listOf("original", "vhttp-h3", "vhttp-h2"), candidates.map { it.id })
        for (candidate in candidates) {
            val node = JSONObject(candidate.profile.config)
            for (field in listOf("server", "server_port", "private_key", "public_key", "uri")) assertEquals(JSONObject(before).get(field), node.get(field))
        }
        assertEquals(before, profile.config)
        assertEquals("h2", JSONObject(ProfileTuning.apply(profile, "vhttp-h2").config).getString("vhttp"))
        assertTrue(runCatching { ProfileTuning.apply(profile, "unmeasured-injected-recipe") }.isFailure)
        assertTrue(ProfileTuning.variants(profile.copy(revoked = true)).isEmpty())
        assertTrue(ProfileTuning.variants(profile.copy(source = "public")).isEmpty())
    }
}
