// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.content.Context
import android.content.Intent
import android.net.VpnService
import io.nekohasekai.libbox.Libbox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import local.waarp.android.service.WaarpVpnService
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/** Activity-independent control plane. No profile or config is sent through an Intent. */
class VpnController(context: Context) {
    private val context = context.applicationContext

    val status: StateFlow<RuntimeStatus> = RuntimeState.status.asStateFlow()
    val groups: StateFlow<List<RuntimeGroup>> = RuntimeState.groups.asStateFlow()
    val outbounds: StateFlow<List<RuntimeOutbound>> = RuntimeState.outbounds.asStateFlow()
    val connections: StateFlow<List<RuntimeConnection>> = RuntimeState.connections.asStateFlow()
    val logs: StateFlow<List<RuntimeLog>> = RuntimeState.logs.asStateFlow()
    val dnsQueries: StateFlow<List<RuntimeDnsQuery>> = RuntimeState.dnsQueries.asStateFlow()

    /** Application installs this before Android creates the VPN service. */
    fun setConfigurationProvider(provider: suspend () -> String) {
        RuntimeState.configurationProvider = provider
    }

    fun prepare(): Intent? = VpnService.prepare(context)

    /** Foreground VPN notification is mandatory; this controls optional native events. */
    fun setEventNotificationsEnabled(enabled: Boolean) { RuntimeState.eventNotificationsEnabled = enabled }

    suspend fun validateConfig(config: String, requireTun: Boolean = true) = withContext(Dispatchers.IO) {
        LibboxRuntime.initialize(context)
        require(config.isNotBlank()) { "Конфигурация VPN пуста" }
        try {
            Libbox.checkConfig(config)
            if (requireTun) require(Libbox.hasTunInbound(config)) { "Конфигурация не содержит TUN" }
        } catch (error: Exception) {
            // The native parser can quote an invalid credential in an error message.
            throw IllegalArgumentException(RuntimeRedaction.forConfiguration(config,
                error.message ?: "Конфигурация не прошла проверку ядра"))
        }
    }

    suspend fun generateWireGuardKeyPair(): WireGuardKeyPair = withContext(Dispatchers.Default) { WireGuardKeys.generate() }
    suspend fun wireGuardPublicKey(privateKey: String): String = withContext(Dispatchers.Default) { WireGuardKeys.publicKey(privateKey) }

    /** A real temporary native core without a TUN. Never runs alongside the active VPN. */
    suspend fun checkOutbounds(
        config: String, tags: List<String>,
        url: String = "https://www.gstatic.com/generate_204", timeoutMs: Int = 5000,
    ): List<RuntimeProbeResult> = suspendCancellableCoroutine { continuation ->
        val idleGeneration = RuntimeState.idleGeneration()
        if (idleGeneration == null) {
            continuation.resumeWith(Result.failure(IllegalStateException(
                "VPN уже работает: проверяйте его действующие профили через urlTest")))
            return@suspendCancellableCoroutine
        }
        val probe = HeadlessProbe(context, config, tags, url, timeoutMs, idleGeneration)
        continuation.invokeOnCancellation { probe.cancel() }
        NativeLane.executor.execute {
            try {
                if (!continuation.isActive) return@execute
                check(RuntimeState.isIdleGeneration(idleGeneration) && RuntimeState.backend.get() == null) {
                    "Проверка отменена после изменения состояния VPN"
                }
                check(RuntimeState.headless.compareAndSet(null, probe)) { "Проверка уже выполняется" }
                val result = probe.execute()
                probe.close()
                if (continuation.isActive) continuation.resumeWith(Result.success(result))
            } catch (error: Exception) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            } finally {
                try { probe.close() }
                finally { RuntimeState.headless.compareAndSet(probe, null) }
            }
        }
    }

    fun start(config: String) {
        require(config.isNotBlank()) { "Конфигурация VPN пуста" }
        check(prepare() == null) { "Сначала разрешите VPN в системном диалоге Android" }
        val request = RuntimeState.requestStart(config)
        RuntimeState.whenCurrent(request.generation) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(WANTED, true).apply()
            RuntimeState.status.update { it.copy(phase = RuntimePhase.STARTING, message = null, telemetryAvailable = false) }
        }
        try {
            context.startForegroundService(
                Intent(context, WaarpVpnService::class.java)
                    .setAction(ACTION_START).putExtra(EXTRA_GENERATION, request.generation),
            )
        } catch (error: Exception) {
            RuntimeState.cancelIfCurrent(request.generation)?.let { token ->
                RuntimeState.service.get()?.requestStop(token, error) ?: RuntimeState.finishStop(token, error)
            }
            throw error
        }
    }

    /** Invalidates in-flight starts immediately; cleanup runs on the service's native lane. */
    fun stop() = stopToken(RuntimeState.requestStop())

    /** A late native stop callback must never stop a replacement generation. */
    internal fun stopIfCurrent(generation: Long) {
        RuntimeState.cancelIfCurrent(generation)?.let(::stopToken)
    }

    private fun stopToken(token: Long) {
        RuntimeState.whenStopped(token) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(WANTED, false).apply()
        }
        val service = RuntimeState.service.get()
        if (service != null) {
            RuntimeState.updateIfStopped(token) { it.copy(phase = RuntimePhase.STOPPING, message = null) }
            service.requestStop(token)
        } else {
            RuntimeState.finishStop(token)
        }
    }

    suspend fun selectOutbound(groupTag: String, outboundTag: String) = withBackend {
        it.selectOutbound(groupTag, outboundTag)
    }

    suspend fun urlTest(
        outboundTag: String,
        url: String = "https://www.gstatic.com/generate_204",
        timeoutMs: Int = 5000,
    ): Long = withBackend { it.urlTest(outboundTag, url, timeoutMs) }

    suspend fun closeConnection(id: String) = withBackend { it.closeConnection(id) }
    suspend fun closeConnections() = withBackend { it.closeConnections() }
    suspend fun rules(): List<RuntimeRule> = withBackend { it.rules() }

    suspend fun clearLogs() {
        val backend = RuntimeState.backend.get()
        if (backend != null) withContext(Dispatchers.IO) { backend.clearLogs() }
        RuntimeState.logs.value = emptyList()
    }

    private suspend fun <T> withBackend(action: (LibboxBackend) -> T): T = withContext(Dispatchers.IO) {
        val backend = RuntimeState.backend.get()
            ?: error("VPN не запущен")
        check(RuntimeState.status.value.phase == RuntimePhase.ON) { "VPN ещё не готов" }
        action(backend)
    }

    companion object {
        const val ACTION_START = "local.waarp.android.START"
        const val ACTION_STOP = "local.waarp.android.STOP"
        internal const val EXTRA_GENERATION = "generation"
        internal const val PREFERENCES = "vpn-runtime"
        internal const val WANTED = "requested-active"
    }
}

