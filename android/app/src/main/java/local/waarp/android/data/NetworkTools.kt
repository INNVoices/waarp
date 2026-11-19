// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

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
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> localized("NetworkTools.3a3e2b6cb86d", "Мобильная сеть")
            else -> localized("NetworkTools.38221c67e808", "Текущая сеть")
        }
    } ?: localized("NetworkTools.188cff2ecfb9", "Нет подключения")

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
            val network = boundNetwork ?: if (physical) physicalNetwork() ?: error(localized("NetworkTools.abbf2e0f35ff", "Нет физического подключения к сети")) else null
            var current = URI(url)
            repeat(5) { redirect ->
                coroutineContext.ensureActive()
                require(current.scheme.equals("https", true) && current.host != null && current.rawUserInfo == null) { localized("NetworkTools.f1f398273c92", "Нужна HTTPS-ссылка без логина в адресе") }
                publicSource?.let { PublicSourcePolicy.requireEndpoint(it, current) }
                val client = clientFor(network, current.host, publicSource != null)
                val request = Request.Builder().url(current.toString())
                    .header("User-Agent", "Waarp-Android/0.5")
                    .header("Accept", if (current.host == "cloudflare-dns.com") "application/dns-json" else "text/plain, application/json, */*")
                    .build()
                val context = coroutineContext
                val reply = NetworkOperation.http(client.newCall(request)) { response ->
                    if (response.code in setOf(301, 302, 303, 307, 308)) {
                        require(redirect < 4) { localized("NetworkTools.524722e66aee", "Слишком много перенаправлений") }
                        FetchReply.Redirect(response.header("Location") ?: error(localized("NetworkTools.4f7c8fc21ae1", "Нет адреса перенаправления")))
                    } else {
                        require(response.isSuccessful) { localized("NetworkTools.72a68bd886de", "Сервер вернул HTTP {arg1}", response.code) }
                        val body = response.body
                        require(body.contentLength() <= maxBytes || body.contentLength() < 0) { localized("NetworkTools.73085cac6074", "Ответ сервера слишком большой") }
                        // OkHttp transparently decompresses gzip; bound decompressed bytes.
                        FetchReply.Body(body.byteStream().use { readBounded(it, maxBytes) { context.ensureActive() }.toString(Charsets.UTF_8) })
                    }
                }
                when (reply) {
                    is FetchReply.Redirect -> current = current.resolve(reply.location)
                    is FetchReply.Body -> return@within reply.text
                }
            }
            error(localized("NetworkTools.502052b20c62", "Не удалось загрузить HTTPS-ссылку"))
        }
    }

    /** Only called for an explicitly supplied test endpoint and a confirmed Waarp service route. */
    suspend fun uploadCheck(url: String, vpn: Network): TransferObservation = withContext(Dispatchers.IO) {
        val uri = target(url)
        require(uri.rawQuery == null) { localized("NetworkTools.0cff81236dcd", "Тестовый адрес отправки должен быть без параметров и секретов") }
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
            val physical = physicalNetwork() ?: error(localized("NetworkTools.e2c96937fc02", "Нет физического подключения к сети"))
            val hosts = PublicSourcePolicy.endpointHosts(profile)
            val answers = hosts.associateWith { host -> resolve(physical, host) }
            check(physicalNetwork()?.networkHandle == physical.networkHandle) { localized("NetworkTools.9c789fd38ff7", "Сеть изменилась до проверки публичного профиля") }
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
                catch (_: Exception) { emptyList<TunnelProfile>() to CatalogSourceUi(source.name, 0, false, localized("NetworkTools.a9ee44f98080", "Источник недоступен или формат не поддерживается")) }
            }
        } }.map { it.await() }
        CatalogResult(PublicCatalog.fairPool(results.map { it.first }), results.map { it.second })
    }

    fun target(raw: String): URI {
        val text = raw.trim(); require(text.isNotBlank() && text.length <= 2048) { localized("NetworkTools.4fbf8ec0070f", "Укажите домен или HTTPS-адрес") }
        val uri = URI(if (text.contains("://")) text else "https://$text")
        require(uri.scheme.equals("https", true) && uri.rawUserInfo == null && uri.host != null && uri.fragment == null) { localized("NetworkTools.3a97b2ce96dd", "Нужен HTTPS-адрес без логина и фрагмента") }
        ProfileImporter.host(uri.host)
        require(uri.port == -1 || uri.port in 1..65535)
        return uri
    }

    suspend fun diagnose(raw: String): List<DiagnosticLayerUi> = withContext(Dispatchers.IO) {
        val uri = target(raw); val network = physicalNetwork()
        val result = mutableListOf<DiagnosticLayerUi>()
        if (network == null) return@withContext listOf(DiagnosticLayerUi(localized("NetworkTools.c6a6a6bbcca5", "Сеть Android"), ObservationResult.FAILED, localized("NetworkTools.6fd721a640b1", "Нет физического подключения")))
        val caps = connectivity.getNetworkCapabilities(network)
        result.add(DiagnosticLayerUi(localized("NetworkTools.c6a6a6bbcca5", "Сеть Android"), ObservationResult.OK,
            when { caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi‑Fi"; caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> localized("NetworkTools.1f633a429117", "Мобильная сеть"); else -> localized("NetworkTools.7caef1558a62", "Физическая сеть") }))
        suspend fun observe(label: String, block: suspend () -> String): Boolean {
            coroutineContext.ensureActive()
            return try { result.add(DiagnosticLayerUi(label, ObservationResult.OK, block())); true }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                result.add(DiagnosticLayerUi(label, ObservationResult.FAILED, safeError(error))); false
            }
        }
        var addresses = emptyList<InetAddress>()
        observe(localized("NetworkTools.ae75d624d698", "Системный DNS · напрямую")) {
            addresses = resolve(network, uri.host)
            require(addresses.isNotEmpty()); localized("NetworkTools.e624115f3e08", "{arg1} адресов", addresses.size)
        }
        observe("DNS over HTTPS · Cloudflare") {
            val response = fetch("https://cloudflare-dns.com/dns-query?name=${URLEncoder.encode(uri.host, "UTF-8")}&type=A", 64 * 1024, physical = true)
            val dns = JSONObject(response); require(dns.optInt("Status", -1) == 0 && (dns.optJSONArray("Answer")?.length() ?: 0) > 0) { localized("NetworkTools.85ae434fd62f", "DNS не вернул адрес") }
            localized("NetworkTools.676382cacc62", "DNS-ответ получен через HTTPS")
        }
        val address = addresses.firstOrNull { it.address.size == 4 } ?: addresses.firstOrNull()
        if (address == null) {
            result.add(DiagnosticLayerUi(localized("NetworkTools.1cfc5d0ee8c7", "TCP / TLS / HTTP · напрямую"), ObservationResult.SKIPPED, localized("NetworkTools.cbbaa63760e7", "Нет результата системного DNS")))
            return@withContext result
        }
        val port = if (uri.port == -1) 443 else uri.port
        observe(localized("NetworkTools.7aba0e0fe189", "TCP · напрямую")) {
            val start = System.nanoTime()
            network.socketFactory.createSocket().use { socket ->
                NetworkOperation.within(7_000) {
                    NetworkOperation.call(socket::close) { socket.connect(InetSocketAddress(address, port), 5000) }
                }
            }
            localized("NetworkTools.d6a5b09bfe89", "Соединение установлено, {arg1} мс", (System.nanoTime() - start) / 1_000_000)
        }
        observe(localized("NetworkTools.d1687e644fb5", "TLS · проверка сертификата")) {
            val socket = network.socketFactory.createSocket()
            try {
                NetworkOperation.within(14_000) {
                    NetworkOperation.call(socket::close) {
                        socket.connect(InetSocketAddress(address, port), 5000); socket.soTimeout = 7000
                        ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, uri.host, port, true) as SSLSocket).use { tls ->
                            tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                            tls.startHandshake(); localized("NetworkTools.93acfaeb52b0", "{arg1}, имя и цепочка сертификата проверены", tls.session.protocol)
                        }
                    }
                }
            } finally { socket.close() }
        }
        observe(localized("NetworkTools.1397768e420e", "HTTP · напрямую")) {
            NetworkOperation.within(12_000) {
                val client = clientFor(network, uri.host)
                val request = Request.Builder().url(uri.toString()).head().build()
                NetworkOperation.http(client.newCall(request)) { localized("NetworkTools.efb65089910e", "Ответ HTTP {arg1}", it.code) }
            }
        }
        result
    }

    companion object {
        val SOURCES: List<Pair<String, String>> = PublicCatalog.SOURCES.map { it.name to it.url }
        fun readBounded(input: InputStream, limit: Int = MAX_IMPORT_BYTES, checkActive: () -> Unit = {}): ByteArray {
            val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (true) { checkActive(); val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= limit) { localized("NetworkTools.74d937017f4b", "Файл слишком большой") }; output.write(buffer, 0, n) }
            return output.toByteArray()
        }
        fun safeError(error: Throwable): String = when (error) {
            is java.net.SocketTimeoutException -> localized("NetworkTools.ea6d13b8207c", "Сервер не ответил за отведённое время")
            is java.net.UnknownHostException -> localized("NetworkTools.0865b26e2e25", "Не удалось разрешить имя сервера")
            is javax.net.ssl.SSLException -> localized("NetworkTools.f6aca31075fd", "Не удалось подтвердить защищённое TLS-соединение")
            is java.net.ConnectException -> localized("NetworkTools.2265abd655c4", "Соединение не установлено")
            is SecurityException -> localized("NetworkTools.90bc49eeab2f", "Android не разрешил сетевую операцию")
            is java.io.IOException -> localized("NetworkTools.bc8c39883bbd", "Ошибка сетевого обмена")
            else -> localized("NetworkTools.2847f05267ab", "Проверка не завершена")
        }
    }
}
