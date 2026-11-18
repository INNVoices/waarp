// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.DnsResolver
import android.net.InetAddresses
import android.net.Network
import android.net.NetworkCapabilities
import android.os.CancellationSignal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import local.waarp.android.ui.CatalogSourceUi
import local.waarp.android.ui.DiagnosticLayerUi
import local.waarp.android.ui.ObservationResult
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.net.URLEncoder
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.coroutines.coroutineContext

data class CatalogResult(val profiles: List<TunnelProfile>, val sources: List<CatalogSourceUi>)

/** All probes are actual network operations. TCP reachability is never promoted to tunnel health. */
class NetworkTools(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    // The Application creates NetworkTools on Main. Defer TLS/provider setup
    // until clientFor is called by fetch/diagnose on IO; concurrent catalog
    // fetches still share exactly one client and its connection pool.
    private val http: OkHttpClient by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
        OkHttpClient.Builder()
            .addNetworkInterceptor(CompromisedCaGuard())
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS).build()
    }
    fun physicalNetwork(): Network? {
        val active = connectivity.activeNetwork
        fun physical(n: Network) = connectivity.getNetworkCapabilities(n)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        } == true
        return active?.takeIf(::physical) ?: connectivity.allNetworks.firstOrNull(::physical)
    }

    fun vpnNetwork(): Network? = connectivity.allNetworks.firstOrNull {
        connectivity.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    }
    fun networkLabel(): String = physicalNetwork()?.let { network ->
        val capabilities = connectivity.getNetworkCapabilities(network)
        when {
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi-Fi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Мобильная сеть"
            else -> "Текущая сеть"
        }
    } ?: "Нет подключения"

    // Control-plane fetches must remain reachable when a saved tunnel is broken.
    // The app UID stays inside TUN for native TCP reverse NAT, so bind these
    // HTTPS sockets explicitly to the physical network instead of excluding it.
    suspend fun fetch(url: String, maxBytes: Int = MAX_IMPORT_BYTES, physical: Boolean = true,
        boundNetwork: Network? = null): String = fetchBound(url, maxBytes, physical, boundNetwork, null)

    /** Catalog-specific allowlist and public-address checks never broaden private subscription routing. */
    suspend fun fetchPublic(source: PublicCatalogSource, url: String, maxBytes: Int = PublicCatalog.MAX_SOURCE_BYTES,
        physical: Boolean = true, boundNetwork: Network? = null): String = fetchBound(url, maxBytes, physical, boundNetwork, source)

    private suspend fun fetchBound(url: String, maxBytes: Int, physical: Boolean,
        boundNetwork: Network?, publicSource: PublicCatalogSource?): String = withContext(Dispatchers.IO) {
        NetworkOperation.within(30_000) {
            require(maxBytes > 0)
            val network = boundNetwork ?: if (physical) physicalNetwork() ?: error("Нет физического подключения к сети") else null
            var current = URI(url)
            repeat(5) { redirect ->
                coroutineContext.ensureActive()
                require(current.scheme.equals("https", true) && current.host != null && current.rawUserInfo == null) { "Нужна HTTPS-ссылка без логина в адресе" }
                publicSource?.let { PublicSourcePolicy.requireEndpoint(it, current) }
                val client = clientFor(network, current.host, publicSource != null)
                val request = Request.Builder().url(current.toString())
                    .header("User-Agent", "Waarp-Android/0.5")
                    .header("Accept", if (current.host == "cloudflare-dns.com") "application/dns-json" else "text/plain, application/json, */*")
                    .build()
                val context = coroutineContext
                val reply = NetworkOperation.http(client.newCall(request)) { response ->
                    if (response.code in setOf(301, 302, 303, 307, 308)) {
                        require(redirect < 4) { "Слишком много перенаправлений" }
                        FetchReply.Redirect(response.header("Location") ?: error("Нет адреса перенаправления"))
                    } else {
                        require(response.isSuccessful) { "Сервер вернул HTTP ${response.code}" }
                        val body = response.body
                        require(body.contentLength() <= maxBytes || body.contentLength() < 0) { "Ответ сервера слишком большой" }
                        // OkHttp transparently decompresses gzip; bound decompressed bytes.
                        FetchReply.Body(body.byteStream().use { readBounded(it, maxBytes) { context.ensureActive() }.toString(Charsets.UTF_8) })
                    }
                }
                when (reply) {
                    is FetchReply.Redirect -> current = current.resolve(reply.location)
                    is FetchReply.Body -> return@within reply.text
                }
            }
            error("Не удалось загрузить HTTPS-ссылку")
        }
    }

    /** Only called for an explicitly supplied test endpoint and a confirmed Waarp service route. */
    suspend fun uploadCheck(url: String, vpn: Network): TransferObservation = withContext(Dispatchers.IO) {
        val uri = target(url)
        require(uri.rawQuery == null) { "Тестовый адрес отправки должен быть без параметров и секретов" }
        NetworkOperation.within(15_000) {
            val body = TransferProof.uploadPayload()
            val request = Request.Builder().url(uri.toString())
                .post(body.toRequestBody("application/octet-stream".toMediaType()))
                .header("User-Agent", "Waarp-Android/0.5").build()
            val client = clientFor(vpn, uri.host)
            val start = System.nanoTime()
            val context = coroutineContext
            NetworkOperation.http(client.newCall(request)) { response ->
                val text = response.body.byteStream().use { readBounded(it, 4096) { context.ensureActive() }.toString(Charsets.UTF_8) }
                TransferProof.uploadAcknowledged(response.code, text, body, (System.nanoTime() - start) / 1_000_000)
            }
        }
    }

    private sealed interface FetchReply {
        data class Redirect(val location: String) : FetchReply
        data class Body(val text: String) : FetchReply
    }

    private suspend fun clientFor(network: Network?, host: String, publicOnly: Boolean = false): OkHttpClient {
        // Resolve before enqueue via Android's asynchronous, cancellable resolver.
        // Every redirect gets fresh answers on this same physical network. Disable
        // implicit system proxies: control-plane/diagnostic sockets are explicitly
        // direct and must never recurse into a saved, currently broken VPN route.
        val addresses = resolve(network, host)
        if (publicOnly) PublicSourcePolicy.requirePublicAddresses(addresses)
        return http.newBuilder().proxy(Proxy.NO_PROXY).dns { requested ->
            if (!requested.equals(host, true)) throw UnknownHostException("Unexpected HTTP DNS lookup")
            addresses
        }.apply { if (network != null) socketFactory(network.socketFactory) }.build()
    }

    /** Android's asynchronous resolver supplies actual network binding and cancellable DNS. */
    private suspend fun resolve(network: Network?, host: String): List<InetAddress> = NetworkOperation.within(5_000) {
        val unbracketed = host.removeSurrounding("[", "]")
        if (InetAddresses.isNumericAddress(unbracketed)) return@within listOf(InetAddresses.parseNumericAddress(unbracketed))
        suspendCancellableCoroutine { continuation ->
            val cancellation = CancellationSignal()
            continuation.invokeOnCancellation { NetworkOperation.cancel(cancellation::cancel) }
            if (continuation.isActive) try {
                DnsResolver.getInstance().query(network, host, DnsResolver.FLAG_EMPTY, Dispatchers.IO.asExecutor(), cancellation,
                    object : DnsResolver.Callback<List<InetAddress>> {
                        override fun onAnswer(answer: List<InetAddress>, rcode: Int) {
                            if (continuation.isActive) continuation.resumeWith(
                                if (rcode == 0 && answer.isNotEmpty()) Result.success(answer)
                                else Result.failure(UnknownHostException("No usable DNS answer")))
                        }
                        override fun onError(error: DnsResolver.DnsException) {
                            if (continuation.isActive) continuation.resumeWith(Result.failure(UnknownHostException("DNS resolution failed")))
                        }
                    })
            } catch (error: Exception) {
                if (continuation.isActive) continuation.resumeWith(Result.failure(error))
            }
        }
    }

    suspend fun catalog(): CatalogResult = catalog { source, url, limit -> fetchPublic(source, url, limit) }

    /** Resolve only the small selected public sample and pin all its temporary dial endpoints before native probing. */
    suspend fun preparePublicProbe(profile: TunnelProfile): TunnelProfile = withContext(Dispatchers.IO) {
        NetworkOperation.within(8_000) {
            require(profile.source == "public")
            val physical = physicalNetwork() ?: error("Нет физического подключения к сети")
            val hosts = PublicSourcePolicy.endpointHosts(profile)
            val answers = hosts.associateWith { host -> resolve(physical, host) }
            check(physicalNetwork()?.networkHandle == physical.networkHandle) { "Сеть изменилась до проверки публичного профиля" }
            PublicSourcePolicy.pinForProbe(profile, answers)
        }
    }

    suspend fun catalog(fetcher: suspend (PublicCatalogSource, String, Int) -> String): CatalogResult = coroutineScope {
        val workers = Semaphore(3)
        val results = PublicCatalog.SOURCES.map { source -> async(Dispatchers.IO) {
            workers.withPermit {
                try {
                    val profiles = PublicCatalog.loadSource(source, fetcher)
                    profiles to CatalogSourceUi(source.name, profiles.size, true)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { emptyList<TunnelProfile>() to CatalogSourceUi(source.name, 0, false, "Источник недоступен или формат не поддерживается") }
            }
        } }.map { it.await() }
        CatalogResult(PublicCatalog.fairPool(results.map { it.first }), results.map { it.second })
    }

    fun target(raw: String): URI {
        val text = raw.trim(); require(text.isNotBlank() && text.length <= 2048) { "Укажите домен или HTTPS-адрес" }
        val uri = URI(if (text.contains("://")) text else "https://$text")
        require(uri.scheme.equals("https", true) && uri.rawUserInfo == null && uri.host != null && uri.fragment == null) { "Нужен HTTPS-адрес без логина и фрагмента" }
        ProfileImporter.host(uri.host)
        require(uri.port == -1 || uri.port in 1..65535)
        return uri
    }

    suspend fun diagnose(raw: String): List<DiagnosticLayerUi> = withContext(Dispatchers.IO) {
        val uri = target(raw); val network = physicalNetwork()
        val result = mutableListOf<DiagnosticLayerUi>()
        if (network == null) return@withContext listOf(DiagnosticLayerUi("Сеть Android", ObservationResult.FAILED, "Нет физического подключения"))
        val caps = connectivity.getNetworkCapabilities(network)
        result.add(DiagnosticLayerUi("Сеть Android", ObservationResult.OK,
            when { caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi‑Fi"; caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Мобильная сеть"; else -> "Физическая сеть" }))
        suspend fun observe(label: String, block: suspend () -> String): Boolean {
            coroutineContext.ensureActive()
            return try { result.add(DiagnosticLayerUi(label, ObservationResult.OK, block())); true }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                result.add(DiagnosticLayerUi(label, ObservationResult.FAILED, safeError(error))); false
            }
        }
        var addresses = emptyList<InetAddress>()
        observe("Системный DNS · напрямую") {
            addresses = resolve(network, uri.host)
            require(addresses.isNotEmpty()); "${addresses.size} адресов"
        }
        observe("DNS over HTTPS · Cloudflare") {
            val response = fetch("https://cloudflare-dns.com/dns-query?name=${URLEncoder.encode(uri.host, "UTF-8")}&type=A", 64 * 1024, physical = true)
            val dns = JSONObject(response); require(dns.optInt("Status", -1) == 0 && (dns.optJSONArray("Answer")?.length() ?: 0) > 0) { "DNS не вернул адрес" }
            "DNS-ответ получен через HTTPS"
        }
        val address = addresses.firstOrNull { it.address.size == 4 } ?: addresses.firstOrNull()
        if (address == null) {
            result.add(DiagnosticLayerUi("TCP / TLS / HTTP · напрямую", ObservationResult.SKIPPED, "Нет результата системного DNS"))
            return@withContext result
        }
        val port = if (uri.port == -1) 443 else uri.port
        observe("TCP · напрямую") {
            val start = System.nanoTime()
            network.socketFactory.createSocket().use { socket ->
                NetworkOperation.within(7_000) {
                    NetworkOperation.call(socket::close) { socket.connect(InetSocketAddress(address, port), 5000) }
                }
            }
            "Соединение установлено, ${(System.nanoTime() - start) / 1_000_000} мс"
        }
        observe("TLS · проверка сертификата") {
            val socket = network.socketFactory.createSocket()
            try {
                NetworkOperation.within(14_000) {
                    NetworkOperation.call(socket::close) {
                        socket.connect(InetSocketAddress(address, port), 5000); socket.soTimeout = 7000
                        ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, uri.host, port, true) as SSLSocket).use { tls ->
                            tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                            tls.startHandshake(); "${tls.session.protocol}, имя и цепочка сертификата проверены"
                        }
                    }
                }
            } finally { socket.close() }
        }
        observe("HTTP · напрямую") {
            NetworkOperation.within(12_000) {
                val client = clientFor(network, uri.host)
                val request = Request.Builder().url(uri.toString()).head().build()
                NetworkOperation.http(client.newCall(request)) { "Ответ HTTP ${it.code}" }
            }
        }
        result
    }

    companion object {
        val SOURCES: List<Pair<String, String>> = PublicCatalog.SOURCES.map { it.name to it.url }
        fun readBounded(input: InputStream, limit: Int = MAX_IMPORT_BYTES, checkActive: () -> Unit = {}): ByteArray {
            val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (true) { checkActive(); val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= limit) { "Файл слишком большой" }; output.write(buffer, 0, n) }
            return output.toByteArray()
        }
        fun safeError(error: Throwable): String = when (error) {
            is java.net.SocketTimeoutException -> "Сервер не ответил за отведённое время"
            is java.net.UnknownHostException -> "Не удалось разрешить имя сервера"
            is javax.net.ssl.SSLException -> "Не удалось подтвердить защищённое TLS-соединение"
            is java.net.ConnectException -> "Соединение не установлено"
            is SecurityException -> "Android не разрешил сетевую операцию"
            is java.io.IOException -> "Ошибка сетевого обмена"
            else -> "Проверка не завершена"
        }
    }
}
