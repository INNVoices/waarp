package local.waarp.android.data

import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.Base64
import java.util.zip.DeflaterOutputStream
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Offline parser regressions. Documentation addresses/keys never represent a live account. */
class ProfileImporterTest {
    private val id = "11111111-2222-3333-4444-555555555555"
    private val key = Base64.getEncoder().encodeToString(ByteArray(32) { (it + 1).toByte() })
    private val peer = Base64.getEncoder().encodeToString(ByteArray(32) { (it + 33).toByte() })
    private fun b64(value: String) = Base64.getEncoder().encodeToString(value.toByteArray())
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")
    private fun json(link: String) = JSONObject(ProfileImporter.link(link).config)
    private fun amnezia(data: JSONObject): String {
        val body = data.toString().toByteArray()
        val compressed = ByteArrayOutputStream().apply {
            write(byteArrayOf((body.size ushr 24).toByte(), (body.size ushr 16).toByte(), (body.size ushr 8).toByte(), body.size.toByte()))
            DeflaterOutputStream(this).use { it.write(body) }
        }.toByteArray()
        return "vpn://" + Base64.getUrlEncoder().withoutPadding().encodeToString(compressed)
    }
    private fun wg(extra: String = "", address: String = "10.8.0.2") = """
        [Interface]
        PrivateKey = $key
        Address = $address
        DNS = 10.8.0.1
        $extra
        [Peer]
        PublicKey = $peer
        AllowedIPs = 0.0.0.0/0, ::/0
        Endpoint = [2001:db8::1]:51820
        PersistentKeepalive = off
    """.trimIndent()

    @Test fun wireGuardNormalizesBareAddressesAndPreservesExplicitPeerParameters() {
        val profile = ProfileImporter.parse(wg("Address = fd00::2/128\nListenPort = 0\nMTU = 1380"), "Test client").profiles.single()
        val node = JSONObject(profile.config)
        assertEquals("WireGuard", profile.protocol)
        assertEquals(listOf("10.8.0.2/32", "fd00::2/128"), profile.addresses)
        assertEquals("2001:db8::1", profile.host)
        assertEquals(51820, profile.port)
        assertEquals(1380, node.getInt("mtu"))
        assertEquals(0, node.getInt("listen_port"))
        assertEquals(false, node.getBoolean("system"))
        assertEquals(0, node.getJSONArray("peers").getJSONObject(0).getInt("persistent_keepalive_interval"))
        assertEquals(listOf("10.8.0.1"), profile.dns)
    }

    @Test fun awg2PreservesCaseSensitiveSignatureAndMagicRanges() {
        val profile = ProfileImporter.parse(wg("Jc = 4\nJmin = 50\nJmax = 80\nS3 = 12\nH1 = 100-110\nH2 = 200\nI1 = <b 0xAbCD><r 32><t>")).profiles.single()
        val node = JSONObject(profile.config)
        assertEquals("AWG2", profile.protocol)
        assertEquals("100-110", node.getString("h1"))
        assertEquals("<b 0xAbCD><r 32><t>", node.getString("i1"))
        assertEquals(12, node.getInt("s3"))
    }

    @Test fun profileIdentityPreservesDnsPolicyButIgnoresJsonKeyOrderAndLocalLabels() {
        val profile = ProfileImporter.parse(wg()).profiles.single()
        assertNotEquals(ProfileImporter.identity(profile), ProfileImporter.identity(profile.copy(dns = listOf("10.8.0.53"))))
        val a = profile.copy(config = """{"type":"wireguard","peers":[{"port":51820,"host":"192.0.2.1"}]}""")
        val b = a.copy(id = "renamed-id", name = "Local label", config = """{"peers":[{"host":"192.0.2.1","port":51820}],"type":"wireguard","tag":"local-tag"}""")
        assertEquals(ProfileImporter.identity(a), ProfileImporter.identity(b))
        assertNotEquals(ProfileImporter.identity(a), ProfileImporter.identity(a.copy(config = a.config.replace("51820", "51821"))))
    }

