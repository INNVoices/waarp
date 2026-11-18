// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.CompletableDeferred

/** A structural route/profile edit may recycle an active VpnService only after
 * explicit approval from a visible UI, and only while the same ON session owns it.
 * No Activity/recovery worker means denial, never silent approval. */
internal object StructuralRestartApproval {
    /** Buffered UI events must expire with the edit that requested them. */
    suspend fun awaitResponse(present: suspend (CompletableDeferred<Boolean>) -> Unit): Boolean {
        val response = CompletableDeferred<Boolean>()
        try {
            present(response)
            return response.await()
        } finally {
            // Completing with denial also dismisses an already-visible prompt.
            // A late tap or an Activity returning after timeout cannot accept it.
            response.complete(false)
        }
    }

    suspend fun allowed(required: Boolean, current: () -> Boolean,
                        request: (suspend () -> Boolean)?): Boolean {
        if (!required) return true
        if (!current()) return false
        return request?.invoke() == true && current()
    }
}
