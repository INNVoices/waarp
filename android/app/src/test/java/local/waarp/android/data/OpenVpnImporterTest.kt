package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OpenVpnImporterTest {
    private val fingerprint = "ab".repeat(32)
    private fun profile(extra: String = "") = """
        client
        dev tun
        proto udp
        remote vpn.example.test 1194
        peer-fingerprint $fingerprint
        remote-cert-tls server
        $extra
    """.trimIndent()
    private fun parse(text: String) = JSONObject(OpenVpnImporter.parse(text).config)

    @Test fun tlsConstraintsAndProtocolArePreserved() {
        val node = parse(profile("verify-x509-name \"CN=Test Server\"\ntls-version-min 1.2\ntls-version-max 1.3\ndata-ciphers AES-256-GCM:AES-128-GCM\nauth SHA256"))
        val tls = node.getJSONObject("tls")
        assertEquals("openvpn-client", node.getString("type"))
        assertEquals("udp", node.getString("network"))
        assertEquals("subject", tls.getString("server_name_type"))
        assertEquals("CN=Test Server", tls.getString("server_name"))
        assertEquals("1.2", tls.getString("version_min"))
        assertEquals("server", tls.getString("remote_certificate_tls"))
        assertEquals(fingerprint, tls.getJSONArray("peer_fingerprint").getString(0))
        assertEquals("AES-128-GCM", node.getJSONArray("data_ciphers").getString(1))
    }

    @Test fun inlineAuthenticationRetainsSignificantSpaces() {
        val node = parse(profile("auth-user-pass [inline]\n<auth-user-pass>\n user with space \n p@ss word \n</auth-user-pass>"))
        assertEquals(" user with space ", node.getString("username"))
        assertEquals(" p@ss word ", node.getString("password"))
    }

    @Test fun multipleRemotesKeepPerRemoteTransport() {
        val node = parse(profile("remote 192.0.2.2 443 tcp-client"))
        assertEquals(2, node.getJSONArray("servers").length())
        assertEquals("udp", node.getString("network"))
        assertEquals("tcp", node.getJSONArray("servers").getJSONObject(1).getString("network"))
        assertEquals(443, node.getJSONArray("servers").getJSONObject(1).getInt("server_port"))
    }

    @Test fun inlineControlChannelKeyAndDirectionAreMapped() {
        val node = parse(profile("tls-auth [inline] 1\n<tls-auth>\nTEST-ONLY-STATIC-KEY\n</tls-auth>"))
        val wrap = node.getJSONObject("tls").getJSONObject("control_wrap")
        assertEquals("tls_auth", wrap.getString("type"))
        assertEquals("client", wrap.getString("direction"))
        assertEquals("TEST-ONLY-STATIC-KEY", wrap.getJSONArray("key").getString(0))
    }

    @Test fun emptyVerificationNameAndMalformedCompressionAreRejected() {
        listOf("verify-x509-name \"\"", "verify-x509-name ''", "allow-compression", "allow-compression maybe", "dev-type TAP").forEach { directive ->
            assertThrows(RuntimeException::class.java) { OpenVpnImporter.parse(profile(directive)) }
        }
    }

    @Test fun executableExternalAndUnmappedVerificationDirectivesAreRejected() {
        listOf("up /tmp/do-not-run", "--plugin test.so", "config /tmp/other.ovpn", "ca /tmp/ca.pem", "auth-user-pass /tmp/password",
            "auth-user-pass", "crl-verify /tmp/crl", "tls-ciphersuites TLS_AES_128_GCM_SHA256", "http-proxy proxy.example 8080", "dev tap0").forEach { directive ->
            assertThrows(RuntimeException::class.java) { OpenVpnImporter.parse(profile(directive)) }
        }
    }

    @Test fun incompleteAndConflictingInlineBlocksAreRejected() {
        listOf(
            "<cert>TEST ONLY</cert>", "<ca>unterminated", "<unsupported>value</unsupported>",
            "<tls-auth>a</tls-auth>\n<tls-crypt>b</tls-crypt>",
            "<auth-user-pass>\nuser\npass\nextra\n</auth-user-pass>",
            "<auth-user-pass>\nuser\npass\n</auth-user-pass>\n<auth-user-pass>\nu2\np2\n</auth-user-pass>",
        ).forEach { extra -> assertThrows(RuntimeException::class.java) { OpenVpnImporter.parse(profile(extra)) } }
    }

    @Test fun aClientWithoutCaOrFingerprintCannotBeImported() {
        assertThrows(RuntimeException::class.java) { OpenVpnImporter.parse("client\ndev tun\nremote vpn.example.test 1194") }
    }
}
