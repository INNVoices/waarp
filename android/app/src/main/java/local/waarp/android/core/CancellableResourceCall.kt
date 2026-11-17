// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import kotlinx.coroutines.suspendCancellableCoroutine

/** The caller runs on IO; cancellation must interrupt the resource operation, not just its result. */
internal suspend fun <T> cancellableResourceCall(cancel: () -> Unit, operation: () -> T): T =
    suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel() }
        if (continuation.isActive) {
            val result = runCatching(operation)
            if (continuation.isActive) continuation.resumeWith(result)
        }
    }
