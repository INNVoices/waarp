// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import kotlinx.coroutines.Deferred
import local.waarp.android.data.ConnectionProofContext
import local.waarp.android.ui.RouteCheckRequest

/** Identity of one existing check, including its unsaved form and private runtime context. */
internal data class ConnectionCheckIdentity(
    val target: String,
    val request: RouteCheckRequest?,
    val context: ConnectionProofContext,
) {
    override fun toString() = "ConnectionCheckIdentity([redacted])"
}

/** This only joins an active owner. It schedules nothing and never reuses completed evidence. */
internal fun <T> sharedConnectionCheck(task: Deferred<T>?, running: ConnectionCheckIdentity?,
    requested: ConnectionCheckIdentity?, applying: Boolean): Deferred<T>? = task?.takeIf {
    it.isActive && !applying && running != null && requested == running
}
