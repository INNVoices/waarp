// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import java.io.Closeable
import java.io.IOException
import java.lang.reflect.Proxy
import java.net.InetAddress
import java.net.Socket
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Call
import okhttp3.CipherSuite
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.Route
import okhttp3.TlsVersion
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString.Companion.toByteString
import org.junit.Assert.*
import org.junit.Test

/** Local TLS exchanges preserve real trust/hostname checks and count actual HTTP bytes. */
class CompromisedCaGuardTest {
    @Test fun productionPolicyRejectsThePublishedCompromisedIntermediate() {
        // Public certificate from the pinned upstream regression, never a fixture private key.
        val certificate = javaClass.getResourceAsStream("/tls/emsign-compromised-intermediate.pem").use { input ->
            CertificateFactory.getInstance("X.509").generateCertificate(requireNotNull(input))
        }
        assertThrows(SSLPeerUnverifiedException::class.java) {
            CompromisedCaGuard().checkValidatedChain(listOf(certificate))
        }
    }

    @Test fun blockedKeyIsRejectedAtEveryValidatedChainPosition() {
        val fixture = Certificates()
        for (certificate in fixture.chain) {
            val guard = CompromisedCaGuard(setOf(spkiSha256(certificate)))
            assertThrows(SSLPeerUnverifiedException::class.java) {
                guard.checkValidatedChain(fixture.chain)
            }
        }
    }

    @Test fun httpsWithoutConnectionHandshakeOrCertificatesNeverProceeds() {
        val request = Request.Builder().url("https://localhost/fixture").build()
        val emptyHandshake = Handshake.get(
            TlsVersion.TLS_1_3, CipherSuite.TLS_AES_128_GCM_SHA256, emptyList(), emptyList(),
        )
        for (connection in listOf(null, connection(null), connection(emptyHandshake))) {
            val proceeds = AtomicInteger()
            assertThrows(SSLPeerUnverifiedException::class.java) {
                CompromisedCaGuard().intercept(chain(request, connection, proceeds))
            }
            assertEquals("An HTTPS request without its validated chain escaped", 0, proceeds.get())
        }
    }

    @Test fun cleartextDiagnosticsDoNotRequireATlsHandshake() {
        val request = Request.Builder().url("http://localhost/fixture").build()
        val proceeds = AtomicInteger()
        CompromisedCaGuard().intercept(chain(request, null, proceeds)).use {
            assertEquals(200, it.code)
        }
        assertEquals(1, proceeds.get())
    }

    @Test fun trustedTlsWithMatchingHostnameStillSendsTheRequest() {
        val fixture = Certificates()
        LocalTls(fixture).use { server ->
            withClient(fixture, CompromisedCaGuard()) { client ->
                assertTrue("Production HTTP/2 support must remain enabled", Protocol.HTTP_2 in client.protocols)
                client.newCall(Request.Builder().url(server.url).build()).execute().use {
                    assertEquals(200, it.code)
                    assertEquals("ok", it.body.string())
                }
            }
            server.awaitFinished()
            assertTrue("The positive fixture never received HTTP bytes", server.requestBytes.get() > 0)
        }
    }

    @Test fun blockedLeafIntermediateAndOmittedRootFailBeforeHttpRequestHeaders() {
        val fixture = Certificates()
        for (certificate in fixture.chain) {
            val observedChain = AtomicReference<List<Certificate>>()
            LocalTls(fixture, expectNoRequest = true).use { server ->
                withClient(fixture, CompromisedCaGuard(setOf(spkiSha256(certificate))), observedChain) { client ->
                    val failure = assertThrows(SSLPeerUnverifiedException::class.java) {
                        client.newCall(Request.Builder().url(server.url).build()).execute().close()
                    }
                    assertEquals("HTTPS certificate chain contains a compromised key", failure.message)
                }
                server.awaitFinished()
                // The server sends only leaf + intermediate. This root was added by the
                // real chain cleaner, so checking the raw peer list would fail this test.
                assertEquals(fixture.chain, observedChain.get())
                assertEquals("A blocked chain received HTTP request bytes", 0, server.requestBytes.get())
            }
        }
    }

    @Test fun trustedRootDoesNotBypassHostnameVerification() {
        val fixture = Certificates()
        LocalTls(fixture, expectNoRequest = true).use { server ->
            withClient(fixture, CompromisedCaGuard()) { client ->
                assertThrows(SSLPeerUnverifiedException::class.java) {
                    client.newCall(Request.Builder().url(server.url.replace("localhost", "wrong.invalid")).build())
                        .execute().close()
                }
            }
            server.awaitFinished()
            assertEquals(0, server.requestBytes.get())
        }
    }

