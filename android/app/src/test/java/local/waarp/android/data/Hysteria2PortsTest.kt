package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class Hysteria2PortsTest {
    @Test fun preservesSinglePortSecurityAndServerProvidedRanges() {
        val raw = "hysteria2://user:p%40ss@host.example:443?sni=host.example"
        assertNull(Hysteria2Ports.normalize(raw).ports)
        assertEquals(raw, Hysteria2Ports.normalize(raw).url)
        val profile = ProfileImporter.link(raw)
        assertEquals(443, profile.port)
        assertEquals("user:p@ss", JSONObject(profile.config).getString("password"))
        val p = ProfileImporter.link("hy2://secret@[2001:db8::1]:443,8443-8445?sni=host.example&obfs=salamander&obfs-password=test")
        val j = JSONObject(p.config)
        assertEquals(listOf("443:443", "8443:8445"), j.stringList("server_ports"))
        assertEquals("30s", j.getString("hop_interval"))
        assertEquals("secret", j.getString("password"))
        assertEquals("test", j.getJSONObject("obfs").getString("password"))
        assertEquals("host.example", j.getJSONObject("tls").getString("server_name"))
    }
    @Test fun invalidPortListsNeverBecomeSinglePorts() {
        for (bad in listOf("443,", ",443", "443,,8443", "8445-8443", "0,443", "65536,443", "443-999999999999999999999999", "-1,443")) {
            assertTrue(bad, runCatching { ProfileImporter.link("hy2://secret@host.example:$bad") }.isFailure)
        }
        assertTrue(runCatching { ProfileImporter.link("hy2://secret@host.example:" + (1..33).joinToString(",")) }.isFailure)
    }
}
