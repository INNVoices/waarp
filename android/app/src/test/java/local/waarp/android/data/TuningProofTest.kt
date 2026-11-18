package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TuningProofTest {
    private fun profile() = ProfileImporter.link("vless://11111111-2222-3333-4444-555555555555@host.example:443?security=tls&sni=front.example")

    @Test fun evidenceExpiresOnEveryConnectionRelevantChange() {
        val p = profile()
        val proof = TuningProof(p.id, ProfileTuning.signature(p), 19, 7, 12, 1_000, setOf("fp-edge"))
        assertTrue(proof.current(p, 19, 7, 12, 1_001))
        assertTrue(proof.current(p.copy(name = "renamed"), 19, 7, 12, 1_001))
        assertFalse(proof.current(null, 19, 7, 12, 1_001))
        assertFalse(proof.current(p.copy(id = "different-profile"), 19, 7, 12, 1_001))
        assertFalse(proof.current(p.copy(revoked = true), 19, 7, 12, 1_001))
        assertFalse(proof.current(p.copy(subscriptionMissing = true), 19, 7, 12, 1_001))
        assertFalse(proof.current(p.copy(dns = listOf("9.9.9.9")), 19, 7, 12, 1_001))
        assertFalse(proof.current(ProfileTuning.apply(p, "fp-edge"), 19, 7, 12, 1_001))
        assertFalse(proof.current(p, null, 7, 12, 1_001))
        assertFalse(proof.current(p, 20, 7, 12, 1_001))
        assertFalse(proof.current(p, 19, 8, 12, 1_001))
        assertFalse(proof.current(p, 19, 7, 13, 1_001))
        assertFalse(proof.current(p, 19, 7, 12, 999))
        assertTrue(proof.current(p, 19, 7, 12, 1_000 + ProfileTuning.RESULT_TTL_MS - 1))
        assertFalse(proof.current(p, 19, 7, 12, 1_000 + ProfileTuning.RESULT_TTL_MS))
    }

    @Test fun encryptedModelRoundTripRetainsExactOriginalAndConcealsItInDebugStrings() {
        val original = profile()
        val variant = ProfileTuning.apply(original, "fp-edge")
        val tuned = variant.copy(tuning = StoredProfileTune("fp-edge", "Edge", original.config, original.protocol,
            ProfileTuning.signature(variant), "network-19", "Wi-Fi", 1_234))
        val restored = TunnelProfile.fromJson(JSONObject(tuned.json().toString()))
        assertEquals(tuned, restored)
        val saved = restored.tuning!!
        assertEquals(ProfileTuning.signature(restored), saved.appliedSignature)
        val reset = restored.copy(config = saved.originalConfig, protocol = saved.originalProtocol, tuning = null)
        assertEquals(original, reset)
        assertFalse(restored.toString().contains("front.example"))
        assertFalse(saved.toString().contains("11111111-2222-3333-4444-555555555555"))
        assertFalse(saved.toString().contains("host.example"))
        val replaced = restored.copy(config = JSONObject(restored.config).put("server", "replacement.example").toString())
        assertNotEquals(saved.appliedSignature, ProfileTuning.signature(replaced))
    }
}
