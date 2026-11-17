// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import kotlinx.coroutines.flow.update
import java.util.concurrent.Executors

/**
 * Process-owned ordering for durable VPN intent and recovery, independent of
 * both Activity jobs and the native lane (which may be waiting for a config).
 *
 * Enqueue a user transition while holding RuntimeState's short generation
 * monitor; do not wait for this worker, or hold that monitor during I/O. OFF
 * remains STOPPING until its durable write and native cleanup have completed.
 */
internal object VpnControlLane {
    private val current = ThreadLocal<Boolean>()
    private val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "waarp-intent").apply { isDaemon = true }
    }

    fun execute(action: () -> Unit) {
        executor.execute {
            current.set(true)
            try { action() }
            finally { current.remove() }
        }
    }

    fun requireCurrent() {
        check(current.get() == true) { "VPN persistence must run on its control worker" }
        check(!Thread.holdsLock(RuntimeState)) { "VPN persistence must not hold the runtime generation monitor" }
    }

    fun enqueueStart(request: StartRequest, action: () -> Unit): Boolean =
        RuntimeState.whenCurrent(request.generation) {
            RuntimeState.status.update {
                it.copy(phase = RuntimePhase.STARTING, message = null, telemetryAvailable = false)
            }
            execute(action)
        }

    /** Recheck after persistence: an OFF arriving during a slow commit wins. */
    fun completeStart(
        request: StartRequest,
        persist: () -> Boolean,
        activate: () -> Unit,
        fail: (Exception) -> Unit,
    ) {
        requireCurrent()
        try {
            if (!RuntimeState.isCurrent(request.generation)) return
            val enabled = persist()
            if (!RuntimeState.isCurrent(request.generation)) return
            check(enabled) { "Намерение включить VPN больше не действует" }
            activate()
        } catch (error: Exception) { fail(error) }
    }

    /** Every accepted OFF write precedes a later ON write, even when superseded. */
    fun enqueueStop(
        expectedGeneration: Long?,
        requireWanted: Boolean?,
        pausedForUpdate: Boolean,
        persist: () -> Throwable?,
        finish: (Long, Throwable?) -> Unit,
    ): Long? = RuntimeState.stopAndApply(expectedGeneration, requireWanted, pausedForUpdate) { token ->
        RuntimeState.status.update {
            it.copy(phase = RuntimePhase.STOPPING, message = null, telemetryAvailable = false)
        }
        execute {
            val error = try { persist() } catch (error: Exception) { error }
            finish(token, error)
        }
    }
}
