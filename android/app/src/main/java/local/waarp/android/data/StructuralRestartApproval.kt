// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

/** A structural route/profile edit may recycle an active VpnService only after
 * explicit approval from a visible UI, and only while the same ON session owns it.
 * No Activity/recovery worker means denial, never silent approval. */
internal object StructuralRestartApproval {
    suspend fun allowed(required: Boolean, current: () -> Boolean,
                        request: (suspend () -> Boolean)?): Boolean {
        if (!required) return true
        if (!current()) return false
        return request?.invoke() == true && current()
    }
}
