// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.SystemClock
import android.provider.Settings
import local.waarp.android.core.RuntimePhase
import local.waarp.android.core.RuntimeState
import local.waarp.android.core.VpnController
import local.waarp.android.data.RecoveryDecision
import local.waarp.android.data.RecoveryHistory
import local.waarp.android.data.RecoveryPolicy
import java.io.IOException
import java.util.UUID

/**
 * Android can unbind a dead TUN owner before processing its process death and
 * consequently lose the START_STICKY restart. A non-wakeup alarm outlives that
 * process. Healthy ON heartbeats defer it; no CPU wakeup or exact-alarm grant is
 * needed. Android may batch/defer delivery, so the delay is not a timing promise.
 *
 * Approach independently implemented after AOSP ActiveServices/Vpn review and
 * LxBox's GPLv3 analysis/implementation at commit
 * 71d3379c8bb7a7d276d440be5ac3ada3a8cd9eef:
 * https://github.com/Leadaxe/LxBox/blob/71d3379c8bb7a7d276d440be5ac3ada3a8cd9eef/docs/spec/tasks/428-vpn-service-start-sticky.md
 *
 * Lock order is RuntimeState -> lock. Never enter RuntimeState, JNI, or a
 * configuration callback while holding lock. Durable writes are only control
 * transitions/attempt claims; periodic heartbeats do not commit to disk.
 */
internal object VpnRecoveryWatchdog {
    const val HEARTBEAT_MS = 10_000L
    private const val ALARM_DELAY_MS = 30_000L
    private const val ACTION = "local.waarp.android.RECOVER_VPN"
    private const val EXTRA_EPOCH = "recovery-epoch"
    private const val EXTRA_PROCESS = "recovery-process"
    private const val EPOCH = "recovery-epoch"
    private const val BLOCKED = "recovery-blocked"
    private const val ATTEMPTS = "recovery-attempts"
    private const val HEALTHY_SINCE = "recovery-healthy-since"
    private const val BOOT_COUNT = "recovery-boot-count"
    private const val REQUEST_CODE = 7_193
    private val lock = Any()
    private val processIdentity = UUID.randomUUID().toString()

    sealed interface Claim {
        data object Start : Claim
        data object Ignore : Claim
        data object Deferred : Claim
        data object Exhausted : Claim
        data object ConsentMissing : Claim
    }

    /** Inspect before asking Android for consent state; claim rechecks under the same outer generation guard. */
    fun canConsider(context: Context, deliveredEpoch: String?, alwaysOn: Boolean): Boolean = synchronized(lock) {
        val prefs = preferences(context)
        if (prefs.getBoolean(BLOCKED, false)) return@synchronized false
        if (deliveredEpoch == null) return@synchronized prefs.getBoolean(VpnController.WANTED, false) || alwaysOn
        RecoveryPolicy.accepts(prefs.getBoolean(VpnController.WANTED, false), prefs.getString(EPOCH, null),
            deliveredEpoch, false, 0, 0)
    }

    /** Called only after the caller has won its runtime generation guard. */
    fun started(context: Context, newUserIntent: Boolean): Boolean = synchronized(lock) {
        val prefs = preferences(context)
        if (!newUserIntent && (!prefs.getBoolean(VpnController.WANTED, false) || prefs.getBoolean(BLOCKED, false))) {
            return@synchronized false
        }
        val epoch = if (newUserIntent) UUID.randomUUID().toString()
            else prefs.getString(EPOCH, null) ?: UUID.randomUUID().toString()
        val history = if (newUserIntent) RecoveryHistory() else RecoveryPolicy.interrupted(readHistory(prefs))
        val editor = prefs.edit().putBoolean(VpnController.WANTED, true)
            .putString(EPOCH, epoch).putBoolean(BLOCKED, false)
        writeHistory(editor, history)
        commit(editor, "Не удалось сохранить намерение включить VPN")
        armLocked(context, epoch, processIdentity)
        true
    }

