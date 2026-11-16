// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import local.waarp.android.ui.CatalogSourceUi
import local.waarp.android.ui.DiagnosticLayerUi
import local.waarp.android.ui.ObservationResult
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.zip.GZIPInputStream
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.coroutines.coroutineContext

data class CatalogResult(val profiles: List<TunnelProfile>, val sources: List<CatalogSourceUi>)

/** All probes are actual network operations. TCP reachability is never promoted to tunnel health. */
class NetworkTools(context: Context) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    fun physicalNetwork(): Network? {
        val active = connectivity.activeNetwork
        fun physical(n: Network) = connectivity.getNetworkCapabilities(n)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        } == true
        return active?.takeIf(::physical) ?: connectivity.allNetworks.firstOrNull(::physical)
    }

    // Control-plane fetches must remain reachable when a saved tunnel is broken.
    // The app UID stays inside TUN for native TCP reverse NAT, so bind these
    // HTTPS sockets explicitly to the physical network instead of excluding it.
    suspend fun fetch(url: String, maxBytes: Int = MAX_IMPORT_BYTES, physical: Boolean = true): String = withContext(Dispatchers.IO) {
        val network = if (physical) physicalNetwork() ?: error("Нет физического подключения к сети") else null
        var current = URI(url)
        repeat(5) { redirect ->
            coroutineContext.ensureActive()
            require(current.scheme.equals("https", true) && current.host != null && current.rawUserInfo == null) { "Нужна HTTPS-ссылка без логина в адресе" }
            val connection = (network?.openConnection(current.toURL()) ?: current.toURL().openConnection()) as HttpsURLConnection
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000; connection.readTimeout = 12_000
            connection.setRequestProperty("User-Agent", "Waarp-Android/0.5")
            connection.setRequestProperty("Accept", if (current.host == "cloudflare-dns.com") "application/dns-json" else "text/plain, application/json, */*")
            connection.setRequestProperty("Accept-Encoding", "gzip")
            try {
                val code = connection.responseCode
                if (code in setOf(301, 302, 303, 307, 308)) {
                    require(redirect < 4) { "Слишком много перенаправлений" }
                    current = current.resolve(connection.getHeaderField("Location") ?: error("Нет адреса перенаправления"))
                } else {
                    require(code in 200..299) { "Сервер вернул HTTP $code" }
                    require(connection.contentLengthLong <= maxBytes || connection.contentLengthLong < 0) { "Ответ сервера слишком большой" }
                    val input = if (connection.contentEncoding.equals("gzip", true)) GZIPInputStream(connection.inputStream) else connection.inputStream
                    return@withContext input.use { readBounded(it, maxBytes).toString(Charsets.UTF_8) }
                }
            } finally { connection.disconnect() }
        }
        error("Не удалось загрузить HTTPS-ссылку")
    }

    suspend fun catalog(): CatalogResult = coroutineScope {
        val results = SOURCES.map { (name, url) -> async(Dispatchers.IO) {
            try {
                val raw = fetch(url, maxBytes = 8 * MAX_IMPORT_BYTES)
                coroutineContext.ensureActive()
                val parsed = if (url.contains("vpngate.net")) {
                    // CSV rows embed certificates; process one bounded row at a time.
                    raw.lineSequence().filter { it.isNotBlank() && !it.startsWith('#') && !it.startsWith('*') }.take(200).mapNotNull { row ->
                        runCatching {
                            val cols = row.split(','); require(cols.size >= 15)
                            OpenVpnImporter.parse(ProfileImporter.base64(cols[14]).toString(Charsets.UTF_8), cols[0]).copy(country = cols[6])
                        }.getOrNull()
                    }.toList()
                } else {
                    var body = raw.trim()
                    if (!body.contains("://")) body = runCatching { ProfileImporter.base64(body).toString(Charsets.UTF_8) }.getOrDefault(body)
                    Regex("(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic)://[^\\s\"'<>\\\\]+", RegexOption.IGNORE_CASE)
                        .findAll(body.replace("\\/", "/")).take(700).mapNotNull { match ->
                            runCatching { ProfileImporter.link(match.value) }.getOrNull()
                        }.toList()
                }
                require(parsed.isNotEmpty()) { "Источник не содержит поддерживаемых узлов" }
                val profiles = parsed.distinctBy(ProfileImporter::identity).map { profile ->
                    val digest = ProfileImporter.identity(profile)
                    profile.copy(id = "pub-${digest.take(24)}", source = "public")
                }
                profiles to CatalogSourceUi(name, profiles.size, true)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { emptyList<TunnelProfile>() to CatalogSourceUi(name, 0, false, "Источник недоступен или формат не поддерживается") }
        } }.map { it.await() }
        CatalogResult(results.flatMap { it.first }.distinctBy(ProfileImporter::identity).take(MAX_PROFILES), results.map { it.second })
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
            addresses = network.getAllByName(uri.host).toList()
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
            network.socketFactory.createSocket().use { socket -> socket.connect(InetSocketAddress(address, port), 5000) }
            "Соединение установлено, ${(System.nanoTime() - start) / 1_000_000} мс"
        }
        observe("TLS · проверка сертификата") {
            val socket = network.socketFactory.createSocket()
            try {
                socket.connect(InetSocketAddress(address, port), 5000); socket.soTimeout = 7000
                ((SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(socket, uri.host, port, true) as SSLSocket).use { tls ->
                    tls.sslParameters = tls.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
                    tls.startHandshake(); "${tls.session.protocol}, имя и цепочка сертификата проверены"
                }
            } finally { socket.close() }
        }
        observe("HTTP · напрямую") {
            val connection = network.openConnection(uri.toURL()) as HttpsURLConnection
            connection.instanceFollowRedirects = false; connection.connectTimeout = 5000; connection.readTimeout = 7000
            connection.requestMethod = "HEAD"
            try { "Ответ HTTP ${connection.responseCode}" } finally { connection.disconnect() }
        }
        result
    }

    companion object {
        val SOURCES = listOf(
            "awesome-vpn" to "https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all",
            "mrdevmohamed" to "https://raw.githubusercontent.com/mrdevmohamed/v2ray-configs/main/All_Configs_Sub.txt",
            "Epodonios" to "https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt",
            "igareck · VLESS" to "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS.txt",
            "igareck · SS" to "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_SS%2BAll_RUS.txt",
            "VPN Gate" to "https://www.vpngate.net/api/iphone/",
        )
        fun readBounded(input: InputStream, limit: Int = MAX_IMPORT_BYTES): ByteArray {
            val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= limit) { "Файл слишком большой" }; output.write(buffer, 0, n) }
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