    @Test fun unsafeOrAmbiguousWireGuardConfigurationsAreRejected() {
        listOf(
            wg("PostUp = echo do-not-execute"), wg("PrivateKey = $peer"),
            wg("Jc = 4\njC = 5"), wg("HeaderProtectionKey = $key"),
            wg("RandomTrailers = true"), wg("DisableCookies = true"),
            wg("H1 = 1-3"), wg("Jmin = 90\nJmax = 80"), wg("I1 = <r 2017>"),
            wg() + "\n[Peer]\nPublicKey = $peer", wg(address = "10.8.0.2/33"),
            wg().replace("[2001:db8::1]:51820", "[192.0.2.1]:51820"),
        ).forEach { input -> assertThrows(RuntimeException::class.java) { ProfileImporter.parse(input) } }
    }

    @Test fun amneziaQCompressContainerImportsNestedConfiguration() {
        val body = JSONObject().put("containers", org.json.JSONArray().put(JSONObject().put("config", wg())))
        val profile = ProfileImporter.parse(amnezia(body)).profiles.single()
        assertEquals("WireGuard", profile.protocol)
        assertEquals("2001:db8::1", profile.host)
    }

    @Test fun nativeAmneziaLastConfigRetainsAwgOptionsThroughStorageAndCompilation() {
        val psk = Base64.getEncoder().encodeToString(ByteArray(32) { 0x5a })
        val conf = wg("""
            Address = fd00::2/64
            DNS = 1.1.1.1
            MTU = 1380
            ListenPort = 51825
            Jc = 4
            Jmin = 40
            Jmax = 200
            S1 = 80
            S2 = 20
            S3 = 35
            S4 = 12
            H1 = 2147483648-2147483658
            H2 = 3000000000
            H3 = 4000000000
            H4 = 4294967295
            I1 = <b 0xAbCD><r 32>
            I2 = <rc 10><rd 5><t>
            I3 = <d><ds><dz 2>
            I4 = <r 0>
            I5 = <b 0x00>
        """.trimIndent(), address = "10.8.0.2/24").replace("AllowedIPs = 0.0.0.0/0, ::/0", "AllowedIPs = 10.8.0.0/16, 2001:db8::/48")
            .replace("PersistentKeepalive = off", "PersistentKeepalive = 25\nPresharedKey = $psk")
        // Amnezia stores last_config as JSON text, whose config member is the actual INI text.
        val lastConfig = JSONObject().put("config", conf).put("client_priv_key", key).put("psk_key", psk).toString()
        val container = JSONObject().put("container", "amnezia-awg")
            .put("awg", JSONObject().put("last_config", lastConfig))
        val body = JSONObject().put("containers", org.json.JSONArray().put(container)).put("defaultContainer", "amnezia-awg")
        val imported = ProfileImporter.parse(amnezia(body)).profiles.single()
        val stored = TunnelProfile.fromJson(JSONObject(imported.json().toString()))
        val data = AppData(profiles = listOf(stored), settings = AppSettings(defaultVia = stored.id))
        val node = JSONObject(RoutingCompiler.compile(data).json).getJSONArray("endpoints").getJSONObject(0)
        assertEquals("AWG2", stored.protocol)
        assertEquals(ProfileImporter.identity(ProfileImporter.parse(conf).profiles.single()), ProfileImporter.identity(stored))
        assertEquals(ProfileImporter.identity(stored), ProfileImporter.identity(stored.copy(config = node.toString())))
        assertEquals(key, node.getString("private_key"))
        assertEquals(1380, node.getInt("mtu"))
        assertEquals(51825, node.getInt("listen_port"))
        assertEquals(listOf("10.8.0.2/24", "fd00::2/64"), node.stringList("address"))
        assertEquals(listOf("10.8.0.1", "1.1.1.1"), stored.dns)
        val endpoint = node.getJSONArray("peers").getJSONObject(0)
        assertEquals(peer, endpoint.getString("public_key"))
        assertEquals(psk, endpoint.getString("pre_shared_key"))
        assertEquals("2001:db8::1", endpoint.getString("address"))
        assertEquals(51820, endpoint.getInt("port"))
        assertEquals(25, endpoint.getInt("persistent_keepalive_interval"))
        assertEquals(listOf("10.8.0.0/16", "2001:db8::/48"), endpoint.stringList("allowed_ips"))
        for ((field, value) in mapOf("jc" to 4L, "jmin" to 40L, "jmax" to 200L, "s1" to 80L,
            "s2" to 20L, "s3" to 35L, "s4" to 12L, "h2" to 3000000000L, "h3" to 4000000000L, "h4" to 4294967295L))
            assertEquals(field, value, node.getLong(field))
        assertEquals("2147483648-2147483658", node.getString("h1"))
        for ((field, value) in mapOf("i1" to "<b 0xAbCD><r 32>", "i2" to "<rc 10><rd 5><t>",
            "i3" to "<d><ds><dz 2>", "i4" to "<r 0>", "i5" to "<b 0x00>")) assertEquals(field, value, node.getString(field))
    }

