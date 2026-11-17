// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import local.waarp.android.core.LibboxBackend
import local.waarp.android.core.NativeLane
import local.waarp.android.core.RuntimePhase
import local.waarp.android.core.RuntimeRedaction
import local.waarp.android.core.RuntimeState
import local.waarp.android.core.StartRequest
import local.waarp.android.core.VpnController
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Foreground VPN lifecycle belongs to Android, not to a screen or Activity. */
class WaarpVpnService : VpnService() {
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val backend = AtomicReference<LibboxBackend?>()
    private val configurationLoad = AtomicReference<Job?>()
    private val destroyed = AtomicBoolean()
    private var foreground = false
    @Volatile private var latestStartId = 0
    @Volatile private var acceptedGeneration = -1L
    private var restoringGeneration: Long? = null
    private lateinit var notificationManager: NotificationManager

    override fun onCreate() {
        super.onCreate()
        RuntimeState.service.set(this)
        notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(NotificationChannel(
            CHANNEL, "Соединение Waarp", NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Постоянное уведомление работающего VPN"; setShowBadge(false) })
        notificationManager.createNotificationChannel(NotificationChannel(
            EVENTS_CHANNEL, "События VPN", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply { setShowBadge(false) })
        scope.launch {
            // Traffic counters do not appear in this notification; do not send
            // the same Binder update for every telemetry sample.
            RuntimeState.status.map { it.phase to it.message }.distinctUntilChanged().collectLatest { (phase, message) ->
                if (destroyed.get() || RuntimeState.service.get() !== this@WaarpVpnService) return@collectLatest
                val current = RuntimeState.status.value
                if (current.phase != phase || current.message != message) return@collectLatest
                if (foreground) runCatching { notificationManager.notify(NOTIFICATION_ID, notification()) }
                if (phase == RuntimePhase.ERROR && RuntimeState.eventNotificationsEnabled) {
                    runCatching {
                        notificationManager.notify(ERROR_NOTIFICATION_ID, Notification.Builder(this@WaarpVpnService, EVENTS_CHANNEL)
                            .setSmallIcon(local.waarp.android.R.drawable.ic_stat_waarp)
                            .setContentTitle("Waarp: VPN не запущен")
                            .setContentText(RuntimeRedaction.redact(message.orEmpty()).take(500))
                            .setContentIntent(openAppIntent()).setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).build())
                    }
                }
            }
        }
        scope.launch {
            RuntimeState.status.map { it.phase }.distinctUntilChanged().collectLatest { phase ->
                if (phase != RuntimePhase.ON) {
                    VpnController(this@WaarpVpnService).recoveryInterrupted(RuntimeState.sessionGeneration())
                    return@collectLatest
                }
                while (true) {
                    val generation = RuntimeState.currentGeneration() ?: break
                    VpnController(this@WaarpVpnService).recoveryHeartbeat(generation)
                    delay(VpnRecoveryWatchdog.HEARTBEAT_MS)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        // Even a cancelled/stale startForegroundService Intent carries Android's
        // foreground deadline. A quick OFF must acknowledge it before stopping.
        if (intent?.action != VpnController.ACTION_STOP) {
            try { promoteToForeground() }
            catch (error: Exception) {
                val generation = if (intent?.action == VpnController.ACTION_START)
                    intent.getLongExtra(VpnController.EXTRA_GENERATION, -1) else RuntimeState.sessionGeneration()
                VpnController(this).failAtGeneration(generation, error)
                if (settledOff()) stopSelfResult(startId)
                return START_NOT_STICKY
            }
        }
        if (intent?.action == VpnController.ACTION_STOP) {
            VpnController(this).stop()
            return START_NOT_STICKY
        }
        // A duplicate platform delivery to this live Service is not a process
        // death. A newly recreated Service has no accepted generation and must
        // go through the persisted recovery fuse instead.
        if (intent?.action != VpnController.ACTION_START && RuntimeState.isCurrent(acceptedGeneration)) {
            return START_STICKY
        }
        if (intent?.action == VpnController.ACTION_START) {
            return acceptStart(RuntimeState.request(intent.getLongExtra(VpnController.EXTRA_GENERATION, -1)))
        }
        val expected = RuntimeState.sessionGeneration()
        // Duplicate platform deliveries must not consume the recovery fuse
        // twice while the first durable claim is still running.
        if (restoringGeneration == expected) return START_STICKY
        restoringGeneration = expected
        VpnController(this).restoreFromSystem(isAlwaysOn, expected) { request ->
            main.post {
                if (restoringGeneration == expected) restoringGeneration = null
                if (!destroyed.get()) acceptStart(request)
            }
        }
        // Foreground acknowledgement happened above, before any disk work.
        // A rejected restoration stops this Service after its worker result.
        return START_STICKY
    }

    private fun acceptStart(request: StartRequest?): Int {
        if (request == null || !RuntimeState.isCurrent(request.generation)) {
            if (settledOff()) finishForeground()
            return if (RuntimeState.wanted()) START_STICKY else START_NOT_STICKY
        }
        if (acceptedGeneration == request.generation) return START_STICKY
        val alwaysOn: Boolean
        val lockdown: Boolean
        try {
            check(prepare(this) == null) { "Разрешение VPN отсутствует. Откройте Waarp и разрешите подключение" }
            promoteToForeground()
            // Binder calls must stay outside the runtime generation monitor.
            alwaysOn = isAlwaysOn
            lockdown = isLockdownEnabled
        } catch (error: Exception) {
            VpnController(this).failAtGeneration(request.generation, error)
            return START_NOT_STICKY
        }
        if (!RuntimeState.whenCurrent(request.generation) {
                acceptedGeneration = request.generation
                RuntimeState.status.update {
                    it.copy(phase = RuntimePhase.STARTING, message = null, alwaysOn = alwaysOn, lockdown = lockdown)
                }
            }) {
            if (settledOff()) finishForeground()
            return if (RuntimeState.wanted()) START_STICKY else START_NOT_STICKY
        }
        NativeLane.executor.execute { start(request) }
        return START_STICKY
    }

    private fun start(request: StartRequest) {
        if (destroyed.get() || !RuntimeState.isCurrent(request.generation)) return
        try {
            closeBackend()
            if (destroyed.get() || !RuntimeState.isCurrent(request.generation)) return
            val config = request.config ?: runBlocking {
                val loading = currentCoroutineContext()[Job]!!
                configurationLoad.set(loading)
                try {
                    if (destroyed.get() || !RuntimeState.isCurrent(request.generation)) throw CancellationException("Запуск отменён")
                    withTimeout(20_000) {
                        val provider = RuntimeState.configurationProvider
                            ?: throw IOException("Хранилище конфигурации ещё не готово")
                        provider()
                    }
                } finally {
                    configurationLoad.compareAndSet(loading, null)
                }
            }
            if (destroyed.get() || !RuntimeState.isCurrent(request.generation)) return
            val next = LibboxBackend(
                this, request.generation,
                onStop = { VpnController(this).stopIfCurrent(request.generation) },
                onReload = { reloadFromRepository(request.generation) },
                onFailure = { error -> failGeneration(request.generation, error) },
                // Native publication holds only the short generation monitor.
                // Post Binder notification calls and recheck after dispatch.
                onNotification = { event -> main.post {
                    if (!destroyed.get() && RuntimeState.service.get() === this &&
                        RuntimeState.isCurrent(request.generation)) postCoreNotification(event)
                } },
                onCancelNotification = { id, type -> main.post {
                    if (!destroyed.get() && RuntimeState.service.get() === this &&
                        RuntimeState.isCurrent(request.generation)) notificationManager.cancel(notificationKey(id, type))
                } },
            )
            backend.set(next)
            RuntimeState.backend.set(next)
            next.start(config)
            if (destroyed.get() || !RuntimeState.isCurrent(request.generation)) closeBackend(next)
        } catch (error: Exception) {
            runCatching { closeBackend() }.exceptionOrNull()?.let { if (it !== error) error.addSuppressed(it) }
            VpnController(this).failAtGeneration(request.generation, error)
        }
    }

    private fun reloadFromRepository(generation: Long) {
        if (destroyed.get()) return
        val request = RuntimeState.reloadIfCurrent(generation) ?: return
        if (!RuntimeState.whenCurrent(request.generation) {
                acceptedGeneration = request.generation
                RuntimeState.status.update { it.copy(phase = RuntimePhase.STARTING, message = null) }
            }) return
        NativeLane.executor.execute { start(request) }
    }

    /** Called after the global generation is invalidated, including during native start. */
    internal fun requestStop(token: Long, error: Throwable? = null) {
        var captured: LibboxBackend? = null
        var loading: Job? = null
        if (!RuntimeState.whenStopped(token) {
                loading = configurationLoad.get()
                captured = backend.get()
            }) return
        // Cancel only the captured old generation, outside the runtime monitor.
        // The provider may be waiting for an edit which is itself awaiting OFF.
        loading?.cancel()
        captured?.cancel()
        val current = captured
        NativeLane.executor.execute {
            val closeError = runCatching { closeBackend(current) }.exceptionOrNull()
            if (error != null && closeError != null && error !== closeError) error.addSuppressed(closeError)
            if (RuntimeState.finishStop(token, error ?: closeError)) finishForeground()
        }
    }

    private fun failGeneration(generation: Long, error: Throwable) {
        VpnController(this).failAtGeneration(generation, error)
    }

    private fun closeBackend(expected: LibboxBackend? = backend.get()) {
        if (expected == null) return
        backend.compareAndSet(expected, null)
        RuntimeState.backend.compareAndSet(expected, null)
        expected.close()
    }

    override fun onRevoke() {
        // Android may call this on a Binder thread. Stop never touches Activity state.
        VpnController(this).stop()
    }

    override fun onDestroy() {
        destroyed.set(true)
        configurationLoad.get()?.cancel()
        val current = backend.getAndSet(null)
        current?.cancel()
        if (RuntimeState.service.get() === this) {
            RuntimeState.currentGeneration()?.let { generation ->
                RuntimeState.updateIfCurrent(generation) {
                    it.copy(phase = RuntimePhase.STARTING, message = "Android перезапускает VPN-сервис", telemetryAvailable = false)
                }
                VpnController(this).recoveryInterrupted(generation)
            }
        }
        NativeLane.executor.execute {
            try {
                if (current != null) {
                    RuntimeState.backend.compareAndSet(current, null)
                    current.close()
                }
            } catch (error: Exception) {
                RuntimeState.appendLog(3, "Ошибка закрытия VPN: ${error.message.orEmpty()}")
            } finally {
                // Keep the stop coordinator reachable until its native resources are gone.
                // Otherwise a simultaneous OFF could observe no Service and claim cleanup finished.
                RuntimeState.service.compareAndSet(this, null)
            }
        }
        scope.cancel()
        super.onDestroy()
    }

    private fun promoteToForeground() {
        notificationManager.cancel(ERROR_NOTIFICATION_ID)
        val visible = notification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, visible, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
        else startForeground(NOTIFICATION_ID, visible)
        foreground = true
    }

    private fun finishForeground() = main.post {
        // A queued OFF must not remove a later ON's foreground notification.
        if (!destroyed.get() && RuntimeState.service.get() === this && settledOff()) {
            foreground = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            // Duplicate system deliveries can share one async recovery result.
            stopSelfResult(latestStartId)
        }
    }

    private fun settledOff(): Boolean = restoringGeneration == null && !RuntimeState.wanted() &&
        RuntimeState.status.value.phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR)

    private fun notification(): Notification {
        val state = RuntimeState.status.value
        val description = when (state.phase) {
            RuntimePhase.OFF -> "VPN выключен"
            RuntimePhase.STARTING -> "Подключение VPN…"
            RuntimePhase.ON -> "VPN запущен"
            RuntimePhase.STOPPING -> "Отключение VPN…"
            RuntimePhase.ERROR -> "Не удалось запустить VPN"
        }
        val stop = PendingIntent.getService(this, 1,
            Intent(this, WaarpVpnService::class.java).setAction(VpnController.ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(local.waarp.android.R.drawable.ic_stat_waarp)
            .setContentTitle("Waarp")
            .setContentText(description)
            .setContentIntent(openAppIntent())
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Отключить", stop).build())
            .build()
    }

    private fun openAppIntent(): PendingIntent? = packageManager.getLaunchIntentForPackage(packageName)?.let {
        PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun postCoreNotification(event: io.nekohasekai.libbox.Notification) {
        if (!RuntimeState.eventNotificationsEnabled) return
        // Remote core events can display a message; they cannot launch arbitrary URLs or actions.
        val item = Notification.Builder(this, EVENTS_CHANNEL)
            .setSmallIcon(local.waarp.android.R.drawable.ic_stat_waarp)
            .setContentTitle(RuntimeRedaction.redact(event.title).take(160))
            .setContentText(RuntimeRedaction.redact(event.body).take(500))
            .setContentIntent(openAppIntent())
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true).build()
        notificationManager.notify(notificationKey(event.identifier, event.typeID), item)
    }

    private fun notificationKey(identifier: String, type: Int): Int = 10_000 + (31 * identifier.hashCode() + type).and(0x3fff_ffff)

    companion object {
        private const val CHANNEL = "waarp-vpn"
        private const val EVENTS_CHANNEL = "waarp-vpn-events"
        private const val NOTIFICATION_ID = 4242
        private const val ERROR_NOTIFICATION_ID = 4243
    }
}