    /** Shared fuse for platform restarts and alarm recovery; no cached config is stored. */
    fun claim(
        context: Context,
        deliveredEpoch: String?,
        previousProcess: String?,
        alwaysOn: Boolean,
        hasConsent: Boolean,
        expectedGeneration: Long,
        actualGeneration: Long,
    ): Claim = synchronized(lock) {
        val prefs = preferences(context)
        val blocked = prefs.getBoolean(BLOCKED, false)
        val wanted = prefs.getBoolean(VpnController.WANTED, false)
        // Only an actual system Always-on start may establish a missing ON
        // intent; a delivered alarm can never turn a persisted OFF back on.
        val systemEnabling = deliveredEpoch == null && alwaysOn && !wanted && !blocked
        val epoch = prefs.getString(EPOCH, null) ?: if (systemEnabling || (wanted && deliveredEpoch == null))
            UUID.randomUUID().toString() else null
        if (!RecoveryPolicy.accepts(wanted || systemEnabling, epoch, deliveredEpoch, blocked,
                expectedGeneration, actualGeneration)) return@synchronized Claim.Ignore
        if (!hasConsent) return@synchronized Claim.ConsentMissing
        when (val decision = RecoveryPolicy.claim(readHistory(prefs), SystemClock.elapsedRealtime(), bootCount(context))) {
            is RecoveryDecision.Exhausted -> Claim.Exhausted
            is RecoveryDecision.Wait -> {
                // Preserve the dead owner's identity on a deferred recovery so
                // the receiver in this new process may still make the attempt.
                val editor = prefs.edit().putBoolean(VpnController.WANTED, true)
                    .putString(EPOCH, epoch).putBoolean(BLOCKED, false)
                writeHistory(editor, decision.history)
                commit(editor, "Не удалось сохранить ожидание восстановления VPN")
                armLocked(context, epoch!!, previousProcess ?: "platform-restart", decision.delayMs)
                Claim.Deferred
            }
            is RecoveryDecision.Start -> {
                val editor = prefs.edit().putBoolean(VpnController.WANTED, true)
                    .putString(EPOCH, epoch).putBoolean(BLOCKED, false)
                writeHistory(editor, decision.history)
                commit(editor, "Не удалось сохранить попытку восстановления VPN")
                armLocked(context, epoch!!, processIdentity)
                Claim.Start
            }
        }
    }

    /** Cancel even on a disk error; the caller must expose ERROR rather than a durable OFF. */
    fun stopped(context: Context, failed: Boolean): IOException? = synchronized(lock) {
        var failure: IOException? = null
        try {
            val editor = preferences(context).edit().putBoolean(VpnController.WANTED, false)
                .remove(EPOCH).putBoolean(BLOCKED, failed).remove(HEALTHY_SINCE)
            commit(editor, "VPN остановлен, но не удалось сохранить выключенное состояние")
        } catch (error: Exception) {
            failure = if (error is IOException) error else IOException(
                "VPN остановлен, но не удалось сохранить выключенное состояние", error)
        } finally {
            try { cancelLocked(context) }
            catch (error: Exception) {
                if (failure != null) failure.addSuppressed(error)
                else failure = IOException("VPN остановлен, но не удалось отменить его автовосстановление", error)
            }
        }
        failure
    }

    fun heartbeat(context: Context) {
        val generation = RuntimeState.currentGeneration() ?: return
        RuntimeState.whenCurrent(generation) {
            if (RuntimeState.status.value.phase != RuntimePhase.ON) return@whenCurrent
            synchronized(lock) {
                val prefs = preferences(context)
                val epoch = prefs.getString(EPOCH, null) ?: return@synchronized
                if (!prefs.getBoolean(VpnController.WANTED, false) || prefs.getBoolean(BLOCKED, false)) return@synchronized
                val old = readHistory(prefs)
                val next = RecoveryPolicy.healthy(old, SystemClock.elapsedRealtime(), bootCount(context))
                if (next != old) prefs.edit().also { writeHistory(it, next) }.apply()
                armLocked(context, epoch, processIdentity)
            }
        }
    }

