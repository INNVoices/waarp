// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

/** No configuration, credentials, wall clock, or Android objects belong in recovery state. */
internal data class RecoveryHistory(
    val attempts: List<Long> = emptyList(),
    val healthySince: Long? = null,
    val bootCount: Int = -1,
)

internal sealed interface RecoveryDecision {
    val history: RecoveryHistory
    data class Start(override val history: RecoveryHistory) : RecoveryDecision
    data class Wait(override val history: RecoveryHistory, val delayMs: Long) : RecoveryDecision
    data class Exhausted(override val history: RecoveryHistory) : RecoveryDecision
}

/** Bounded recovery for both Android's sticky restart and the independent alarm fallback. */
internal object RecoveryPolicy {
    const val WINDOW_MS = 5 * 60_000L
    const val MIN_RESTART_GAP_MS = 5_000L
    const val MAX_ATTEMPTS = 2

    /** Check again under the runtime generation lock immediately before claiming a start. */
    fun accepts(
        wanted: Boolean,
        epoch: String?,
        deliveredEpoch: String?,
        blocked: Boolean,
        expectedGeneration: Long,
        actualGeneration: Long,
    ): Boolean = wanted && !blocked && !epoch.isNullOrBlank() &&
        (deliveredEpoch == null || deliveredEpoch == epoch) && expectedGeneration == actualGeneration

    fun claim(history: RecoveryHistory, now: Long, bootCount: Int): RecoveryDecision {
        require(now >= 0)
        val current = normalize(history, now, bootCount).copy(healthySince = null)
        // A rolling window does not give a new burst merely because a fixed
        // five-minute bucket ended just after the previous crash.
        val recent = current.attempts.filter { now - it < WINDOW_MS }
        val next = current.copy(attempts = recent)
        if (recent.size >= MAX_ATTEMPTS) return RecoveryDecision.Exhausted(next)
        val last = recent.lastOrNull()
        if (last != null && now - last < MIN_RESTART_GAP_MS) {
            return RecoveryDecision.Wait(next, MIN_RESTART_GAP_MS - (now - last))
        }
        return RecoveryDecision.Start(next.copy(attempts = recent + now))
    }

    fun healthy(history: RecoveryHistory, now: Long, bootCount: Int): RecoveryHistory {
        require(now >= 0)
        val current = normalize(history, now, bootCount)
        val since = current.healthySince ?: return current.copy(healthySince = now)
        return if (now - since >= WINDOW_MS) current.copy(attempts = emptyList()) else current
    }

    fun interrupted(history: RecoveryHistory): RecoveryHistory = history.copy(healthySince = null)

    private fun normalize(history: RecoveryHistory, now: Long, bootCount: Int): RecoveryHistory {
        val differentBoot = bootCount >= 0 && history.bootCount >= 0 && bootCount != history.bootCount
        val latest = maxOf(history.attempts.maxOrNull() ?: 0, history.healthySince ?: 0)
        // BOOT_COUNT also detects a new boot whose uptime already exceeds the
        // previous saved uptime. The monotonic fallback covers unavailable counts.
        if (differentBoot || now < latest) return RecoveryHistory(bootCount = bootCount)
        return history.copy(bootCount = bootCount)
    }
}
