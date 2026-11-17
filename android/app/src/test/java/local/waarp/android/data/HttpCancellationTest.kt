// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.system.measureTimeMillis

/** Real TCP exchanges exercise OkHttp's worker, socket cancellation and response ownership. */
class HttpCancellationTest {
    @Test fun parentCancellationClosesHttpSocketWhileServerStallsHeaders() = runBlocking {
        val requested = CountDownLatch(1)
        val ended = AtomicInteger(Int.MIN_VALUE)
        LocalHttp { socket ->
            readHeaders(socket)
            requested.countDown()
            ended.set(socket.getInputStream().read())
        }.use { server ->
            withClient { client ->
                val http = client.newCall(Request.Builder().url(server.url).build())
                val child = launch(Dispatchers.IO) {
                    NetworkOperation.within(2_500) { NetworkOperation.http(http) { it.body.string() } }
                    fail("The cancelled HTTP result must not escape")
                }
                assertTrue("Server never received the request", requested.await(2, TimeUnit.SECONDS))
                val elapsed = measureTimeMillis { withTimeout(1_500) { child.cancelAndJoin() } }
                assertTrue("Parent cancellation waited for the server", elapsed < 1_500)
                assertTrue(child.isCancelled)
                server.awaitFinished()
                assertTrue("Cancellation did not reach this Call", http.isCanceled())
                assertEquals("Socket must close without waiting for response headers", -1, ended.get())
            }
        }
    }

    @Test fun totalDeadlineStopsTrickleBodyEvenThoughEachReadArrivesInTime() = runBlocking {
        val chunks = AtomicInteger()
        val disconnected = CountDownLatch(1)
        LocalHttp { socket ->
            readHeaders(socket)
            val output = socket.getOutputStream()
            output.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n".toByteArray())
            output.flush()
            try {
                val until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                while (System.nanoTime() < until) {
                    output.write('x'.code)
                    output.flush()
                    chunks.incrementAndGet()
                    Thread.sleep(35)
                }
                fail("A timed-out body kept its server socket open")
            } catch (_: IOException) { disconnected.countDown() }
        }.use { server ->
            withClient(readTimeoutMs = 450) { client ->
                val http = client.newCall(Request.Builder().url(server.url).build())
                val elapsed = measureTimeMillis {
                    try {
                        NetworkOperation.within(900) { NetworkOperation.http(http) { it.body.bytes() } }
                        fail("An unfinished trickle body must reach the total deadline")
                    } catch (expected: SocketTimeoutException) {
                        assertEquals("Network operation deadline exceeded", expected.message)
                    }
                }
                assertTrue("The body did not actually stream", chunks.get() >= 3)
                assertTrue("The overall deadline did not stop the call", elapsed < 2_000)
                assertTrue("Timed-out call left its socket open", disconnected.await(2, TimeUnit.SECONDS))
                server.awaitFinished()
                assertTrue(http.isCanceled())
            }
        }
    }

    @Test fun successfulBoundedResponseClosesBodyWithoutCancellingUnrelatedCall() = runBlocking {
        val otherRequested = CountDownLatch(1)
        val releaseOther = CountDownLatch(1)
        val successfulClosed = AtomicInteger(Int.MIN_VALUE)
        LocalHttp { socket ->
            readHeaders(socket)
            respond(socket, "bounded response")
            successfulClosed.set(socket.getInputStream().read())
        }.use { first ->
            LocalHttp { socket ->
                readHeaders(socket)
                otherRequested.countDown()
                check(releaseOther.await(2, TimeUnit.SECONDS)) { "Unrelated call was never released" }
                respond(socket, "independent response")
            }.use { other ->
                withClient { client ->
                    val unrelated = client.newCall(Request.Builder().url(other.url).build())
                    val pending = async(Dispatchers.IO) {
                        NetworkOperation.within(2_500) { NetworkOperation.http(unrelated) { it.body.string() } }
                    }
                    try {
                        assertTrue(otherRequested.await(2, TimeUnit.SECONDS))
                        val call = client.newCall(Request.Builder().url(first.url).build())
                        var body: ResponseBody? = null
                        val result = NetworkOperation.within(1_500) {
                            NetworkOperation.http(call) { response ->
                                body = response.body
                                NetworkTools.readBounded(response.body.byteStream(), 32).toString(Charsets.UTF_8)
                            }
                        }
                        assertEquals("bounded response", result)
                        val receivedBody = checkNotNull(body)
                        try { receivedBody.source().request(1); fail("Response body was not closed") }
                        catch (_: IllegalStateException) { }
                        first.awaitFinished()
                        assertEquals(-1, successfulClosed.get())
                        assertFalse(call.isCanceled())
                        assertFalse("Closing one response cancelled another Call", unrelated.isCanceled())
                        assertFalse("Unrelated request unexpectedly completed", pending.isCompleted)
                        releaseOther.countDown()
                        assertEquals("independent response", withTimeout(1_500) { pending.await() })
                        assertFalse(unrelated.isCanceled())
                        other.awaitFinished()
                    } finally { releaseOther.countDown(); pending.cancelAndJoin() }
                }
            }
        }
    }

    private suspend fun withClient(readTimeoutMs: Long = 2_500, block: suspend (OkHttpClient) -> Unit) {
        val client = OkHttpClient.Builder().connectTimeout(1_500, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS).retryOnConnectionFailure(false).build()
        try { block(client) }
        finally {
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdownNow()
            assertTrue("OkHttp worker did not stop", client.dispatcher.executorService.awaitTermination(2, TimeUnit.SECONDS))
        }
    }

    private class LocalHttp(handler: (Socket) -> Unit) : Closeable {
        private val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        private val socket = AtomicReference<Socket>()
        private val finished = CountDownLatch(1)
        private val failure = AtomicReference<Throwable>()
        @Volatile private var closing = false
        val url = "http://127.0.0.1:${listener.localPort}/fixture"
        private val worker = thread(name = "waarp-local-http", isDaemon = true) {
            try {
                listener.accept().use { accepted ->
                    socket.set(accepted)
                    accepted.soTimeout = 2_500
                    handler(accepted)
                }
            } catch (error: Throwable) { if (!closing) failure.set(error) }
            finally { finished.countDown() }
        }
        fun awaitFinished() {
            assertTrue("Local HTTP server did not finish", finished.await(2_500, TimeUnit.MILLISECONDS))
            failure.get()?.let { throw AssertionError("Local HTTP server failed", it) }
        }
        override fun close() {
            closing = true
            runCatching { listener.close() }
            runCatching { socket.get()?.close() }
            worker.interrupt()
            worker.join(2_500)
            assertFalse("Local HTTP server thread leaked", worker.isAlive)
        }
    }

    companion object {
        private fun readHeaders(socket: Socket) {
            val input = socket.getInputStream()
            val suffix = intArrayOf(13, 10, 13, 10)
            var matched = 0
            repeat(8_192) {
                val next = input.read()
                check(next >= 0) { "Request ended before its headers" }
                matched = if (next == suffix[matched]) matched + 1 else if (next == 13) 1 else 0
                if (matched == suffix.size) return
            }
            error("Request headers exceeded fixture bound")
        }
        private fun respond(socket: Socket, text: String) {
            val bytes = text.toByteArray(Charsets.UTF_8)
            socket.getOutputStream().apply {
                write("HTTP/1.1 200 OK\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                write(bytes)
                flush()
            }
        }
    }
}
