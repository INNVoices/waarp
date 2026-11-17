// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

/** Closing one native resource may fail; every remaining owner must still release its resources. */
internal fun closeResources(vararg actions: () -> Unit) {
    var failure: Throwable? = null
    for (action in actions) {
        try { action() }
        catch (error: Throwable) {
            if (failure == null) failure = error
            else if (failure !== error) failure.addSuppressed(error)
        }
    }
    failure?.let { throw it }
}