internal data class StartRequest(val generation: Long, val config: String?)

/** All observer state is immutable; old JNI callbacks are rejected by generation. */
internal object RuntimeState {
    val status = MutableStateFlow(RuntimeStatus())
    val groups = MutableStateFlow<List<RuntimeGroup>>(emptyList())
    val outbounds = MutableStateFlow<List<RuntimeOutbound>>(emptyList())
    val connections = MutableStateFlow<List<RuntimeConnection>>(emptyList())
    val logs = MutableStateFlow<List<RuntimeLog>>(emptyList())
    val dnsQueries = MutableStateFlow<List<RuntimeDnsQuery>>(emptyList())
    val service = AtomicReference<WaarpVpnService?>()
    val backend = AtomicReference<LibboxBackend?>()
    val headless = AtomicReference<HeadlessProbe?>()
    private val counter = AtomicLong()
    private val desired = AtomicReference<StartRequest?>()
    @Volatile var configurationProvider: (suspend () -> String)? = null
    @Volatile var eventNotificationsEnabled: Boolean = true

    @Synchronized fun requestStart(config: String? = null): StartRequest {
        val value = StartRequest(counter.incrementAndGet(), config)
        desired.set(value)
        headless.get()?.cancel()
        return value
    }

    @Synchronized fun requestStop(): Long {
        val token = counter.incrementAndGet()
        desired.set(null)
        headless.get()?.cancel()
        return token
    }

    fun request(generation: Long): StartRequest? = desired.get()?.takeIf { it.generation == generation }
    fun isCurrent(generation: Long): Boolean = desired.get()?.generation == generation
    fun wanted(): Boolean = desired.get() != null
    fun currentGeneration(): Long? = desired.get()?.generation

    @Synchronized fun idleGeneration(): Long? = counter.get().takeIf { !wanted() }
    @Synchronized fun isIdleGeneration(token: Long): Boolean = counter.get() == token && !wanted()

    @Synchronized fun reloadIfCurrent(generation: Long): StartRequest? =
        if (isCurrent(generation)) requestStart() else null

    @Synchronized fun updateIfCurrent(generation: Long, transform: (RuntimeStatus) -> RuntimeStatus) {
        if (isCurrent(generation)) status.update(transform)
    }

    @Synchronized fun whenCurrent(generation: Long, action: () -> Unit): Boolean {
        if (!isCurrent(generation)) return false
        action()
        return true
    }

    @Synchronized fun whenStopped(token: Long, action: () -> Unit): Boolean {
        if (counter.get() != token || wanted()) return false
        action()
        return true
    }

    @Synchronized fun updateIfStopped(token: Long, transform: (RuntimeStatus) -> RuntimeStatus) {
        if (counter.get() == token && !wanted()) status.update(transform)
    }

    @Synchronized fun cancelIfCurrent(generation: Long): Long? {
        return if (isCurrent(generation)) requestStop() else null
    }

    @Synchronized fun finishStop(token: Long, error: Throwable? = null): Boolean {
        if (counter.get() != token || wanted()) return false
        clearSession()
        if (error != null) fail(error)
        else status.update { it.copy(phase = RuntimePhase.OFF, message = null) }
        return true
    }

    fun clearSession() {
        groups.value = emptyList()
        outbounds.value = emptyList()
        connections.value = emptyList()
        dnsQueries.value = emptyList()
        status.update {
            it.copy(uploadBps = 0, downloadBps = 0, connectionCount = 0, telemetryAvailable = false)
        }
    }

    fun fail(error: Throwable) {
        val text = RuntimeRedaction.redact(error.message ?: error.javaClass.simpleName)
        appendLog(3, text)
        status.update { it.copy(phase = RuntimePhase.ERROR, message = text, telemetryAvailable = false) }
    }

    fun appendLog(level: Int, message: String) {
        val entry = RuntimeLog(System.currentTimeMillis(), level, RuntimeRedaction.redact(message))
        logs.update { (it + entry).takeLast(500) }
    }
}
