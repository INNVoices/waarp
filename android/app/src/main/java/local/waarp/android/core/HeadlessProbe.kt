// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.content.Context
import io.nekohasekai.libbox.CommandClient
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.SystemProxyStatus
import java.io.Closeable
import java.io.IOException
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Runs on NativeLane, using the same pinned core and routing endpoints as a real VPN. */
internal class HeadlessProbe(
    private val context: Context,
    private val config: String,
    private val tags: List<String>,
    private val url: String,
    private val timeoutMs: Int,
    private val idleGeneration: Long,
) : Closeable {
    private val cancelled = AtomicBoolean()
    private val finished = AtomicBoolean()
    private val server = AtomicReference<CommandServer?>()
    private val client = AtomicReference<CommandClient?>()
    private val cancellation = Executors.newSingleThreadExecutor { task -> Thread(task, "waarp-probe-cancel").apply { isDaemon = true } }
    private val platform = AndroidPlatform(context, null, ::current, {}, { _, _ -> })

    private fun current(): Boolean = !cancelled.get() && RuntimeState.isIdleGeneration(idleGeneration)

    private fun startControl(): CommandClient {
        require(tags.isNotEmpty() && tags.size <= 16 && tags.all { it.isNotBlank() }) { "За одну проверку допустимо от 1 до 16 профилей" }
        require(timeoutMs in 100..60_000)
        val target = URI(url)
        require(target.scheme in setOf("http", "https") && !target.host.isNullOrBlank())
        check(current()) { "Проверка отменена" }
        check(RuntimeState.backend.get() == null) { "Проверка не может запускать второй VPN-движок" }
        LibboxRuntime.initialize(context)
        RuntimeRedaction.configure(config)
        require(!Libbox.hasTunInbound(config)) { "Проверочный конфиг не должен содержать TUN" }
        Libbox.checkConfig(config)
        check(current()) { "Проверка отменена" }
        platform.start()
        val core = Libbox.newCommandServer(Handler(), platform)
        server.set(core)
        core.start()
        check(current()) { "Проверка отменена" }
        try { core.startOrReloadService(config, OverrideOptions()) }
        finally { LibboxRuntime.removeConfigurationSnapshot(strict = true) }
        check(current() && core.ready()) { "Проверка отменена или ядро не готово" }
        val control = Libbox.newStandaloneCommandClient()
        client.set(control)
        return control
    }

    fun execute(): List<RuntimeProbeResult> {
        val control = startControl()
        val result = mutableListOf<RuntimeProbeResult>()
        for (tag in tags.distinct()) {
            check(current()) { "Проверка отменена" }
            try {
                val response = control.urlTestOutbound(tag, url, timeoutMs)
                check(current()) { "Проверка отменена" }
                result += RuntimeProbeResult(tag,
                    response.delay.takeIf { response.error.isBlank() }?.toLong(),
                    response.error.takeIf { it.isNotBlank() }?.let(RuntimeRedaction::redact), System.currentTimeMillis())
            } catch (error: Exception) {
                if (!current()) throw IOException("Проверка отменена")
                result += RuntimeProbeResult(tag, null, RuntimeRedaction.redact(error.message ?: "Ошибка проверки"), System.currentTimeMillis())
            }
        }
        return result
    }

    fun fetch(maxBytes: Int): RuntimeHttpResult {
        require(tags.size == 1)
        validateHttpFetch(tags.single(), url, timeoutMs, maxBytes)
        val control = startControl()
        val response = control.getURLViaOutbound(tags.single(), url, timeoutMs, maxBytes, null)
        check(current()) { "Проверка отменена" }
        return RuntimeHttpResult(response.status(), response.content(), response.truncated(), response.contentType(), response.elapsedMs().toLong())
    }

    fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        if (!cancellation.isShutdown) runCatching {
            cancellation.execute {
                client.get()?.let { runCatching { it.disconnect() } }
                server.get()?.let { runCatching { it.closeService() } }
            }
        }
    }

    override fun close() {
        if (!finished.compareAndSet(false, true)) return
        val control = client.getAndSet(null)
        val native = server.getAndSet(null)
        closeResources(
            ::cancel,
            { control?.disconnect() },
            { native?.closeService() },
            { native?.close() },
            platform::close,
            { LibboxRuntime.removeConfigurationSnapshot(strict = true) },
            { cancellation.shutdown() },
        )
    }

    private inner class Handler : CommandServerHandler {
        override fun serviceStop() = cancel()
        override fun serviceReload(): Unit = throw UnsupportedOperationException("Проверка не поддерживает перезагрузку")
        override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus().apply { available = false; enabled = false }
        override fun setSystemProxyEnabled(enabled: Boolean): Unit = throw UnsupportedOperationException("Проверка не меняет системный прокси")
        override fun triggerNativeCrash(): Unit = throw UnsupportedOperationException("Отладочный crash отключён")
        override fun connectSSHAgent(): Int = throw UnsupportedOperationException("SSH agent не настроен")
        override fun writeDebugMessage(message: String) { runCatching { RuntimeState.appendLog(0, message) } }
    }
}