    @Test fun untrustedRootIsRejectedByTlsEvenWithNoMatchingBlocklistEntry() {
        val fixture = Certificates()
        LocalTls(fixture, expectNoRequest = true).use { server ->
            withClient(fixture, CompromisedCaGuard(), trustFixture = false) { client ->
                assertThrows(SSLHandshakeException::class.java) {
                    client.newCall(Request.Builder().url(server.url).build()).execute().close()
                }
            }
            server.awaitFinished()
            assertEquals(0, server.requestBytes.get())
        }
    }

    @Test fun http2RejectsAnOversizedAggregateHeaderListBeforeReturningAResponse() {
        val fixture = Certificates()
        val negotiated = AtomicReference<Protocol>()
        MockWebServer().use { server ->
            server.useHttps(fixture.server.sslSocketFactory())
            server.enqueue(MockResponse.Builder().body("normal response").build())
            // Each header fits individually; their decoded aggregate exceeds 256 KiB.
            server.enqueue(MockResponse.Builder()
                .addHeader("X-First", "a".repeat(128 * 1024))
                .addHeader("X-Second", "b".repeat(128 * 1024))
                .body("must not be exposed").build())
            server.start(InetAddress.getByName("127.0.0.1"), 0)
            withClient(fixture, CompromisedCaGuard(), negotiatedProtocol = negotiated) { client ->
                client.newCall(Request.Builder().url(server.url("/control")).build()).execute().use {
                    assertEquals(Protocol.HTTP_2, it.protocol)
                    assertEquals("normal response", it.body.string())
                }
                val failure = assertThrows(IOException::class.java) {
                    client.newCall(Request.Builder().url(server.url("/oversized")).build()).execute().close()
                }
                assertTrue("Expected the actual HTTP/2 header budget failure, got $failure",
                    generateSequence(failure as Throwable?) { it.cause }
                        .any { it.message == "header byte count limit of 262144 exceeded" })
                assertEquals(Protocol.HTTP_2, negotiated.get())
            }
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun blockedValidatedRootCannotSendAnHttp2Request() {
        val fixture = Certificates()
        val negotiated = AtomicReference<Protocol>()
        MockWebServer().use { server ->
            server.useHttps(fixture.server.sslSocketFactory())
            server.enqueue(MockResponse.Builder().body("must not be requested").build())
            server.start(InetAddress.getByName("127.0.0.1"), 0)
            val guard = CompromisedCaGuard(setOf(spkiSha256(fixture.root.certificate)))
            withClient(fixture, guard, negotiatedProtocol = negotiated) { client ->
                val failure = assertThrows(SSLPeerUnverifiedException::class.java) {
                    client.newCall(Request.Builder().url(server.url("/private-request")).build()).execute().close()
                }
                assertEquals("HTTPS certificate chain contains a compromised key", failure.message)
                assertEquals(Protocol.HTTP_2, negotiated.get())
            }
            // HTTP/2 connection preface/SETTINGS may precede the guard. No request
            // HEADERS/DATA stream may follow a rejected validated certificate chain.
            assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
            assertEquals(0, server.requestCount)
        }
    }

    private class Certificates {
        val root = HeldCertificate.Builder().commonName("Waarp local test root").certificateAuthority(1).build()
        val intermediate = HeldCertificate.Builder().commonName("Waarp local test intermediate")
            .certificateAuthority(0).signedBy(root).build()
        val leaf = HeldCertificate.Builder().commonName("Waarp local TLS fixture")
            .addSubjectAlternativeName("localhost").signedBy(intermediate).build()
        val chain = listOf(leaf.certificate, intermediate.certificate, root.certificate)
        val server = HandshakeCertificates.Builder().heldCertificate(leaf, intermediate.certificate).build()
        val client = HandshakeCertificates.Builder().addTrustedCertificate(root.certificate).build()
    }

    private fun withClient(
        fixture: Certificates,
        guard: CompromisedCaGuard,
        observedChain: AtomicReference<List<Certificate>>? = null,
        trustFixture: Boolean = true,
        negotiatedProtocol: AtomicReference<Protocol>? = null,
        block: (OkHttpClient) -> Unit,
    ) {
        val builder = OkHttpClient.Builder().dns { listOf(InetAddress.getByName("127.0.0.1")) }
            .connectTimeout(1_500, TimeUnit.MILLISECONDS).readTimeout(2_500, TimeUnit.MILLISECONDS)
            .callTimeout(3, TimeUnit.SECONDS).retryOnConnectionFailure(false)
        if (trustFixture) builder.sslSocketFactory(fixture.client.sslSocketFactory(), fixture.client.trustManager)
        if (negotiatedProtocol != null) builder.eventListener(object : EventListener() {
            override fun connectionAcquired(call: Call, connection: Connection) {
                negotiatedProtocol.set(connection.protocol())
            }
        })
        if (observedChain != null) builder.addNetworkInterceptor { chain ->
            observedChain.set(chain.connection()?.handshake()?.peerCertificates)
            chain.proceed(chain.request())
        }
        val client = builder.addNetworkInterceptor(guard).build()
        try { block(client) }
        finally {
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdownNow()
            assertTrue("OkHttp worker did not stop", client.dispatcher.executorService.awaitTermination(2, TimeUnit.SECONDS))
        }
    }

    // This raw fixture negotiates HTTP/1.1. HTTP/2 connection control frames are
    // separate from request headers and are not covered by this byte counter.
    private class LocalTls(fixture: Certificates, private val expectNoRequest: Boolean = false) : Closeable {
        private val listener = fixture.server.sslContext().serverSocketFactory
            .createServerSocket(0, 1, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        private val socket = AtomicReference<SSLSocket>()
        private val finished = CountDownLatch(1)
        private val failure = AtomicReference<Throwable>()
        @Volatile private var closing = false
        val requestBytes = AtomicInteger()
        val url = "https://localhost:${listener.localPort}/fixture"
        private val worker = thread(name = "waarp-local-tls", isDaemon = true) {
            try {
                (listener.accept() as SSLSocket).use { accepted ->
                    socket.set(accepted)
                    accepted.soTimeout = 2_500
                    accepted.startHandshake()
                    val input = accepted.getInputStream()
                    val suffix = intArrayOf(13, 10, 13, 10)
                    var matched = 0
                    while (requestBytes.get() < 8_192) {
                        val next = input.read()
                        if (next < 0) return@use
                        requestBytes.incrementAndGet()
                        matched = if (next == suffix[matched]) matched + 1 else if (next == 13) 1 else 0
                        if (matched == suffix.size) {
                            accepted.getOutputStream().apply {
                                write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
                                flush()
                            }
                            return@use
                        }
                    }
                    error("Request exceeded the TLS fixture header bound")
                }
            } catch (error: Throwable) {
                // A rejected TLS peer may close during the server's handshake. Timeouts
                // and non-TLS failures still fail the fixture, never count as rejection.
                if (!closing && !(expectNoRequest && error is SSLException)) failure.set(error)
            } finally { finished.countDown() }
        }
        fun awaitFinished() {
            assertTrue("Local TLS server did not finish", finished.await(2_500, TimeUnit.MILLISECONDS))
            failure.get()?.let { throw AssertionError("Local TLS server failed", it) }
        }
        override fun close() {
            closing = true
            runCatching { listener.close() }
            runCatching { socket.get()?.close() }
            worker.interrupt()
            worker.join(2_500)
            assertFalse("Local TLS server thread leaked", worker.isAlive)
        }
    }

    private fun connection(handshake: Handshake?) = object : Connection {
        override fun handshake() = handshake
        override fun protocol() = Protocol.HTTP_1_1
        override fun route(): Route = error("The guard must not inspect a fixture route")
        override fun socket(): Socket = error("The guard must not inspect a raw fixture socket")
    }

    private fun chain(request: Request, connection: Connection?, proceeds: AtomicInteger): Interceptor.Chain =
        Proxy.newProxyInstance(Interceptor.Chain::class.java.classLoader, arrayOf(Interceptor.Chain::class.java)) { _, method, _ ->
            when (method.name) {
                "request" -> request
                "connection" -> connection
                "proceed" -> {
                    proceeds.incrementAndGet()
                    Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                        .body("ok".toResponseBody()).build()
                }
                else -> error("Unexpected guard call: ${method.name}")
            }
        } as Interceptor.Chain

    private fun spkiSha256(certificate: X509Certificate) = certificate.publicKey.encoded.toByteString().sha256().hex()
}
