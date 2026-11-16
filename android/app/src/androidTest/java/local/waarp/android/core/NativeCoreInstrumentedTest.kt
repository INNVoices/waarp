// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.nekohasekai.libbox.Libbox
import kotlinx.coroutines.runBlocking
import local.waarp.android.data.AppData
import local.waarp.android.data.AppSettings
import local.waarp.android.data.ProfileImporter
import local.waarp.android.data.RoutingCompiler
import local.waarp.android.data.TrafficRoute
import local.waarp.android.data.TunnelGroup
import local.waarp.android.data.TunnelProfile
import local.waarp.android.data.obj
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.Base64
import java.util.concurrent.Executors
import java.util.zip.DeflaterOutputStream

/** Executes the shipped native .so. No private profile or external gateway is used. */
@RunWith(AndroidJUnit4::class)
class NativeCoreInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before fun initializeNativeCore() { LibboxRuntime.initialize(context) }

    @Test fun actualAarVersionAndGoSecurityFixMatchThePin() {
        assertEquals("1.14.4-lx.35", Libbox.version())
        assertEquals("go1.26.10", Libbox.goVersion())
    }

    @Test fun productionCompilerIsAcceptedByNativeAndroidCore() = runBlocking {
        val pair = WireGuardKeys.generate()
        val peer = WireGuardKeys.generate()
        val awg = TunnelProfile(id = "awg-test", name = "AWG2 test", protocol = "AWG2",
            host = "192.0.2.1", port = 51820, endpoint = true, addresses = listOf("10.40.0.2/32"), dns = listOf("1.1.1.1"),
            config = obj("type" to "wireguard", "system" to false,
                "address" to listOf("10.40.0.2/32"), "private_key" to pair.privateKey,
                "jc" to 4, "jmin" to 40, "jmax" to 70,
                "s1" to 10, "s2" to 20, "h1" to "1234", "h2" to "5678", "h3" to "9012", "h4" to "3456",
                "peers" to listOf(obj("address" to "192.0.2.1", "port" to 51820,
                    "public_key" to peer.publicKey, "allowed_ips" to listOf("0.0.0.0/0")))).toString())
        val proxy = TunnelProfile(id = "vless-test", name = "VLESS test", protocol = "VLESS", host = "192.0.2.2", port = 443,
            config = obj("type" to "vless", "server" to "192.0.2.2", "server_port" to 443,
                "uuid" to "00000000-0000-4000-8000-000000000001").toString())
        val group = TunnelGroup(id = "g-test", name = "Test group", members = listOf(awg.id, proxy.id))
        val data = AppData(profiles = listOf(awg, proxy), groups = listOf(group), settings = AppSettings(defaultVia = group.id),
            routes = listOf(
                TrafficRoute(name = "App", kind = "app", match = "org.example.client", via = awg.id, fallback = proxy.id),
                TrafficRoute(name = "Domain", kind = "custom", match = "example.test", via = proxy.id),
            ))
        val compiled = RoutingCompiler.compile(data, context.packageName).json
        assertFalse(compiled.contains("clash_api"))
        VpnController(context).validateConfig(compiled)
        // The check-only profile set must be accepted without any TUN or Android permission.
        val checker = RoutingCompiler.compile(data, context.packageName, checkerProfiles = listOf(awg, proxy)).json
        assertFalse(Libbox.hasTunInbound(checker))
        Libbox.checkConfig(checker)
    }

    @Test fun androidAarRejectsDesktopClashApiConfiguration() {
        try {
            Libbox.checkConfig("""{"outbounds":[{"type":"direct","tag":"direct"}],"experimental":{"clash_api":{"external_controller":"127.0.0.1:9090"}}}""")
            fail("The mobile AAR unexpectedly accepted desktop Clash API configuration")
        } catch (expected: Exception) {
            assertTrue(expected.message.orEmpty().contains("clash", ignoreCase = true))
        }
    }

    @Test fun everySupportedImportProducesConfigurationAcceptedByTheShippedCore() = runBlocking {
        val uuid = "00000000-0000-4000-8000-000000000001"
        val client = WireGuardKeys.generate()
        val peer = WireGuardKeys.generate()
        val wg = """
            [Interface]
            PrivateKey = ${client.privateKey}
            Address = 10.42.0.2/32
            DNS = 1.1.1.1
            [Peer]
            PublicKey = ${peer.publicKey}
            Endpoint = 192.0.2.1:51820
            AllowedIPs = 0.0.0.0/0
            PersistentKeepalive = 25
        """.trimIndent()
        val awg1 = wg.replace("[Peer]", "Jc = 4\nJmin = 40\nJmax = 70\nS1 = 10\nS2 = 20\nH1 = 1234\nH2 = 5678\nH3 = 9012\nH4 = 3456\n[Peer]")
        val awg2 = awg1.replace("[Peer]", "S3 = 8\nS4 = 12\nI1 = <b 0x01020304>\n[Peer]")
        val wrapped = obj("containers" to listOf(obj("config" to awg2))).toString().toByteArray()
        val compressed = ByteArrayOutputStream().also { output -> DeflaterOutputStream(output).use { it.write(wrapped) } }.toByteArray()
        val vpn = "vpn://" + Base64.getUrlEncoder().withoutPadding().encodeToString(ByteBuffer.allocate(4).putInt(wrapped.size).array() + compressed)
        val vmess = "vmess://" + Base64.getEncoder().encodeToString(
            obj("v" to "2", "ps" to "VMess test", "add" to "192.0.2.2", "port" to "443",
                "id" to uuid, "aid" to "0", "net" to "ws", "path" to "/test", "tls" to "tls", "sni" to "example.test").toString().toByteArray())
        val ss = "ss://" + Base64.getEncoder().withoutPadding().encodeToString("aes-128-gcm:test-password".toByteArray()) + "@192.0.2.2:443#Test"
        val reality = Base64.getUrlEncoder().withoutPadding().encodeToString(Base64.getDecoder().decode(peer.publicKey))
        val inputs = linkedMapOf(
            "WireGuard" to wg, "AWG1" to awg1, "AWG2" to awg2, "Amnezia vpn URL" to vpn,
            "VLESS" to "vless://$uuid@192.0.2.2:443?security=tls&sni=example.test&type=ws&path=%2Ftest",
            "VLESS REALITY" to "vless://$uuid@192.0.2.2:443?security=reality&sni=example.test&pbk=$reality&sid=abcd&fp=chrome",
            "VLESS XHTTP" to "vless://$uuid@192.0.2.2:443?security=tls&sni=example.test&type=xhttp&mode=auto&path=%2Ftest",
            "VMess" to vmess, "Shadowsocks" to ss,
            "Trojan" to "trojan://test-password@192.0.2.2:443?sni=example.test",
            "Hysteria2" to "hysteria2://test-password@192.0.2.2:443?sni=example.test&obfs=salamander&obfs-password=test-obfs",
            "TUIC" to "tuic://$uuid:test-password@192.0.2.2:443?sni=example.test&congestion_control=bbr",
            "OpenVPN" to "client\ndev tun\nproto udp\nremote 192.0.2.2 1194\npeer-fingerprint ${"12".repeat(32)}\nremote-cert-tls server\n<auth-user-pass>\ntest-user\ntest-password\n</auth-user-pass>",
        )
        for ((format, input) in inputs) {
            val profile = ProfileImporter.parse(input).profiles.single()
            val data = AppData(profiles = listOf(profile), settings = AppSettings(defaultVia = profile.id))
            try {
                VpnController(context).validateConfig(RoutingCompiler.compile(data, context.packageName).json)
                VpnController(context).validateConfig(
                    RoutingCompiler.compile(data, context.packageName, checkerProfiles = listOf(profile)).json, requireTun = false)
            } catch (error: Exception) {
                throw AssertionError("Native Android core rejected supported $format: ${error.message}")
            }
        }
    }

    @Test fun headlessNativeProbeMakesARealHttpRequestWithoutClaimingVpnOn() = runBlocking {
        val server = ServerSocket(0)
        val http = Executors.newSingleThreadExecutor()
        http.submit {
            repeat(2) {
                if (!server.isClosed) runCatching {
                    server.accept().use { socket ->
                        socket.soTimeout = 5_000
                        val reader = socket.getInputStream().bufferedReader()
                        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                        socket.getOutputStream().write("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        socket.getOutputStream().flush()
                    }
                }
            }
        }
        try {
            RuntimeState.requestStop()
            val controller = VpnController(context)
            val phase = controller.status.value.phase
            val result = controller.checkOutbounds(
                """{"log":{"level":"error"},"outbounds":[{"type":"direct","tag":"probe-direct"}],"route":{"final":"probe-direct","auto_detect_interface":true}}""",
                listOf("probe-direct"), "http://127.0.0.1:${server.localPort}/generate_204", 5000,
            )
            assertEquals(1, result.size)
            assertEquals(null, result.single().error)
            assertTrue(result.single().delayMs != null)
            assertEquals(phase, controller.status.value.phase)
            assertEquals(null, RuntimeState.backend.get())
            assertFalse(java.io.File(context.noBackupFilesDir, "libbox/configuration.json").exists())
        } finally { server.close(); http.shutdownNow() }
    }
}
