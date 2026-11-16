// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.VpnService
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ActivityScenario
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import io.nekohasekai.libbox.Libbox
import local.waarp.android.service.WaarpVpnService
import local.waarp.android.MainActivity
import local.waarp.android.data.AppData
import local.waarp.android.data.AppSettings
import local.waarp.android.data.ProfileImporter
import local.waarp.android.data.RoutingCompiler
import local.waarp.android.data.TrafficRoute
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.net.InetSocketAddress
import java.net.Socket

@RunWith(AndroidJUnit4::class)
class VpnLifecycleInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val controller get() = VpnController(context)
    private val testPackage get() = instrumentation.context.packageName
    private var activity: ActivityScenario<MainActivity>? = null

    @Before fun prepareVpn() = runBlocking {
        controller.stop()
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
        // Test infrastructure grants only this test app's VPN AppOp, never another package.
        instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} ACTIVATE_VPN allow")
            .use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
        activity = ActivityScenario.launch(MainActivity::class.java)
        val consent = controller.prepare()
        if (consent != null) {
            launchConsent(consent)
            val device = UiDevice.getInstance(instrumentation)
            val button = device.wait(Until.findObject(By.res("android", "button1")), 10_000)
            checkNotNull(button) { "Android VPN consent dialog did not appear" }
            button.click()
            withTimeout(10_000) { while (controller.prepare() != null) delay(50) }
        }
        assertEquals(null, controller.prepare())
    }

    @After fun stopVpn(): Unit = runBlocking {
        try {
            controller.stop()
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
        } finally { activity?.close(); activity = null }
    }

    @Test fun realTunRoutesAnotherAppAndShutsDownCleanly() = runBlocking {
        val statusCode = AtomicInteger(-2)
        val probeError = AtomicReference("")
        val answer = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                probeError.set(intent.getStringExtra("error").orEmpty())
                statusCode.set(intent.getIntExtra("code", -3)); answer.countDown()
            }
        }
        val filter = IntentFilter("local.waarp.android.TEST_HTTP_RESULT")
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        try {
            val host = controller.checkOutbounds(
                """{"outbounds":[{"type":"direct","tag":"host-direct"}],"route":{"final":"host-direct","auto_detect_interface":true}}""",
                listOf("host-direct"), "http://10.0.2.2:18080/generate_204", 5000)
            assertEquals("Host HTTP fixture must be reachable before creating TUN", null, host.single().error)
            controller.start(tunConfiguration())
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
            assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
            assertTrue(RuntimeState.backend.get() != null)
            assertFalse(java.io.File(context.noBackupFilesDir, "libbox/configuration.json").exists())
            context.startActivity(Intent().setComponent(ComponentName(testPackage, ProbeActivity::class.java.name))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("url", "http://fixture.waarp.test:18080/generate_204")
                .putExtra("destination", context.packageName))
            assertTrue("The separate app did not complete its real HTTP request", answer.await(25, TimeUnit.SECONDS))
            assertEquals("HTTP fixture: ${probeError.get()}; DNS=${controller.dnsQueries.value}; " +
                "flows=${controller.connections.value.filter { testPackage in it.packages }}; " +
                "native=${fixtureLogs("fixture.waarp.test", "18080")}", 204, statusCode.get())
            val flow = withTimeout(10_000) {
                controller.connections.first { list -> list.any { testPackage in it.packages && it.outbound == "per-app-route" &&
                    (it.uploadBytes > 0 || it.downloadBytes > 0) } }
            }.first { testPackage in it.packages && it.outbound == "per-app-route" && (it.uploadBytes > 0 || it.downloadBytes > 0) }
            assertTrue(flow.uploadBytes > 0 || flow.downloadBytes > 0)
            withTimeout(10_000) {
                controller.dnsQueries.first { list -> list.any { it.domain.startsWith("fixture.waarp.test") && it.server == "fixture-dns" && !it.failed } }
            }
            controller.stop()
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
            assertEquals(null, RuntimeState.backend.get())
        } finally { context.unregisterReceiver(receiver) }
    }

    @Test fun immediateOffNeverBecomesALateOn() = runBlocking {
        repeat(5) {
            controller.start(tunConfiguration())
            controller.stop()
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
            delay(350)
            assertEquals(RuntimePhase.OFF, controller.status.value.phase)
            assertEquals(null, RuntimeState.backend.get())
        }
    }

    @Test fun encryptedAwg2DnsRoundTripSurvivesOffOn() = runBlocking {
        val keys = controller.generateWireGuardKeyPair()
        val peer = fixtureJson("/register", JSONObject().put("public_key", keys.publicKey).toString())
        val profile = ProfileImporter.parse("""
            [Interface]
            PrivateKey = ${keys.privateKey}
            Address = 10.77.0.2/32
            DNS = 10.77.0.1
            MTU = 1280
            Jc = 2
            Jmin = 32
            Jmax = 64
            S1 = 80
            S2 = 20
            S3 = 35
            S4 = 12
            H1 = 1000-1100
            H2 = 2000-2100
            H3 = 3000-3100
            H4 = 4000-4100
            I1 = <r 24>
            [Peer]
            PublicKey = ${peer.getString("server_public_key")}
            Endpoint = 10.0.2.2:${peer.getInt("endpoint_port")}
            AllowedIPs = 10.77.0.1/32
            PersistentKeepalive = 0
        """.trimIndent()).profiles.single()
        assertEquals("AWG2", profile.protocol)
        val data = AppData(profiles = listOf(profile), settings = AppSettings(lanDirect = false),
            routes = listOf(TrafficRoute(name = "Encrypted DNS acceptance", kind = "app", match = testPackage, via = profile.id)))
        val configuration = JSONObject(RoutingCompiler.compile(data, context.packageName).json).apply {
            getJSONObject("log").put("level", "debug") // Diagnostics only; retain the production routing/DNS policy.
        }.toString()
        controller.validateConfig(configuration)
        val statusCode = AtomicInteger(-2)
        val probeError = AtomicReference("")
        var answer = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                probeError.set(intent.getStringExtra("error").orEmpty())
                statusCode.set(intent.getIntExtra("code", -3)); answer.countDown()
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter("local.waarp.android.TEST_DNS_RESULT"), ContextCompat.RECEIVER_EXPORTED)
        try {
            repeat(2) { cycle ->
                val before = fixtureJson("/proof").getLong("encrypted_dns_replies")
                controller.start(configuration)
                withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
                assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
                statusCode.set(-2)
                answer = CountDownLatch(1)
                context.startActivity(Intent().setComponent(ComponentName(testPackage, ProbeActivity::class.java.name))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("dns", true).putExtra("destination", context.packageName))
                assertTrue("Encrypted DNS cycle $cycle did not complete", answer.await(25, TimeUnit.SECONDS))
                assertEquals("Synthetic inner DNS answer must traverse AWG2; cycle=$cycle; ${probeError.get()}; " +
                    "DNS=${controller.dnsQueries.value}; host=${fixtureJson("/proof")}; " +
                    "native=${fixtureLogs("example.com", "10.77.", "18081", profile.id)}", 204, statusCode.get())
                withTimeout(10_000) {
                    controller.dnsQueries.first { list -> list.any { it.domain.startsWith("example.com") &&
                        it.server == "dns-${profile.id}" && !it.failed } }
                }
                val proof = fixtureJson("/proof")
                assertTrue(proof.getBoolean("authenticated_handshake"))
                assertTrue("A cached answer cannot substitute for a new encrypted round trip", proof.getLong("encrypted_dns_replies") > before)
                assertTrue(proof.getBoolean("awg_handshake_header_padding_observed"))
                assertTrue(proof.getBoolean("awg_transport_header_padding_observed"))
                assertTrue(proof.getBoolean("plaintext_dns_absent_from_outer_udp"))
                assertEquals(0L, proof.getLong("device_error_events"))
                controller.stop()
                withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
                assertEquals(null, RuntimeState.backend.get())
            }
        } finally { context.unregisterReceiver(receiver) }
    }

    @Test fun invalidConfigurationNeverReportsOn() = runBlocking {
        controller.start("""{"inbounds":[{"type":"does-not-exist"}]}""")
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ERROR } }
        assertFalse(controller.status.value.message.isNullOrBlank())
        assertEquals(null, RuntimeState.backend.get())
        delay(350)
        assertEquals(RuntimePhase.ERROR, controller.status.value.phase)
    }

    @Test fun nativeConfigWithoutTunCannotBecomeVpnOn() = runBlocking {
        controller.start("""{"outbounds":[{"type":"direct","tag":"direct"}]}""")
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ERROR } }
        assertEquals(null, RuntimeState.backend.get())
        assertTrue(controller.status.value.message.orEmpty().contains("TUN"))
    }

    @Test fun nativeStopCommandConvergesToUiOff() = runBlocking {
        controller.start(tunConfiguration())
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON } }
        val control = Libbox.newStandaloneCommandClient()
        try { runCatching { control.serviceClose() } }
        finally { runCatching { control.disconnect() } }
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
        assertEquals(null, RuntimeState.backend.get())
    }

    @Test fun actualAndroidConsentDialogGrantsPermissionBeforeTunStart() = runBlocking {
        instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} ACTIVATE_VPN default")
            .use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
        val request = controller.prepare()
        assertNotNull("Revoked VPN authorization must require the real Android consent dialog", request)
        assertEquals(RuntimePhase.OFF, controller.status.value.phase)
        launchConsent(request!!)
        val device = UiDevice.getInstance(instrumentation)
        val allow = device.wait(Until.findObject(By.res("android", "button1")), 10_000)
        assertNotNull("The Android system VPN consent button must be visible", allow)
        allow!!.click()
        withTimeout(10_000) { while (controller.prepare() != null) delay(50) }
        controller.start(tunConfiguration())
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
        assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
    }

    @Test fun systemRestartRequestsCurrentConfigurationInsteadOfResurrectingDeletedProfile() = runBlocking {
        val previous = RuntimeState.configurationProvider
        try {
            controller.setConfigurationProvider { error("Тест: профиль уже удалён") }
            context.getSharedPreferences(VpnController.PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(VpnController.WANTED, true).commit()
            context.startForegroundService(Intent(context, WaarpVpnService::class.java).setAction(VpnService.SERVICE_INTERFACE))
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ERROR } }
            assertTrue(controller.status.value.message.orEmpty().contains("профиль уже удалён"))
            assertEquals(null, RuntimeState.backend.get())
        } finally { RuntimeState.configurationProvider = previous }
    }

    private fun tunConfiguration(): String = """
        {
          "log": {"level":"info"},
          "dns": {"servers":[{"type":"hosts","tag":"fixture-dns","predefined":{"fixture.waarp.test":"10.0.2.2"}}],
            "rules":[{"package_name":["$testPackage"],"server":"fixture-dns"},{"user_id":[1051],"server":"fixture-dns"},{"package_name_regex":[".+"],"invert":true,"server":"fixture-dns"},{"action":"reject"}],"final":"fixture-dns","strategy":"ipv4_only"},
          "inbounds": [{"type":"tun","tag":"tun","address":["172.23.12.1/30"],"mtu":1400,"auto_route":true,"strict_route":true,"stack":"mixed","include_package":["$testPackage"]}],
          "outbounds": [{"type":"direct","tag":"per-app-route"}],
          "route": {"auto_detect_interface":true,"find_process":true,"default_domain_resolver":"fixture-dns",
            "rules":[{"action":"sniff"},{"protocol":"dns","action":"hijack-dns"},{"package_name":["$testPackage"],"outbound":"per-app-route"},{"action":"reject"}]}
        }
    """.trimIndent()

    @Suppress("DEPRECATION")
    private fun launchConsent(request: Intent) {
        // Android ConfirmDialog requires a calling Activity/package. A NEW_TASK
        // application-context launch has no caller and can dismiss itself immediately.
        checkNotNull(activity).onActivity { it.startActivityForResult(request, 702) }
    }

    private fun fixtureLogs(vararg markers: String): List<String> = controller.logs.value.map { it.message }.filter { line ->
        line.contains(testPackage) || markers.any(line::contains) || line.contains("error", true) || line.contains("failed", true)
    }.takeLast(80)

    /** Test-only localhost control exchanges public keys/counters, never a private key or profile. */
    private fun fixtureJson(path: String, body: String? = null): JSONObject = Socket().use { socket ->
        socket.connect(InetSocketAddress("10.0.2.2", 18081), 3_000)
        socket.soTimeout = 5_000
        val payload = body.orEmpty().toByteArray(Charsets.UTF_8)
        val method = if (body == null) "GET" else "POST"
        val request = "$method $path HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${payload.size}\r\n\r\n"
        socket.getOutputStream().write(request.toByteArray(Charsets.US_ASCII))
        socket.getOutputStream().write(payload)
        socket.getOutputStream().flush()
        val response = socket.getInputStream().bufferedReader(Charsets.UTF_8).readText()
        check(response.lineSequence().first().split(' ').getOrNull(1) == "200") { "Local AWG fixture rejected control request" }
        JSONObject(response.substringAfter("\r\n\r\n"))
    }
}
