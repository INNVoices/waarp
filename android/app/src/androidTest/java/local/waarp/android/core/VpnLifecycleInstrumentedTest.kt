// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.net.VpnService
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.os.StrictMode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ActivityScenario
import androidx.core.content.ContextCompat
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
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
import local.waarp.android.data.MobileLiveRouting
import local.waarp.android.data.TunnelProfile
import local.waarp.android.data.DIRECT
import local.waarp.android.data.obj
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
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executor
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
            grantAndroidConsent(consent, "setup")
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
        val probeNetwork = AtomicReference("")
        val answer = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                probeError.set(intent.getStringExtra("error").orEmpty())
                probeNetwork.set(intent.getStringExtra("networkDiagnostics").orEmpty())
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
            assertEquals("HTTP fixture: ${probeError.get()}; network=${probeNetwork.get()}; DNS=${controller.dnsQueries.value}; " +
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

    @Test fun watchedRouteMutationsKeepOneRealTunAndAcknowledgeInsideTheNativeCore(): Unit = runBlocking {
        // The SOCKS definitions are deliberately unreachable reserved addresses. The
        // test proves live policy/selector/TUN continuity, not external proxy reachability.
        fun proxy(id: String) = TunnelProfile(id, id, "SOCKS", "192.0.2.1", 1080,
            obj("type" to "socks", "server" to "192.0.2.1", "server_port" to 1080).toString())
        val folder = File(context.noBackupFilesDir, "instrumented-live-routes-${System.nanoTime()}")
        var data = AppData(profiles = listOf(proxy("one"), proxy("two")),
            routes = listOf(TrafficRoute("first", "first", "custom", "first.example.test", DIRECT)))
        var compiled = MobileLiveRouting.compile(data, context.packageName, null, folder.absolutePath)
        LiveRoutingFiles.initialize(compiled.live!!)
        controller.validateConfig(compiled.json)
        controller.start(compiled.json)
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
        assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
        val generation = controller.sessionGeneration()
        val backend = RuntimeState.backend.get()
        val startedAt = controller.status.value.startedAt
        val outcomes = org.json.JSONArray()
        try {
            suspend fun apply(label: String, changed: AppData) {
                val next = MobileLiveRouting.compile(changed, context.packageName, null, folder.absolutePath, compiled,
                    controller.groups.value.associate { it.tag to it.selected })
                assertTrue("$label must fit existing native definitions", compiled.live!!.compatible(next.live!!))
                controller.applyLiveRouting(compiled.live!!, next.live!!, generation)
                assertEquals(label, RuntimePhase.ON, controller.status.value.phase)
                assertEquals(label, generation, controller.sessionGeneration())
                assertTrue("$label replaced the native core", RuntimeState.backend.get() === backend)
                assertEquals(label, startedAt, controller.status.value.startedAt)
                outcomes.put(label); compiled = next; data = changed
            }
            apply("direct to real profile", data.copy(routes = data.routes.map { it.copy(via = "one") }))
            apply("real profile to another", data.copy(routes = data.routes.map { it.copy(via = "two") }))
            apply("disable card", data.copy(routes = data.routes.map { it.copy(enabled = false) }))
            apply("delete last disabled card", data.copy(routes = emptyList()))
            apply("add card", data.copy(routes = listOf(TrafficRoute("new", "new", "custom", "new.example.test", "one"))))
            apply("delete last active card", data.copy(routes = emptyList()))
            apply("change default route", data.copy(settings = data.settings.copy(defaultVia = "two")))
            apply("restore default direct", data.copy(settings = data.settings.copy(defaultVia = DIRECT)))
        } finally {
            val report = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            File(report, "android-live-route-continuity.json").writeText(obj(
                "scope" to "Real Android TUN, native selector and watched-file acknowledgements; no external server reachability claim",
                "nativeSession" to generation, "completed" to outcomes).toString(2))
            controller.stop()
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
            folder.deleteRecursively()
        }
    }

    @Test fun warmOnOffDoesNotReadOrWriteDiskOnMain(): Unit = runBlocking {
        val configuration = tunConfiguration()
        // Isolate control transitions from first-time framework class/resource
        // loading. The production recovery guard also checks cold I/O ownership.
        controller.start(configuration)
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
        assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
        controller.stop()
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
        withTimeout(20_000) { while (RuntimeState.service.get() != null) delay(25) }
        instrumentation.waitForIdleSync()

        val count = AtomicInteger()
        val violations = ConcurrentLinkedQueue<String>()
        val previous = AtomicReference<StrictMode.ThreadPolicy>()
        val callbackDurations = org.json.JSONArray()
        var completedCycles = 0
        instrumentation.runOnMainSync {
            previous.set(StrictMode.getThreadPolicy())
            StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder()
                .detectDiskReads().detectDiskWrites()
                .penaltyListener(Executor { it.run() }) { violation ->
                    if (count.incrementAndGet() <= 32) violations.add(
                        (violation.javaClass.simpleName + "\n" + violation.stackTrace.take(12).joinToString("\n")).take(3000))
                }.build())
        }
        try {
            repeat(2) { cycle ->
                instrumentation.runOnMainSync {
                    val began = SystemClock.elapsedRealtimeNanos()
                    controller.start(configuration)
                    callbackDurations.put(JSONObject().put("cycle", cycle).put("action", "ON")
                        .put("nanoseconds", SystemClock.elapsedRealtimeNanos() - began))
                }
                withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
                assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
                instrumentation.runOnMainSync {
                    val began = SystemClock.elapsedRealtimeNanos()
                    controller.stop()
                    callbackDurations.put(JSONObject().put("cycle", cycle).put("action", "OFF")
                        .put("nanoseconds", SystemClock.elapsedRealtimeNanos() - began))
                }
                withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR } }
                assertEquals(controller.status.value.message, RuntimePhase.OFF, controller.status.value.phase)
                assertFalse(context.getSharedPreferences(VpnController.PREFERENCES, Context.MODE_PRIVATE)
                    .getBoolean(VpnController.WANTED, true))
                completedCycles++
            }
            withTimeout(20_000) { while (RuntimeState.service.get() != null) delay(25) }
            instrumentation.waitForIdleSync()
        } finally {
            instrumentation.runOnMainSync { StrictMode.setThreadPolicy(previous.get()) }
            val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            File(directory, "vpn-main-thread-io.json").writeText(JSONObject()
                .put("scope", "Warm debug ON/OFF transitions, including asynchronous service lifecycle; not a frame-rate benchmark")
                .put("warmUpCycles", 1).put("requestedCycles", 2).put("measuredCycles", completedCycles)
                .put("mainThreadDiskViolationCount", count.get())
                .put("violations", org.json.JSONArray(violations.toList()))
                .put("callbackDurations", callbackDurations).toString(2))
        }
        assertEquals("Main-thread disk violations: $violations", 0, count.get())
    }

    @Test fun duplicateRejectedSystemStartsDoNotLeaveAnOffServiceRunning(): Unit = runBlocking {
        withTimeout(20_000) { while (RuntimeState.service.get() != null) delay(25) }
        assertEquals(RuntimePhase.OFF, controller.status.value.phase)
        assertFalse(context.getSharedPreferences(VpnController.PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(VpnController.WANTED, true))
        val component = ComponentName(context, WaarpVpnService::class.java).flattenToShortString()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val workerFailure = AtomicReference<Throwable?>()
        val raw = linkedMapOf<String, String>()
        val report = JSONObject().put("scope", "Two real Android system-style Service starts while the durable control worker is held")
        val began = SystemClock.elapsedRealtime()
        val deadline = began + 20_000L

        fun observe(stage: String): ServiceDeliverySnapshot {
            val text = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(
                "dumpsys -t 5 activity services $component"
            )).bufferedReader().use { it.readText() }
            check(text.length <= 128 * 1024) { "Scoped service evidence exceeds its bound" }
            raw[stage] = text
            check(text.contains("ACTIVITY MANAGER SERVICES") && !text.contains("DUMP TIMEOUT", ignoreCase = true) &&
                !text.contains("Permission Denial", ignoreCase = true)) { "Scoped service dump did not complete" }
            val owners = text.lineSequence().filter {
                it.trimStart().startsWith("* ServiceRecord{") && it.contains(component)
            }.count()
            check(owners <= 1) { "Service evidence contains ambiguous owners" }
            val ids = Regex("\\blastStartId=(\\d+)\\b").findAll(text).map { it.groupValues[1].toInt() }.toList()
            val pending = Regex("\\bexecuteNesting=([1-9]\\d*)\\b").containsMatchIn(text) || text.contains("Pending Starts:")
            return ServiceDeliverySnapshot(owners == 1, ids.singleOrNull(),
                owners == 1 && ids.size == 1 && text.contains("startRequested=true") && !pending)
        }
        suspend fun delivered(stage: String, after: Int): Int {
            while (true) {
                check(SystemClock.elapsedRealtime() < deadline) { "Two Service deliveries did not settle within the existing 20-second deadline" }
                val observation = observe(stage)
                check(SystemClock.elapsedRealtime() < deadline) { "Service observation exceeded the existing 20-second deadline" }
                val id = observation.lastStartId
                if (observation.callbacksSettled && id != null && id > after) return id
                delay(25)
            }
        }
        try {
            assertFalse(observe("before").present)
            VpnControlLane.execute {
                entered.countDown()
                try { check(release.await(20, TimeUnit.SECONDS)) { "Test control-worker latch was not released" } }
                catch (error: Throwable) { workerFailure.set(error) }
            }
            assertTrue(entered.await(3, TimeUnit.SECONDS))
            // No ACTION_START and no config payload: exercise the platform
            // restore path, which must reject the already persisted OFF.
            context.startForegroundService(Intent(context, WaarpVpnService::class.java))
            val first = delivered("first", 0)
            assertFalse(checkNotNull(RuntimeState.service.get()).isAlwaysOn)
            context.startForegroundService(Intent(context, WaarpVpnService::class.java))
            val second = delivered("second", first)
            report.put("deliveredStartIds", org.json.JSONArray(listOf(first, second)))
                .put("frameworkCallbacksSettledBeforeRelease", true)
            release.countDown()
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            var serviceAbsent: Boolean
            var vpnAbsent: Boolean
            do {
                check(SystemClock.elapsedRealtime() < deadline) { "Rejected duplicate start left a Service or VPN alive beyond 20 seconds" }
                serviceAbsent = RuntimeState.service.get() == null && !observe("after").present
                vpnAbsent = connectivity.allNetworks.none {
                    connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
                }
                if (!serviceAbsent || !vpnAbsent) delay(25)
            } while (!serviceAbsent || !vpnAbsent)
            assertEquals(null, workerFailure.get())
            assertFalse(RuntimeState.wanted())
            assertEquals(null, RuntimeState.backend.get())
            assertEquals(RuntimePhase.OFF, controller.status.value.phase)
            val elapsed = SystemClock.elapsedRealtime() - began
            check(elapsed <= 20_000L) { "Duplicate-start cleanup observation exceeded the existing 20-second deadline" }
            report.put("serviceAbsent", serviceAbsent).put("vpnAbsent", vpnAbsent)
                .put("elapsedMs", elapsed)
        } finally {
            release.countDown()
            val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
            raw.forEach { (stage, text) -> File(directory, "vpn-duplicate-system-starts-$stage.txt").writeText(text) }
            File(directory, "vpn-duplicate-system-starts.json").writeText(report.toString(2))
        }
    }

    private data class ServiceDeliverySnapshot(val present: Boolean, val lastStartId: Int?, val callbacksSettled: Boolean)

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
        val probeNetwork = AtomicReference("")
        var answer = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                probeError.set(intent.getStringExtra("error").orEmpty())
                probeNetwork.set(intent.getStringExtra("networkDiagnostics").orEmpty())
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
                    "network=${probeNetwork.get()}; DNS=${controller.dnsQueries.value}; host=${fixtureJson("/proof")}; " +
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
        grantAndroidConsent(request!!, "actual")
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

    @Test fun offCancelsAWaitingConfigurationProviderBeforeTheNativeLaneCanDeadlock() = runBlocking {
        val previous = RuntimeState.configurationProvider
        val entered = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        try {
            controller.setConfigurationProvider {
                entered.complete(Unit)
                try { awaitCancellation() }
                finally { cancelled.complete(Unit) }
            }
            context.getSharedPreferences(VpnController.PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(VpnController.WANTED, true).commit()
            context.startForegroundService(Intent(context, WaarpVpnService::class.java).setAction(VpnService.SERVICE_INTERFACE))
            withTimeout(10_000) { entered.await() }
            assertEquals(RuntimePhase.STARTING, controller.status.value.phase)

            val stoppedAt = SystemClock.elapsedRealtime()
            controller.stop()
            // Do not manually release the provider: only production STOP can
            // cancel it. Waiting for its old 20-second timeout must fail here.
            withTimeout(5_000) {
                cancelled.await()
                controller.status.first { it.phase == RuntimePhase.OFF }
            }
            assertTrue("OFF must finish within 5 seconds despite a suspended provider",
                SystemClock.elapsedRealtime() - stoppedAt < 5_000)
            assertTrue(cancelled.isCompleted)
            assertFalse(RuntimeState.wanted())
            assertEquals(null, RuntimeState.backend.get())
        } finally {
            controller.stop()
            RuntimeState.configurationProvider = previous
        }
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

    private data class ConsentButton(
        val windowId: Int,
        val rawBounds: Rect,
        val visibleBounds: Rect,
    )

    private suspend fun grantAndroidConsent(request: Intent, stage: String) {
        val component = checkNotNull(request.component) { "Android VPN consent must identify its system component" }
        val device = UiDevice.getInstance(instrumentation)
        try {
            instrumentation.uiAutomation.let { automation ->
                val info = checkNotNull(automation.serviceInfo)
                info.flags = info.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                automation.serviceInfo = info
            }
            launchConsent(request)
            // A generic android:button1 can belong to an unrelated system dialog.
            // Like AOSP CTS, scope to the component returned by VpnService.prepare;
            // also require its focused window and a stationary, enabled target.
            val deadline = SystemClock.elapsedRealtime() + 10_000L
            var previous: ConsentButton? = null
            var stableSince = SystemClock.elapsedRealtime()
            var ready: ConsentButton? = null
            while (ready == null && SystemClock.elapsedRealtime() < deadline) {
                val candidate = focusedConsentButton(component.packageName)
                val now = SystemClock.elapsedRealtime()
                if (candidate == null || candidate != previous) stableSince = now
                previous = candidate
                if (candidate != null && now - stableSince >= 250L) ready = candidate
                else delay(50)
            }
            val target = checkNotNull(ready) { "Android VPN consent did not expose one focused, ready positive button" }
            check(focusedConsentButton(component.packageName) == target) { "Android VPN consent target changed before the click" }
            check(deadline - SystemClock.elapsedRealtime() > 0L) { "Android VPN consent deadline expired before the click" }
            assertTrue("Android VPN consent click was not injected",
                device.click(target.visibleBounds.centerX(), target.visibleBounds.centerY()))
            // Exactly one click; authorization shares the original readiness deadline.
            val remaining = deadline - SystemClock.elapsedRealtime()
            check(remaining > 0L) { "Android VPN consent deadline expired before authorization completed" }
            withTimeout(remaining) { while (controller.prepare() != null) delay(50) }
        } catch (failure: Throwable) {
            captureConsentFailure(device, component, stage, failure)
            throw failure
        }
    }

    @Suppress("DEPRECATION")
    private fun focusedConsentButton(packageName: String): ConsentButton? {
        val windows = instrumentation.uiAutomation.windows
        try {
            val window = windows.singleOrNull { it.isFocused } ?: return null
            val root = window.root ?: return null
            try {
                if (root.packageName?.toString() != packageName) return null
                val buttons = root.findAccessibilityNodeInfosByViewId("android:id/button1")
                try {
                    val button = buttons.singleOrNull {
                        it.windowId == window.id && it.packageName?.toString() == packageName &&
                            it.className?.toString() == "android.widget.Button" &&
                            it.isVisibleToUser && it.isEnabled && it.isClickable
                    } ?: return null
                    val rawBounds = Rect().also(button::getBoundsInScreen)
                    val windowBounds = Rect().also(window::getBoundsInScreen)
                    val visibleBounds = Rect(rawBounds)
                    val device = UiDevice.getInstance(instrumentation)
                    // AndroidX clicks the visible intersection. Floating-window
                    // surface insets can clip a node's reported raw bounds.
                    if (rawBounds.isEmpty || !visibleBounds.intersect(windowBounds) ||
                        !visibleBounds.intersect(0, 0, device.displayWidth, device.displayHeight)) return null
                    return ConsentButton(window.id, rawBounds, visibleBounds)
                } finally { buttons.forEach { it.recycle() } }
            } finally { root.recycle() }
        } finally { windows.forEach { it.recycle() } }
    }

    private fun captureConsentFailure(device: UiDevice, component: ComponentName, stage: String, failure: Throwable) {
        // Capture before ActivityScenario closes the dialog. Only synthetic test
        // screens are present here; never serialize an Intent or VPN configuration.
        val directory = File(context.getExternalFilesDir(null), "ui-screenshots").apply { mkdirs() }
        val prefix = "failure-vpn-consent-$stage"
        runCatching {
            File(directory, "$prefix-predicates.json").writeText(consentPredicateDiagnostics(device, component))
        }.exceptionOrNull()?.let(failure::addSuppressed)
        runCatching {
            check(device.takeScreenshot(File(directory, "$prefix.png"))) { "Consent screenshot capture failed" }
        }.exceptionOrNull()?.let(failure::addSuppressed)
        runCatching {
            val output = ByteArrayOutputStream()
            device.dumpWindowHierarchy(output)
            check(output.size() <= 512 * 1024) { "Consent window hierarchy exceeds the evidence bound" }
            // Keep actual node structure, ownership, bounds and state, without any
            // text fields or accessibility descriptions that could contain payloads.
            val xml = output.toString("UTF-8").replace(Regex("\\b(text|content-desc)=\"[^\"]*\"")) {
                "${it.groupValues[1]}=\"\""
            }
            File(directory, "$prefix.xml").writeText(xml)
        }.exceptionOrNull()?.let(failure::addSuppressed)
        runCatching {
            val fields = Regex("^\\s*(Window #|mCurrentFocus=|mFocusedApp=|mTopFocusedDisplayId=|mObscuringWindow=|mViewVisibility=|mHasSurface=|mAttrs=|isOnScreen=|isVisible=|mPolicyVisibility=|mHidden=|mDestroying=)")
            val windows = ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.uiAutomation.executeShellCommand("dumpsys window")
            ).bufferedReader().useLines { lines ->
                lines.take(20_000).filter(fields::containsMatchIn).take(250).joinToString("\n")
            }
            File(directory, "$prefix-windows.txt").writeText("expectedComponent=${component.flattenToShortString()}\n$windows\n")
        }.exceptionOrNull()?.let(failure::addSuppressed)
    }

    @Suppress("DEPRECATION")
    private fun consentPredicateDiagnostics(device: UiDevice, component: ComponentName): String {
        val packageName = component.packageName
        val screenBounds = Rect(0, 0, device.displayWidth, device.displayHeight)
        val automation = instrumentation.uiAutomation
        val windows = automation.windows
        try {
            val report = JSONObject()
                .put("expectedComponent", component.flattenToShortString())
                .put("elapsedRealtime", SystemClock.elapsedRealtime())
                .put("screenBounds", screenBounds.toShortString())
                .put("serviceFlags", automation.serviceInfo?.flags ?: -1)
                .put("windowCount", windows.size)
                .put("focusedWindowCount", windows.count { it.isFocused })
                .put("windowsTruncated", windows.size > 8)
            val records = org.json.JSONArray()
            windows.sortedByDescending { it.isFocused }.take(8).forEach { window ->
                val windowBounds = Rect().also(window::getBoundsInScreen)
                val record = JSONObject()
                    .put("id", window.id).put("type", window.type).put("layer", window.layer)
                    .put("focused", window.isFocused).put("active", window.isActive)
                    .put("windowBounds", windowBounds.toShortString())
                val root = window.root
                record.put("rootPresent", root != null)
                if (root != null) {
                    try {
                        val rootPackage = root.packageName?.toString().orEmpty()
                        record.put("rootPackage", rootPackage.take(128))
                            .put("rootPackageMatches", rootPackage == packageName)
                        if (window.isFocused) {
                            val buttons = root.findAccessibilityNodeInfosByViewId("android:id/button1")
                            try {
                                val eligibleCount = buttons.count {
                                    it.windowId == window.id && it.packageName?.toString() == packageName &&
                                        it.className?.toString() == "android.widget.Button" &&
                                        it.isVisibleToUser && it.isEnabled && it.isClickable
                                }
                                val nodes = org.json.JSONArray()
                                buttons.take(4).forEach { button ->
                                    val rawBounds = Rect().also(button::getBoundsInScreen)
                                    val visibleBounds = Rect(rawBounds)
                                    val intersectsWindow = visibleBounds.intersect(windowBounds)
                                    val intersectsScreen = intersectsWindow && visibleBounds.intersect(screenBounds)
                                    nodes.put(JSONObject()
                                        .put("windowId", button.windowId).put("windowMatches", button.windowId == window.id)
                                        .put("resourceId", button.viewIdResourceName.orEmpty().take(128))
                                        .put("package", button.packageName?.toString().orEmpty().take(128))
                                        .put("packageMatches", button.packageName?.toString() == packageName)
                                        .put("class", button.className?.toString().orEmpty().take(128))
                                        .put("classMatches", button.className?.toString() == "android.widget.Button")
                                        .put("visible", button.isVisibleToUser).put("enabled", button.isEnabled)
                                        .put("clickable", button.isClickable)
                                        .put("rawBounds", rawBounds.toShortString()).put("rawBoundsEmpty", rawBounds.isEmpty)
                                        .put("rawContainedByWindow", windowBounds.contains(rawBounds))
                                        .put("intersectsWindow", intersectsWindow).put("intersectsScreen", intersectsScreen)
                                        .put("visibleBounds", if (intersectsScreen) visibleBounds.toShortString() else JSONObject.NULL))
                                }
                                record.put("positiveNodeCount", buttons.size).put("eligibleNodeCount", eligibleCount)
                                    .put("nodesTruncated", buttons.size > 4).put("nodes", nodes)
                            } finally { buttons.forEach { it.recycle() } }
                        }
                    } finally { root.recycle() }
                }
                records.put(record)
            }
            return report.put("windows", records).toString().also {
                check(it.toByteArray(Charsets.UTF_8).size <= 64 * 1024) {
                    "Consent predicate diagnostics exceed the evidence bound"
                }
            }
        } finally { windows.forEach { it.recycle() } }
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
