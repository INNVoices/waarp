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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
    val generation: Long,
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
    private val recovery = StreamRecoveryGate()
    private val reconnect = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "waarp-control").apply { isDaemon = true } }
    private val cancellation = Executors.newSingleThreadExecutor { task -> Thread(task, "waarp-cancel").apply { isDaemon = true } }
    private val platform = AndroidPlatform(vpn, vpn, ::current,
        { event -> publish { onNotification(event) } },
        { id, type -> publish { onCancelNotification(id, type) } })

    private fun current(): Boolean = !closed.get() && RuntimeState.isCurrent(generation)

    /** Convert JNI iterators first; only the immutable result is published under this gate. */
    private fun publish(epoch: Long? = null, action: () -> Unit) {
        RuntimeState.whenCurrent(generation) {
            if (!closed.get() && (epoch == null || epoch == streamEpoch.get() && !recovery.hasFailed(epoch))) action()
        }
    }

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
        recovery.begin()
        connectWithRetries()
        check(current()) { "Запуск отменён" }
        started.set(true)
        val startedAt = client.get()?.startedAt ?: System.currentTimeMillis()
        RuntimeState.updateIfCurrent(generation) {
            it.copy(
                phase = if (recovery.recovering) RuntimePhase.STARTING else RuntimePhase.ON,
                message = if (recovery.recovering) "Восстанавливается связь с VPN-ядром" else null, startedAt = startedAt,
                coreVersion = Libbox.version(), alwaysOn = vpn.isAlwaysOn,
                lockdown = vpn.isLockdownEnabled,
            )
        }
        publish { RuntimeState.appendLog(1, "VPN-ядро ${Libbox.version()} запущено; доступность сервера проверяется отдельно") }
    }

    private fun connectClient(): Long {
        val epoch = synchronized(RuntimeState) {
            check(current()) { "Запуск отменён" }
            RuntimeState.activeFlowTags.value = null
            streamEpoch.incrementAndGet()
        }
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
        updateGroups(connection.groups, epoch)
        updateOutbounds(connection.outbounds, epoch)
        return epoch
    }

    private fun disconnected(epoch: Long, message: String) {
        val launchRecovery = synchronized(RuntimeState) {
            if (!current() || epoch != streamEpoch.get()) return
            RuntimeState.activeFlowTags.value = null
            RuntimeState.status.update {
                it.copy(phase = RuntimePhase.STARTING, message = "Восстанавливается связь с VPN-ядром", telemetryAvailable = false)
            }
            // Always remember the failure, including while a new Connect is in flight.
            recovery.failed(epoch)
        }
        publish { RuntimeState.appendLog(2, message) }
        if (!launchRecovery) return
        runCatching {
            reconnect.execute {
                try { connectWithRetries() }
                catch (error: Exception) { if (current()) onFailure(IOException("Потеряна связь с VPN-ядром", error)) }
            }
        }.onFailure { if (current()) onFailure(it) }
    }

    private fun connectWithRetries() {
        var last: Throwable? = null
        for (attempt in 0..2) {
            check(current()) { "Запуск отменён" }
            try {
                if (attempt > 0) TimeUnit.MILLISECONDS.sleep(250L shl attempt)
                check(current()) { "Запуск отменён" }
                val epoch = connectClient()
                val ready = synchronized(RuntimeState) {
                    if (!current() || epoch != streamEpoch.get()) false
                    else if (!recovery.connected(epoch)) false
                    else {
                        if (started.get()) RuntimeState.status.update { it.copy(phase = RuntimePhase.ON, message = null) }
                        true
                    }
                }
                if (ready) return
                last = IOException("Подписка ядра завершилась во время подключения")
            } catch (error: Exception) { last = error }
        }
        recovery.exhausted()
        throw IOException("Не удалось восстановить подписки ядра", last)
    }

    fun selectOutbound(group: String, outbound: String) {
        require(group.isNotBlank() && outbound.isNotBlank())
        val epoch = streamEpoch.get()
        val control = command()
        control.selectOutbound(group, outbound)
        updateGroups(control.groups, epoch)
    }

    suspend fun urlTest(outbound: String, url: String, timeoutMs: Int): Long = withContext(Dispatchers.IO) {
        require(outbound.isNotBlank())
        val endpoint = URI(url)
        require(endpoint.scheme in setOf("https", "http") && !endpoint.host.isNullOrEmpty()) { "Для проверки нужен HTTP(S)-адрес" }
        require(timeoutMs in 100..60_000) { "Таймаут проверки должен быть от 100 до 60000 мс" }
        check(current()) { "VPN остановлен" }
        // A separate control connection cancels its own request; it reuses the active core's outbound.
        val probe = Libbox.newStandaloneCommandClient()
        probes += probe
        try {
            if (!current()) throw IOException("VPN остановлен")
            val result = cancellableResourceCall(
                cancel = { runCatching { cancellation.execute { runCatching { probe.disconnect() } } } },
                operation = { probe.urlTestOutbound(outbound, url, timeoutMs) },
            )
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
        val native = server.getAndSet(null)
        closeResources(
            ::cancel,
            { native?.closeService() },
            { native?.close() },
            platform::close,
            { LibboxRuntime.removeConfigurationSnapshot(strict = true) },
            { reconnect.shutdown() },
            { cancellation.shutdown() },
        )
    }

    private fun updateGroups(iterator: OutboundGroupIterator?, epoch: Long) {
        if (!current() || iterator == null) return
        val result = mutableListOf<RuntimeGroup>()
        while (iterator.hasNext()) iterator.next().let { group ->
            val members = mutableListOf<RuntimeOutbound>()
            val items = group.items
            while (items.hasNext()) members += items.next().asModel()
            result += RuntimeGroup(group.tag, group.type, group.selectable, group.selected, members)
        }
        publish(epoch) { RuntimeState.groups.value = result }
    }

    private fun updateOutbounds(iterator: OutboundGroupItemIterator?, epoch: Long) {
        if (!current() || iterator == null) return
        val result = mutableListOf<RuntimeOutbound>()
        while (iterator.hasNext()) result += iterator.next().asModel()
        publish(epoch) { RuntimeState.outbounds.value = result }
    }

    private fun OutboundGroupItem.asModel() = RuntimeOutbound(
        tag, type, getURLTestDelay().takeIf { getURLTestTime() > 0 && it > 0 }?.toLong(),
        getURLTestTime() * 1000, endpointState,
    )

    private inner class Handler(private val epoch: Long) : CommandClientHandler {
        private val accumulator = Connections()
        private fun accept(): Boolean = current() && epoch == streamEpoch.get() && !recovery.hasFailed(epoch)
        // These Go interfaces have no error result. A thrown exception would abort ART/JNI.
        private inline fun callback(block: () -> Unit) {
            if (accept()) runCatching(block).onFailure { error ->
                publish(epoch) { RuntimeState.appendLog(3, "Ошибка обработки данных ядра: ${error.javaClass.simpleName}") }
            }
        }
        override fun connected() = Unit
        override fun disconnected(message: String) { runCatching { disconnected(epoch, message) } }
        override fun clearLogs() = callback { publish(epoch) { RuntimeState.logs.value = emptyList() } }
        override fun setDefaultLogLevel(level: Int) = Unit
        override fun initializeClashMode(modeList: StringIterator?, currentMode: String?) = Unit
        override fun updateClashMode(newMode: String?) = Unit
        override fun writeLogs(messageList: LogIterator?) = callback {
            val entries = mutableListOf<Pair<Int, String>>()
            if (messageList != null) while (messageList.hasNext()) messageList.next().let { entries += it.level to it.message }
            publish(epoch) { entries.takeLast(500).forEach { RuntimeState.appendLog(it.first, it.second) } }
        }
        override fun writeStatus(message: StatusMessage?) = callback {
            if (started.get() && server.get()?.ready() != true) {
                onFailure(IOException("VPN-ядро остановилось; соединение закрыто"))
                return@callback
            }
            if (message != null) {
                val metrics = RuntimeStatus(
                    uploadBytes = message.uplinkTotal, downloadBytes = message.downlinkTotal,
                    uploadBps = message.uplink, downloadBps = message.downlink,
                    memoryBytes = message.memory, connectionCount = message.connectionsIn,
                    telemetryAvailable = message.trafficAvailable,
                )
                publish(epoch) {
                    RuntimeState.status.update {
                        it.copy(
                            uploadBytes = metrics.uploadBytes, downloadBytes = metrics.downloadBytes,
                            uploadBps = metrics.uploadBps, downloadBps = metrics.downloadBps,
                            memoryBytes = metrics.memoryBytes, connectionCount = metrics.connectionCount,
                            telemetryAvailable = metrics.telemetryAvailable,
                        )
                    }
                }
            }
        }
        override fun writeGroups(message: OutboundGroupIterator?) = callback { updateGroups(message, epoch) }
        override fun writeOutbounds(message: OutboundGroupItemIterator?) = callback { updateOutbounds(message, epoch) }
        override fun writeConnectionEvents(events: ConnectionEvents?) = callback {
            if (events == null) return@callback
            accumulator.applyEvents(events)
            accumulator.filterState(Libbox.ConnectionStateAll.toInt())
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
            // The display cap must not hide an older live connection from Auto.
            // Read all active tags without materialising every closed flow in Kotlin.
            accumulator.filterState(Libbox.ConnectionStateActive.toInt())
            val active = accumulator.iterator()
            val activeTags = linkedSetOf<String>()
            while (active.hasNext()) active.next().let { item ->
                activeTags += item.outbound
                activeTags += item.chain().toStrings()
                activeTags += item.detour().toStrings()
            }
            publish(epoch) {
                RuntimeState.connections.value = result
                RuntimeState.activeFlowTags.value = activeTags
            }
        }
        override fun writeDNSQuery(query: DnsQuery?) = callback {
            if (query != null) {
                val value = RuntimeDnsQuery(System.currentTimeMillis(), query.domain, query.queryType,
                    query.getDNSServer(), query.failed, RuntimeRedaction.redact(query.error))
                publish(epoch) { RuntimeState.dnsQueries.update { (it + value).takeLast(200) } }
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
        override fun writeDebugMessage(message: String) { runCatching { publish { RuntimeState.appendLog(0, message) } } }
        override fun connectSSHAgent(): Int = throw UnsupportedOperationException("SSH agent не настроен")
    }
}
