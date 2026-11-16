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

@RunWith(AndroidJUnit4::class)
class VpnLifecycleInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val controller get() = VpnController(context)
    private val testPackage get() = instrumentation.context.packageName

    @Before fun prepareVpn() = runBlocking {
        controller.stop()
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
        // Test infrastructure grants only this test app's VPN AppOp, never another package.
        instrumentation.uiAutomation.executeShellCommand("appops set ${context.packageName} ACTIVATE_VPN allow")
            .use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
        context.startActivity(context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val consent = controller.prepare()
        if (consent != null) {
            context.startActivity(consent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            val device = UiDevice.getInstance(instrumentation)
            val button = device.wait(Until.findObject(By.res("android", "button1")), 10_000)
            checkNotNull(button) { "Android VPN consent dialog did not appear" }
            button.click()
            withTimeout(10_000) { while (controller.prepare() != null) delay(50) }
        }
        assertEquals(null, controller.prepare())
    }

    @After fun stopVpn(): Unit = runBlocking {
        controller.stop()
        withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.OFF } }
    }

    @Test fun realTunRoutesAnotherAppAndShutsDownCleanly() = runBlocking {
        val statusCode = AtomicInteger(-2)
        val answer = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                statusCode.set(intent.getIntExtra("code", -3)); answer.countDown()
            }
        }
        val filter = IntentFilter("local.waarp.android.TEST_HTTP_RESULT")
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        try {
            controller.start(tunConfiguration())
            withTimeout(20_000) { controller.status.first { it.phase == RuntimePhase.ON || it.phase == RuntimePhase.ERROR } }
            assertEquals(controller.status.value.message, RuntimePhase.ON, controller.status.value.phase)
            assertTrue(RuntimeState.backend.get() != null)
            assertFalse(java.io.File(context.noBackupFilesDir, "libbox/configuration.json").exists())
            context.startActivity(Intent().setComponent(ComponentName(testPackage, ProbeActivity::class.java.name))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("url", "http://fixture.waarp.test:18080/generate_204")
                .putExtra("destination", context.packageName))
            assertTrue("The separate app did not complete its real HTTP request", answer.await(15, TimeUnit.SECONDS))
            assertEquals(204, statusCode.get())
            val flow = withTimeout(10_000) {
                controller.connections.first { list -> list.any { testPackage in it.packages && it.outbound == "per-app-route" } }
            }.first { testPackage in it.packages && it.outbound == "per-app-route" }
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
        context.startActivity(request!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
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
            "rules":[{"package_name":["$testPackage"],"server":"fixture-dns"},{"action":"reject"}],"final":"fixture-dns","strategy":"ipv4_only"},
          "inbounds": [{"type":"tun","tag":"tun","address":["172.23.12.1/30"],"mtu":1400,"auto_route":true,"strict_route":true,"stack":"mixed"}],
          "outbounds": [{"type":"direct","tag":"per-app-route"}],
          "route": {"auto_detect_interface":true,"find_process":true,"default_domain_resolver":"fixture-dns",
            "rules":[{"action":"sniff"},{"protocol":"dns","action":"hijack-dns"},{"package_name":["$testPackage"],"outbound":"per-app-route"},{"action":"reject"}]}
        }
    """.trimIndent()
}
