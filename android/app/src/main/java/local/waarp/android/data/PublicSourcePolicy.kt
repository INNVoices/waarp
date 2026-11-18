// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import java.net.InetAddress
import java.net.URI
import org.json.JSONObject

/** Public catalog rules are intentionally separate from private subscription/service policy. */
object PublicSourcePolicy {
    fun sourceFor(url: String): PublicCatalogSource? = PublicCatalog.SOURCES.find { source ->
        (source.endpoints + source.redirectTargets).any { URI(it) == URI(url) }
    }

    fun requireEndpoint(source: PublicCatalogSource, uri: URI) {
        require(uri.scheme == "https" && uri.rawUserInfo == null && uri.rawFragment == null && uri.rawQuery == null &&
            uri.port == -1 && (source.endpoints + source.redirectTargets).any { URI(it) == uri }) { "Адрес не зарегистрирован для этого публичного источника" }
    }

    fun requirePublicAddresses(addresses: List<InetAddress>) {
        require(addresses.isNotEmpty() && addresses.all(::publicAddress)) { "Публичный источник указывает на непубличный сетевой адрес" }
    }

    /** All dial endpoints, including every OpenVPN remote, are checked before accepting a public candidate. */
    fun endpointHosts(profile: TunnelProfile): List<String> {
        val node = JSONObject(profile.config)
        require(node.optString("type") in setOf("vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "openvpn-client") &&
            !node.has("detour") && !node.has("bind_interface") && !node.has("inet4_bind_address") && !node.has("inet6_bind_address")) {
            "Публичный профиль содержит неподдерживаемый сетевой путь"
        }
        val hosts = node.optJSONArray("servers")?.let { servers ->
            require(node.optString("type") == "openvpn-client" && servers.length() in 1..16)
            (0 until servers.length()).map { servers.getJSONObject(it).getString("server") }
        } ?: listOf(node.getString("server"))
        require(hosts.isNotEmpty() && hosts.all(::publicHost)) { "Публичный профиль содержит непубличный адрес" }
        require(hosts.first().equals(profile.host, true)) { "Адрес публичного профиля не совпадает с конфигурацией" }
        return hosts.distinct()
    }

    fun publicProfile(profile: TunnelProfile): Boolean = runCatching { endpointHosts(profile); true }.getOrDefault(false)

    /** Pin a temporary checker copy, never the stored profile: DNS preflight alone permits a second lookup to rebind into LAN. */
    fun pinForProbe(profile: TunnelProfile, answers: Map<String, List<InetAddress>>): TunnelProfile {
        val hosts = endpointHosts(profile)
        val verified = hosts.associateWith { host ->
            val addresses = answers[host] ?: error("Нет проверенного DNS-ответа для публичного профиля")
            requirePublicAddresses(addresses)
            if (AddressRules.isIp(host)) require(addresses.all { it == InetAddress.getByName(host) })
            addresses
        }
        val node = JSONObject(profile.config)
        val domains = hosts.filterNot(AddressRules::isIp)
        if (domains.isNotEmpty()) {
            val tls = node.optJSONObject("tls")
            if (node.optString("type") == "openvpn-client") {
                // OpenVPN's optional verify-x509-name is not interchangeable with HTTPS server_name.
                require(!tls?.optString("server_name").isNullOrBlank()) { "Не удалось сохранить проверку имени OpenVPN для безопасной пробы" }
            } else if (tls?.optBoolean("enabled") == true) {
                require(!tls.optString("server_name").isNullOrBlank()) { "Не удалось сохранить TLS-имя для безопасной пробы" }
            }
            node.optJSONObject("transport")?.let { transport ->
                val explicitHost = when (transport.optString("type")) {
                    "ws" -> transport.optJSONObject("headers")?.keys()?.asSequence()?.any {
                        it.equals("Host", true) && transport.getJSONObject("headers").optString(it).isNotBlank()
                    } == true
                    "http" -> (transport.optJSONArray("host")?.length() ?: 0) > 0
                    "httpupgrade", "xhttp" -> transport.optString("host").isNotBlank()
                    // No authority override is accepted by our URI importer for gRPC. Do not guess a new default.
                    else -> false
                }
                require(explicitHost) { "Для безопасной пробы этого транспорта нужен явный Host; профиль сохранён без изменения" }
            }
        }
        fun pin(server: JSONObject, defaultNetwork: String = "") {
            val addresses = verified.getValue(server.getString("server"))
            val network = server.optString("network").ifBlank { defaultNetwork }
            val address = when {
                network.endsWith('6') -> addresses.firstOrNull { it.address.size == 16 }
                network.endsWith('4') -> addresses.firstOrNull { it.address.size == 4 }
                else -> addresses.firstOrNull { it.address.size == 4 } ?: addresses.first()
            } ?: error("Нет публичного адреса нужного семейства для проверки")
            server.put("server", address.hostAddress)
        }
        node.optJSONArray("servers")?.let { servers ->
            for (i in 0 until servers.length()) {
                pin(servers.getJSONObject(i), node.optString("network"))
            }
        } ?: pin(node)
        return profile.copy(config = node.toString())
    }

    /** Never resolve a catalog-controlled hostname just to parse it. Numeric private endpoints are rejected immediately. */
    fun publicHost(raw: String): Boolean {
        val host = raw.removeSurrounding("[", "]").lowercase().removeSuffix(".")
        if (AddressRules.isIp(host)) return publicAddress(InetAddress.getByName(host))
        return host.contains('.') && !host.contains('%') && !host.matches(Regex("[0-9.]+")) &&
            listOf("localhost", "local", "internal", "invalid", "test", "onion").none { host == it || host.endsWith(".$it") }
    }

    fun publicAddress(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.isMulticastAddress) return false
        val bytes = address.address.map { it.toInt() and 255 }
        if (bytes.size == 4) {
            val a = bytes[0]; val b = bytes[1]; val c = bytes[2]
            return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
                a == 100 && b in 64..127 || a == 169 && b == 254 || a == 172 && b in 16..31 ||
                a == 192 && (b == 168 || b == 0 && c in setOf(0, 2) || b == 88 && c == 99) ||
                a == 198 && (b in 18..19 || b == 51 && c == 100) || a == 203 && b == 0 && c == 113)
        }
        if (bytes.size != 16) return false
        // DNS64's well-known prefix is usable on IPv6-only networks, but only for a public embedded IPv4 address.
        if (bytes.take(12) == listOf(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0)) {
            return publicAddress(InetAddress.getByAddress(address.address.takeLast(4).toByteArray()))
        }
        // Global unicast only; exclude documentation, benchmarking, Teredo and 6to4 embedded-address ranges.
        if (bytes[0] !in 0x20..0x3f) return false
        return !(bytes[0] == 0x20 && bytes[1] == 0x02 ||
            bytes[0] == 0x20 && bytes[1] == 0x01 && (bytes[2] == 0 && bytes[3] in 0..0x1f || bytes[2] == 0x0d && bytes[3] == 0xb8) ||
            bytes[0] == 0x3f && bytes[1] == 0xff)
    }
}