    fun interrupted(context: Context) = synchronized(lock) {
        val prefs = preferences(context)
        if (prefs.contains(HEALTHY_SINCE)) prefs.edit().remove(HEALTHY_SINCE).apply()
    }

    fun receive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val epoch = intent.getStringExtra(EXTRA_EPOCH)?.takeIf { it.isNotBlank() } ?: return
        val owner = intent.getStringExtra(EXTRA_PROCESS)?.takeIf { it.isNotBlank() } ?: return
        if (owner == processIdentity) {
            // The originating process still exists, including while an edit
            // intentionally pauses its native runtime. Never undo that pause.
            synchronized(lock) {
                val prefs = preferences(context)
                if (RecoveryPolicy.accepts(prefs.getBoolean(VpnController.WANTED, false), prefs.getString(EPOCH, null),
                        epoch, prefs.getBoolean(BLOCKED, false), 0, 0)) armLocked(context, epoch, owner)
            }
            return
        }
        VpnController(context).recoverFromAlarm(epoch, owner)
    }

    private fun preferences(context: Context): SharedPreferences =
        context.getSharedPreferences(VpnController.PREFERENCES, Context.MODE_PRIVATE)

    private fun bootCount(context: Context): Int = runCatching {
        Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    }.getOrDefault(-1)

    private fun readHistory(prefs: SharedPreferences): RecoveryHistory {
        val value = prefs.getString(ATTEMPTS, "").orEmpty()
        val attempts = if (value.isEmpty()) emptyList() else value.split(',').map {
            it.toLongOrNull()?.takeIf { time -> time >= 0 }
                ?: throw IOException("Повреждено состояние восстановления VPN")
        }
        if (attempts.size > RecoveryPolicy.MAX_ATTEMPTS || attempts != attempts.sorted()) {
            throw IOException("Повреждено состояние восстановления VPN")
        }
        return RecoveryHistory(attempts, prefs.getLong(HEALTHY_SINCE, -1).takeIf { it >= 0 }, prefs.getInt(BOOT_COUNT, -1))
    }

    private fun writeHistory(editor: SharedPreferences.Editor, history: RecoveryHistory) {
        editor.putString(ATTEMPTS, history.attempts.joinToString(",")).putInt(BOOT_COUNT, history.bootCount)
        if (history.healthySince == null) editor.remove(HEALTHY_SINCE)
        else editor.putLong(HEALTHY_SINCE, history.healthySince)
    }

    private fun commit(editor: SharedPreferences.Editor, message: String) {
        if (!editor.commit()) throw IOException(message)
    }

    private fun armLocked(context: Context, epoch: String, owner: String, delayMs: Long = ALARM_DELAY_MS) {
        val operation = PendingIntent.getBroadcast(context, REQUEST_CODE,
            Intent(context, VpnRecoveryReceiver::class.java).setAction(ACTION)
                .putExtra(EXTRA_EPOCH, epoch).putExtra(EXTRA_PROCESS, owner),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        context.getSystemService(AlarmManager::class.java).set(AlarmManager.ELAPSED_REALTIME,
            SystemClock.elapsedRealtime() + delayMs, operation)
    }

    private fun cancelLocked(context: Context) {
        val operation = PendingIntent.getBroadcast(context, REQUEST_CODE,
            Intent(context, VpnRecoveryReceiver::class.java).setAction(ACTION),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) ?: return
        context.getSystemService(AlarmManager::class.java).cancel(operation)
        operation.cancel()
    }
}

/** Explicit, non-exported receiver; its Intent contains no profile or connection data. */
class VpnRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try { VpnRecoveryWatchdog.receive(context, intent) }
        catch (error: Exception) {
            // The controller has already invalidated a failing automatic start.
            RuntimeState.appendLog(3, "Ошибка восстановления VPN: ${error.message.orEmpty()}")
        }
    }
}
