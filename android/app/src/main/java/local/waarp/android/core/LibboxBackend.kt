// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.net.VpnService
import io.nekohasekai.libbox.CommandClient
import io.nekohasekai.libbox.CommandClientHandler
import io.nekohasekai.libbox.CommandClientOptions
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.ConnectionEvents
import io.nekohasekai.libbox.Connections
import io.nekohasekai.libbox.DnsQuery
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LogIterator
import io.nekohasekai.libbox.Notification
import io.nekohasekai.libbox.OutboundGroupItem
import io.nekohasekai.libbox.OutboundGroupItemIterator
import io.nekohasekai.libbox.OutboundGroupIterator
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.StatusMessage
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.SystemProxyStatus
import kotlinx.coroutines.flow.update
import java.io.Closeable
import java.io.IOException
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** One native core per service generation; UI commands never spawn another tunnel or peer. */
internal class LibboxBackend(
    private val vpn: VpnService,
    private val generation: Long,
    private val onStop: () -> Unit,
    private val onReload: () -> Unit,
    private val onFailure: (Throwable) -> Unit,
    private val onNotification: (Notification) -> Unit,
    private val onCancelNotification: (String, Int) -> Unit,
) : Closeable {
    private val closed = AtomicBoolean()
    private val resourcesClosed = AtomicBoolean()
    private val started = AtomicBoolean()
    private val streamEpoch = AtomicLong()
    private val client = AtomicReference<CommandClient?>()
    private val server = AtomicReference<CommandServer?>()
    private val probes = ConcurrentHashMap.newKeySet<CommandClient>()
    private val reconnecting = AtomicBoolean()
    private val reconnect = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "waarp-control").apply { isDaemon = true } }
    private val cancellation = Executors.newSingleThreadExecutor { task -> Thread(task, "waarp-cancel").apply { isDaemon = true } }
    private val platform = AndroidPlatform(vpn, vpn, ::current, onNotification, onCancelNotification)

    private fun current(): Boolean = !closed.get() && RuntimeState.isCurrent(generation)

    fun start(config: String) {
        check(current()) { "Запуск отменён" }
        RuntimeState.updateIfCurrent(generation) {
            it.copy(startedAt = 0, uploadBytes = 0, downloadBytes = 0, uploadBps = 0,
                downloadBps = 0, memoryBytes = 0, connectionCount = 0, telemetryAvailable = false)
        }
        LibboxRuntime.initialize(vpn)
        RuntimeRedaction.configure(config)
        Libbox.checkConfig(config)
        check(Libbox.hasTunInbound(config)) { "В конфигурации отсутствует TUN" }
        check(current()) { "Запуск отменён" }
        platform.start()
        val native = Libbox.newCommandServer(ServerHandler(), platform)
        server.set(native)
        native.start()
        check(current()) { "Запуск отменён" }
        try { native.startOrReloadService(config, OverrideOptions()) }
        finally { LibboxRuntime.removeConfigurationSnapshot(strict = true) }
        check(current()) { "Запуск отменён" }
        check(platform.hasTun && native.ready()) { "Ядро не подтвердило готовность VPN" }
        connectClient()
        check(current()) { "Запуск отменён" }
        started.set(true)
        val startedAt = client.get()?.startedAt ?: System.currentTimeMillis()
        RuntimeState.updateIfCurrent(generation) {
            it.copy(
                phase = if (reconnecting.get()) RuntimePhase.STARTING else RuntimePhase.ON,
                message = if (reconnecting.get()) "Восстанавливается связь с VPN-ядром" else null, startedAt = startedAt,
                coreVersion = Libbox.version(), alwaysOn = vpn.isAlwaysOn,
                lockdown = vpn.isLockdownEnabled,
            )
        }
        RuntimeState.appendLog(1, "VPN-ядро ${Libbox.version()} запущено; доступность сервера проверяется отдельно")
    }

    private fun connectClient() {
        val epoch = streamEpoch.incrementAndGet()
        client.getAndSet(null)?.let { runCatching { it.disconnect() } }
        val options = CommandClientOptions().apply {
            addCommand(Libbox.CommandStatus)
            addCommand(Libbox.CommandGroup)
            addCommand(Libbox.CommandOutbounds)
            addCommand(Libbox.CommandConnections)
            addCommand(Libbox.CommandLog)
            addCommand(Libbox.CommandDNS)
            statusInterval = TimeUnit.SECONDS.toNanos(1)
            setDNSIncludeAnswers(false)
        }
        val connection = Libbox.newCommandClient(Handler(epoch), options)
        client.set(connection) // OFF can cancel a Connect which is still waiting.
        connection.connect()
        if (!current()) { connection.disconnect(); throw IOException("Запуск отменён") }
        updateGroups(connection.groups)
        updateOutbounds(connection.outbounds)
    }

    private fun disconnected(epoch: Long, message: String) {
        if (!current() || epoch != streamEpoch.get() || !reconnecting.compareAndSet(false, true)) return
        RuntimeState.updateIfCurrent(generation) {
            it.copy(phase = RuntimePhase.STARTING, message = "Восстанавливается связь с VPN-ядром", telemetryAvailable = false)
        }
        RuntimeState.appendLog(2, message)
        reconnect.execute {
            var last: Throwable? = null
            for (attempt in 0..2) {
                if (!current()) break
                try {
                    if (attempt > 0) TimeUnit.MILLISECONDS.sleep(250L shl attempt)
                    connectClient()
                    if (current() && started.get()) RuntimeState.updateIfCurrent(generation) {
                        it.copy(phase = RuntimePhase.ON, message = null)
                    }
                    last = null
                    break
                } catch (error: Exception) { last = error }
            }
            reconnecting.set(false)
            if (last != null && current()) onFailure(IOException("Потеряна связь с VPN-ядром", last))
        }
    }

    fun selectOutbound(group: String, outbound: String) {
        require(group.isNotBlank() && outbound.isNotBlank())
        command().selectOutbound(group, outbound)
        updateGroups(command().groups)
    }

    fun urlTest(outbound: String, url: String, timeoutMs: Int): Long {
        require(outbound.isNotBlank())
        val endpoint = URI(url)
        require(endpoint.scheme in setOf("https", "http") && !endpoint.host.isNullOrEmpty()) { "Для проверки нужен HTTP(S)-адрес" }
        require(timeoutMs in 100..60_000) { "Таймаут проверки должен быть от 100 до 60000 мс" }
        check(current()) { "VPN остановлен" }
        // A separate control connection cancels its own request; it reuses the active core's outbound.
        val probe = Libbox.newStandaloneCommandClient()
        probes += probe
        return try {
            if (!current()) throw IOException("VPN остановлен")
            val result = probe.urlTestOutbound(outbound, url, timeoutMs)
            if (result.error.isNotBlank()) throw IOException(RuntimeRedaction.redact(result.error))
            check(current()) { "Проверка отменена" }
            result.delay.toLong()
        } finally {
            probes -= probe
            runCatching { probe.disconnect() }
        }
    }

    fun closeConnection(id: String) { require(id.isNotBlank()); command().closeConnection(id) }
    fun closeConnections() = command().closeConnections()
    fun clearLogs() = command().clearLogs()

    fun rules(): List<RuntimeRule> {
        val iterator = command().rules
        val result = mutableListOf<RuntimeRule>()
        while (iterator.hasNext()) iterator.next().let {
            result += RuntimeRule(it.type, it.payload, it.action, it.isDNS)
        }
        return result
    }

    private fun command(): CommandClient {
        check(current()) { "VPN остановлен" }
        return client.get() ?: error("Управление VPN ещё не готово")
    }

    /** First half of OFF: break start/probe/stream waits without blocking the main thread. */
    fun cancel() {
        if (!closed.compareAndSet(false, true)) return
        streamEpoch.incrementAndGet()
        platform.cancelTun()
        val oldClient = client.getAndSet(null)
        val oldProbes = probes.toList()
        probes.clear()
        // Disconnect may wait for Go goroutines. It is never run on Android's main thread.
        if (!cancellation.isShutdown) runCatching {
            cancellation.execute {
                oldProbes.forEach { runCatching { it.disconnect() } }
                oldClient?.let { runCatching { it.disconnect() } }
                // libbox duplicates the TUN fd. Closing only the Java descriptor does NOT
                // stop the native copy. CloseService explicitly interrupts a concurrent Start
                // before acquiring its lifecycle lock (pinned daemon/started_service.go).
                server.get()?.let { runCatching { it.closeService() } }
            }
        }
    }

    /** Second half of OFF, called only on the native service lane. */
    override fun close() {
        if (!resourcesClosed.compareAndSet(false, true)) return
        cancel()
        server.getAndSet(null)?.let { native ->
            runCatching { native.closeService() }.onFailure { RuntimeState.appendLog(2, it.message.orEmpty()) }
            native.close()
        }
        platform.close()
        LibboxRuntime.removeConfigurationSnapshot()
        reconnect.shutdown()
        cancellation.shutdown()
    }

    private fun updateGroups(iterator: OutboundGroupIterator?) {
        if (!current() || iterator == null) return
        val result = mutableListOf<RuntimeGroup>()
        while (iterator.hasNext()) iterator.next().let { group ->
            val members = mutableListOf<RuntimeOutbound>()
            val items = group.items
            while (items.hasNext()) members += items.next().asModel()
            result += RuntimeGroup(group.tag, group.type, group.selectable, group.selected, members)
        }
        RuntimeState.groups.value = result
    }

    private fun updateOutbounds(iterator: OutboundGroupItemIterator?) {
        if (!current() || iterator == null) return
        val result = mutableListOf<RuntimeOutbound>()
        while (iterator.hasNext()) result += iterator.next().asModel()
        RuntimeState.outbounds.value = result
    }

    private fun OutboundGroupItem.asModel() = RuntimeOutbound(
        tag, type, getURLTestDelay().takeIf { getURLTestTime() > 0 && it > 0 }?.toLong(),
        getURLTestTime() * 1000, endpointState,
    )

    private inner class Handler(private val epoch: Long) : CommandClientHandler {
        private val accumulator = Connections()
        private fun accept(): Boolean = current() && epoch == streamEpoch.get()
        // These Go interfaces have no error result. A thrown exception would abort ART/JNI.
        private inline fun callback(block: () -> Unit) {
            if (accept()) runCatching(block).onFailure { RuntimeState.appendLog(3, "Ошибка обработки данных ядра: ${it.javaClass.simpleName}") }
        }
        override fun connected() = Unit
        override fun disconnected(message: String) { runCatching { disconnected(epoch, message) } }
        override fun clearLogs() = callback { RuntimeState.logs.value = emptyList() }
        override fun setDefaultLogLevel(level: Int) = Unit
        override fun initializeClashMode(modeList: StringIterator?, currentMode: String?) = Unit
        override fun updateClashMode(newMode: String?) = Unit
        override fun writeLogs(messageList: LogIterator?) = callback {
            if (messageList != null) while (messageList.hasNext()) messageList.next().let { RuntimeState.appendLog(it.level, it.message) }
        }
        override fun writeStatus(message: StatusMessage?) = callback {
            if (started.get() && server.get()?.ready() != true) {
                onFailure(IOException("VPN-ядро остановилось; соединение закрыто"))
                return@callback
            }
            if (message != null) RuntimeState.status.update {
                it.copy(
                    uploadBytes = message.uplinkTotal, downloadBytes = message.downlinkTotal,
                    uploadBps = message.uplink, downloadBps = message.downlink,
                    memoryBytes = message.memory, connectionCount = message.connectionsIn,
                    telemetryAvailable = message.trafficAvailable,
                )
            }
        }
        override fun writeGroups(message: OutboundGroupIterator?) = callback { updateGroups(message) }
        override fun writeOutbounds(message: OutboundGroupItemIterator?) = callback { updateOutbounds(message) }
        override fun writeConnectionEvents(events: ConnectionEvents?) = callback {
            if (events == null) return@callback
            accumulator.applyEvents(events)
            accumulator.sortByDate()
            val iterator = accumulator.iterator()
            val result = mutableListOf<RuntimeConnection>()
            while (result.size < 500 && iterator.hasNext()) iterator.next().let { item ->
                result += RuntimeConnection(
                    item.getID(), item.network, item.protocol, item.source, item.displayDestination(), item.domain,
                    item.rule, item.outbound, (item.chain().toStrings() + item.detour().toStrings()).distinct(),
                    item.processInfo?.packageNames().toStrings(), item.createdAt, item.closedAt,
                    item.uplinkTotal, item.downlinkTotal,
                )
            }
            RuntimeState.connections.value = result
        }
        override fun writeDNSQuery(query: DnsQuery?) = callback {
            if (query != null) RuntimeState.dnsQueries.update {
                (it + RuntimeDnsQuery(System.currentTimeMillis(), query.domain, query.queryType,
                    query.getDNSServer(), query.failed, RuntimeRedaction.redact(query.error))).takeLast(200)
            }
        }
    }

    private inner class ServerHandler : CommandServerHandler {
        override fun serviceStop() = onStop()
        override fun serviceReload() = onReload()
        override fun getSystemProxyStatus(): SystemProxyStatus = SystemProxyStatus().apply {
            available = platform.httpProxyEnabled
            enabled = platform.httpProxyEnabled
        }
        override fun setSystemProxyEnabled(enabled: Boolean) {
            if (enabled != platform.httpProxyEnabled) throw UnsupportedOperationException("Измените HTTP-прокси в конфигурации и переподключитесь")
        }
        override fun triggerNativeCrash(): Unit = throw UnsupportedOperationException("Аварийная отладочная команда отключена")
        override fun writeDebugMessage(message: String) { runCatching { RuntimeState.appendLog(0, message) } }
        override fun connectSSHAgent(): Int = throw UnsupportedOperationException("SSH agent не настроен")
    }
}