    @Test fun amneziaNestedJsonStillHonorsTheDepthLimit() {
        val lastConfig = "{\"child\":".repeat(33) + JSONObject().put("config", wg()).toString() + "}".repeat(33)
        assertThrows(RuntimeException::class.java) { ProfileImporter.parse(amnezia(JSONObject().put("last_config", lastConfig))) }
    }

    @Test fun importBoundsRejectOversizedAndDeepInputs() {
        assertThrows(RuntimeException::class.java) { ProfileImporter.parse("x".repeat(MAX_IMPORT_BYTES + 1)) }
        val nested = "[".repeat(33) + "0" + "]".repeat(33)
        assertThrows(RuntimeException::class.java) { ProfileImporter.checkJsonDepth(nested) }
        ProfileImporter.checkJsonDepth("{\"quoted\":\"${"[".repeat(100)}\"}")
    }

    @Test fun realityTlsAndWebSocketTransportSurviveImport() {
        val pk = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 3 })
        val reality = json("vless://$id@192.0.2.1:443?security=reality&sni=cover.example&pbk=$pk&sid=aabb&fp=chrome&flow=xtls-rprx-vision")
        assertEquals("xtls-rprx-vision", reality.getString("flow"))
        assertEquals(pk, reality.getJSONObject("tls").getJSONObject("reality").getString("public_key"))
        assertEquals("aabb", reality.getJSONObject("tls").getJSONObject("reality").getString("short_id"))
        val ws = json("vless://$id@192.0.2.1:443?security=tls&type=ws&sni=cover.example&host=cdn.example&path=%2Fws&alpn=h2,http%2F1.1")
        assertEquals("ws", ws.getJSONObject("transport").getString("type"))
        assertEquals("/ws", ws.getJSONObject("transport").getString("path"))
        assertEquals("cdn.example", ws.getJSONObject("transport").getJSONObject("headers").getString("Host"))
        assertEquals("http/1.1", ws.getJSONObject("tls").getJSONArray("alpn").getString(1))
    }

    @Test fun vlessDefaultFingerprintIsSingleSegmentButExplicitOneIsKept() {
        val pk = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 3 })
        val base = "vless://$id@192.0.2.1:443?security=reality&sni=cover.example&pbk=$pk&sid=aabb"
        fun fp(link: String) = json(link).getJSONObject("tls").getJSONObject("utls").getString("fingerprint")
        // firefox/chrome hellos of the pinned core span two TCP segments; a mobile DPI drops the second one.
        assertEquals("ios", fp(base))
        assertEquals("ios", fp("$base&fp="))
        assertEquals("firefox", fp("$base&fp=firefox"))
        assertEquals("chrome", fp("$base&fp=chrome"))
    }

    @Test fun xhttpPreservesSupportedHeadersRangesAndMux() {
        val extra = """{"headers":{"X-Test":"Value"},"xPaddingBytes":{"from":100,"to":200},"xmux":{"maxConcurrency":"4-8","hKeepAlivePeriod":30}}"""
        val node = json("vless://$id@192.0.2.1:443?type=xhttp&mode=packet-up&extra=${encode(extra)}")
        val transport = node.getJSONObject("transport")
        assertEquals("xhttp", transport.getString("type"))
        assertEquals("100-200", transport.getString("x_padding_bytes"))
        assertEquals("Value", transport.getJSONObject("headers").getString("X-Test"))
        assertEquals("4-8", transport.getJSONObject("xmux").getString("max_concurrency"))
    }

    @Test fun unsupportedSecurityAndTransportNeverDisappearSilently() {
        listOf(
            "vless://$id@192.0.2.1:443?security=none&pqv=required",
            "vless://$id@192.0.2.1:443?type=tcp&extra=%7B%7D",
            "vless://$id@192.0.2.1:443?packetEncoding=xudp",
            "vless://$id@192.0.2.1:443?type=xhttp&extra=${encode("{\"headers\":[]}")}",
            "vless://$id@192.0.2.1:443?type=xhttp&extra=${encode("{\"xmux\":\"ignored\"}")}",
            "trojan://test@192.0.2.1:443?allowInsecure=0&insecure=TRUE",
            "trojan://test@192.0.2.1:443?security=reality",
            "trojan://test@192.0.2.1:443?type=kcp",
            "trojan://test@192.0.2.1:443?type=tcp&headerType=http",
            "hy2://test@192.0.2.1:443?pinSHA256=deadbeef",
            "hy2://test@192.0.2.1:443?obfs=salamander",
        ).forEach { link -> assertThrows(RuntimeException::class.java) { ProfileImporter.link(link) } }
    }

    @Test fun supportedProxyCredentialsAreDecodedExactlyOnce() {
        val hysteria = json("hysteria2://user:p%40ss%3Aword@192.0.2.1:443?obfs=salamander&obfs-password=wrap%2Bkey")
        assertEquals("user:p@ss:word", hysteria.getString("password"))
        assertEquals("wrap+key", hysteria.getJSONObject("obfs").getString("password"))
        val trojan = json("trojan://p%253Ass@192.0.2.1:443?type=grpc&serviceName=service")
        assertEquals("p%3Ass", trojan.getString("password"))
        assertEquals("service", trojan.getJSONObject("transport").getString("service_name"))
        val tuic = json("tuic://$id:p%3Aword@192.0.2.1:443?congestion_control=cubic&alpn=h3")
        assertEquals("p:word", tuic.getString("password"))
        assertEquals("cubic", tuic.getString("congestion_control"))
    }

    @Test fun shadowsocksSupportsBothFormsButRejectsEncodedPlugins() {
        val credentials = b64("aes-256-gcm:p@ss")
        assertEquals("p@ss", json("ss://$credentials@192.0.2.1:8388").getString("password"))
        assertEquals("192.0.2.1", json("ss://${b64("aes-256-gcm:p@ss@192.0.2.1:8388")}").getString("server"))
        listOf("plugin", "%70lugin").forEach { field ->
            assertThrows(RuntimeException::class.java) { ProfileImporter.link("ss://$credentials@192.0.2.1:8388?$field=obfs-local") }
        }
    }

    @Test fun vmessDoesNotCoerceInvalidAlterIdToAValidCredential() {
        fun link(aid: Any) = "vmess://" + b64(JSONObject().put("add", "192.0.2.1").put("port", 443).put("id", id)
            .put("aid", aid).put("net", "ws").put("path", "/socket").put("tls", "tls").put("fp", "chrome").toString())
        val valid = json(link("0"))
        assertEquals(0, valid.getInt("alter_id"))
        assertEquals("chrome", valid.getJSONObject("tls").getJSONObject("utls").getString("fingerprint"))
        listOf("broken", 1.5, -1, 65536).forEach { value -> assertThrows(RuntimeException::class.java) { ProfileImporter.link(link(value)) } }
    }

    @Test fun boundedMixedImportReportsInvalidAndTruncatedLinks() {
        val links = listOf("trojan://one@192.0.2.1:443", "trojan://@192.0.2.2:443", "trojan://three@192.0.2.3:443")
        val result = ProfileImporter.parse(b64(links.joinToString("\n")), limit = 2)
        assertEquals(1, result.profiles.size)
        assertEquals(2, result.skipped)
        assertEquals("192.0.2.1", result.profiles.single().host)
    }

    @Test fun unrecognizedSecondEntryCannotPassTheSingleProfileReplacementGuard() {
        val valid = "trojan://synthetic@192.0.2.1:443"
        for (extra in listOf("unrecognized input", "unsupported://second-profile")) {
            for (input in listOf("$valid\n$extra", b64("$valid\n$extra"))) {
                val result = ProfileImporter.parse(input)
                assertEquals(1, result.profiles.size)
                assertEquals(1, result.skipped)
                assertFalse(result.profiles.size == 1 && result.skipped == 0)
            }
        }
    }
}
