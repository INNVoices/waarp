// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

/** Keeps a stream failure which arrives while Connect is still opening subscriptions. */
internal class StreamRecoveryGate {
    @Volatile var recovering = false
        private set
    @Volatile private var failedEpoch = -1L

    @Synchronized fun begin(): Boolean {
        if (recovering) return false
        recovering = true
        return true
    }

    @Synchronized fun failed(epoch: Long): Boolean {
        failedEpoch = epoch
        return begin()
    }

    fun hasFailed(epoch: Long): Boolean = failedEpoch == epoch

    @Synchronized fun connected(epoch: Long): Boolean {
        if (hasFailed(epoch)) return false
        recovering = false
        return true
    }

    @Synchronized fun exhausted() { recovering = false }
}
