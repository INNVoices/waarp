package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProfileTuningTest {
    private val id = "11111111-2222-3333-4444-555555555555"
    private fun link(fp: String = "") = "vless://$id@host.example:443?security=reality&sni=front.example&pbk=" + "A".repeat(43) + "&sid=aa" + fp
    @Test fun chrome155IsExplicitAndDoesNotChangeIosDefault() {
        fun fp(raw: String) = JSONObject(ProfileImporter.link(raw).config).getJSONObject("tls").getJSONObject("utls").getString("fingerprint")
        assertEquals("ios", fp(link()))
        assertEquals("ios", fp(link("&fp=")))
        assertEquals("chrome", fp(link("&fp=chrome")))
        assertEquals("chrome_155", fp(link("&fp=chrome_155")))
        assertTrue(runCatching { fp(link("&fp=chrome_999")) }.isFailure)
    }
    @Test fun clientOnlyVariantsPreserveServerAuthenticationAndConfiguration() {
        val p = ProfileImporter.link(link())
        val before = p.config
        val variants = ProfileTuning.variants(p)
        assertTrue(variants.size in 2..ProfileTuning.MAX_VARIANTS)
        assertFalse(variants.any { it.id == "fp-ios" })
        assertTrue(variants.any { it.id == "fp-chrome_155" })
        for (v in variants) {
            val node = JSONObject(v.profile.config)
            assertEquals(id, node.getString("uuid"))
            assertEquals("host.example", node.getString("server"))
            assertEquals("front.example", node.getJSONObject("tls").getString("server_name"))
            assertEquals("A".repeat(43), node.getJSONObject("tls").getJSONObject("reality").getString("public_key"))
            assertFalse(node.getJSONObject("tls").optBoolean("insecure"))
        }
        assertEquals(before, p.config)
        assertEquals(ProfileTuning.signature(p), ProfileTuning.signature(p.copy(name = "new label")))
        assertNotEquals(ProfileTuning.signature(p), ProfileTuning.signature(ProfileTuning.apply(p, "fp-edge")))
    }
    @Test fun quicProfilesDoNotGetTlsOverTcpKnobs() {
        for (raw in listOf("hy2://secret@host.example:443", "tuic://$id:secret@host.example:443"))
            assertTrue(ProfileTuning.variants(ProfileImporter.link(raw)).isEmpty())
    }
    @Test fun publicManagedRevokedAndMissingProfilesHaveNoMutableHelperVariants() {
        val p = ProfileImporter.link(link())
        for (ineligible in listOf(p.copy(source = "public"), p.copy(source = "managed"),
            p.copy(revoked = true), p.copy(subscriptionMissing = true))) {
            assertTrue(ProfileTuning.variants(ineligible).isEmpty())
            assertTrue(runCatching { ProfileTuning.apply(ineligible, "fp-edge") }.isFailure)
        }
    }
}
