// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.ensureActive
import local.waarp.android.core.cancellableResourceCall
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.Executors

/** Blocking network resources are closed on cancellation without blocking the UI caller. */
internal object NetworkOperation {
    private val closers = Executors.newFixedThreadPool(2) { work ->
        Thread(work, "waarp-network-cancel").apply { isDaemon = true }
    }

    fun cancel(close: () -> Unit) { closers.execute { runCatching(close) } }

    suspend fun <T> call(close: () -> Unit, operation: () -> T): T =
        cancellableResourceCall(cancel = { cancel(close) }, operation = operation)

    // Call.cancel is sticky even before connect/enqueue. HttpURLConnection.disconnect
    // is not: on Android it can be a no-op before the lazy HTTP engine exists.
    // Consume and close the response on OkHttp's worker so cancellation never waits
    // for a blocking response body on the caller's coroutine dispatcher.
    suspend fun <T> http(call: Call, consume: (Response) -> T): T = suspendCancellableCoroutine { continuation ->
        continuation.invokeOnCancellation { cancel(call::cancel) }
        if (continuation.isActive) call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(e))
            }

            override fun onResponse(call: Call, response: Response) {
                val result = runCatching {
                    response.use {
                        continuation.context.ensureActive()
                        consume(it)
                    }
                }
                if (continuation.isActive) continuation.resumeWith(result)
            }
        })
    }

    // A read timeout alone restarts after each received byte and permits an endless trickle.
    // Translate our own deadline into an observation failure; parent/user cancellation stays cancellation.
    suspend fun <T : Any> within(timeoutMs: Long, operation: suspend () -> T): T =
        withTimeoutOrNull(timeoutMs) { operation() }
            ?: throw SocketTimeoutException("Network operation deadline exceeded")
}
