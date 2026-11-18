package local.waarp.android.data

import local.waarp.android.core.RuntimeLog
import local.waarp.android.core.RuntimePhase
import local.waarp.android.core.RuntimeStatus
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LastSessionEvidenceTest {
    private val secret = "never-enrolled-secret-fixture"

    @Test fun nativeStatusAndLogsAreReducedToBoundedCategories() {
        val status = RuntimeStatus(phase = RuntimePhase.ERROR, message = "TLS certificate $secret https://private.example/token",
            startedAt = 100, uploadBytes = 125, downloadBytes = 900, connectionCount = 4)
        val logs = List(800) { RuntimeLog(it.toLong(), 3, "DNS request failed $secret") } +
            RuntimeLog(900, 2, "Informational $secret")
        val snapshot = LastSessionEvidence.snapshot(status, logs, 1_234)
        assertEquals("ERROR", snapshot.getString("phase"))
        assertEquals("tls", snapshot.getString("errorClass"))
        assertEquals(499, snapshot.getJSONObject("errors").getInt("dns"))
        assertEquals(125L, snapshot.getLong("uploadBytes"))
        val serialized = snapshot.toString()
        assertFalse(serialized.contains(secret))
        assertFalse(serialized.contains("private.example"))
        assertFalse(serialized.contains("DNS request failed"))
        assertTrue(serialized.length < 1_024)
    }

    @Test fun reloadAllowlistDropsInjectedRawDataAndClampsCounts() {
        val unsafe = obj("at" to -1, "phase" to secret, "errorClass" to secret, "rawLogs" to secret,
            "config" to obj("private_key" to secret), "connections" to 2_000_000, "uploadBytes" to -5,
            "errors" to obj("dns" to 1_000, "tls" to -1, secret to 1))
        val safe = LastSessionEvidence.safeEvent(unsafe)
        assertEquals(0L, safe.getLong("at"))
        assertEquals("", safe.getString("phase"))
        assertEquals(1_000_000, safe.getInt("connections"))
        assertEquals(0L, safe.getLong("uploadBytes"))
        assertEquals(500, safe.getJSONObject("errors").getInt("dns"))
        assertEquals(0, safe.getJSONObject("errors").getInt("tls"))
        assertFalse(safe.toString().contains(secret))
        assertEquals(safe.toString(), LastSessionEvidence.safeEvent(JSONObject(safe.toString())).toString())
    }

    @Test fun transferEvidenceNeverPersistsEndpointBodyOrCredentials() {
        val raw = obj("at" to 5, "endpoint" to "https://private.example/$secret", "target" to secret,
            "download" to obj("state" to "pass", "bytes" to Int.MAX_VALUE, "elapsedMs" to Long.MAX_VALUE,
                "body" to secret, "reason" to secret),
            "upload" to obj("state" to "not_measured", "reason" to "no_endpoint", "config" to secret))
        val safe = LastSessionEvidence.safeTransfer(raw)
        assertEquals("rfc6455", safe.getString("target"))
        assertEquals(TransferProof.MAX_BYTES, safe.getJSONObject("download").getInt("bytes"))
        assertEquals(60_000L, safe.getJSONObject("download").getLong("elapsedMs"))
        assertEquals("not_measured", safe.getJSONObject("upload").getString("state"))
        assertEquals("no_endpoint", safe.getJSONObject("upload").getString("reason"))
        assertFalse(safe.toString().contains(secret))
        assertFalse(safe.toString().contains("private.example"))
    }
}
