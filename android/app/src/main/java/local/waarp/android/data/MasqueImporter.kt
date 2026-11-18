// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.security.spec.ECFieldFp
import java.util.Base64

/** Exact common subset of pinned desktop/Android MASQUE schemas. No runtime config or file references. */
internal object MasqueImporter {
    private val fields = setOf("type", "tag", "server", "server_port", "profile", "vhttp", "private_key", "public_key",
        "ip", "ipv6", "uri", "mtu", "tls", "idle_timeout", "keep_alive_period", "network_list", "udp_fragment")
    private val tlsFields = setOf("enabled", "server_name", "disable_sni", "insecure", "fragment", "record_fragment", "fragment_fallback_delay")
    fun matches(raw: String) = raw.trimStart().let { it.startsWith('{') || it.startsWith('[') } && Regex("\"type\"\\s*:\\s*\"masque\"").containsMatchIn(raw)
    private fun keys(j: JSONObject, allowed: Set<String>) {
        require(j.keys().asSequence().all { it in allowed }) { localized("MasqueImporter.7f4cf2040335", "MASQUE: неподдерживаемые поля; нужен outbound без маршрутов, файлов и listener") }
    }
    private fun text(v: Any, max: Int = 4096): String {
        require(v is String && v.isNotEmpty() && v.length <= max && v.none { it.code < 32 || it.code == 127 }) { localized("MasqueImporter.84e56f575b3b", "MASQUE: некорректное текстовое поле") }
        return v
    }
    private fun integer(v: Any, min: Int, max: Int): Int {
        require(v is Number && v.toDouble() == v.toInt().toDouble() && v.toInt() in min..max) { localized("MasqueImporter.4493bbfe772d", "MASQUE: некорректный порт или MTU") }
        return v.toInt()
    }
    private fun prefix(v: Any, ipv6: Boolean): String {
        val raw = text(v, 64)
        require(raw.substringBefore('/').contains(':') == ipv6) { localized("MasqueImporter.c8d7544d5f80", "MASQUE: неверное семейство внутреннего IP-адреса") }
        return AddressRules.prefix(raw)
    }
    private fun duration(v: Any, negative: Boolean = false): String {
        val s = text(v, 16)
        if (s == "0" || negative && s == "-1s") return s
        val match = Regex("([0-9]+)(ms|s|m|h)").matchEntire(s) ?: error(localized("MasqueImporter.cb5cf88b724a", "MASQUE: некорректный интервал"))
        val factor = when (match.groupValues[2]) { "ms" -> .001; "s" -> 1.0; "m" -> 60.0; else -> 3600.0 }
        require((match.groupValues[1].toDoubleOrNull() ?: Double.POSITIVE_INFINITY) * factor <= 86400) { localized("MasqueImporter.a94e3da0714b", "MASQUE: интервал больше 24 часов") }
        return s
    }
    fun parse(raw: String, name: String, limit: Int): ImportResult {
        ProfileImporter.checkJsonDepth(raw)
        val root: Any = if (raw.trimStart().startsWith('[')) JSONArray(raw) else JSONObject(raw)
        val nodes = when {
            root is JSONArray -> root
            root is JSONObject && root.has("outbounds") -> { keys(root, setOf("outbounds")); root.getJSONArray("outbounds") }
            else -> JSONArray().put(root)
        }
        require(nodes.length() in 1..64) { localized("MasqueImporter.b6690d53bd04", "MASQUE: допустимо от 1 до 64 outbound-профилей") }
        val profiles = nodes.objects().map(::node)
        val count = limit.coerceIn(0, 64)
        val accepted = profiles.take(count)
        return ImportResult(if (accepted.size == 1 && name.isNotBlank()) listOf(accepted.single().copy(name = ProfileImporter.name(name))) else accepted,
            (profiles.size - count).coerceAtLeast(0))
    }
    private fun node(raw: JSONObject): TunnelProfile {
        keys(raw, fields)
        require(raw.opt("type") == "masque") { localized("MasqueImporter.b2fbe202fb52", "MASQUE: ожидался outbound с type: masque") }
        val host = ProfileImporter.host(text(raw.get("server"), 253))
        val port = if (raw.has("server_port")) integer(raw.get("server_port"), 1, 65535) else 443
        val profile = if (raw.has("profile")) text(raw.get("profile"), 20) else "cloudflare"
        require(profile in setOf("cloudflare", "standard")) { localized("MasqueImporter.dbc0dd0db611", "MASQUE: profile должен быть cloudflare или standard") }
        val vhttp = if (raw.has("vhttp")) text(raw.get("vhttp"), 8) else if (profile == "standard") "h3" else "auto"
        require(vhttp in setOf("auto", "h3", "h2") && (profile != "standard" || vhttp == "h3")) { localized("MasqueImporter.f40244fc8eef", "MASQUE: standard поддерживает только h3; cloudflare — auto, h3 или h2") }
        val ip = if (raw.has("ip")) prefix(raw.get("ip"), false) else null
        val ipv6 = if (raw.has("ipv6")) prefix(raw.get("ipv6"), true) else null
        require(ip != null || ipv6 != null) { localized("MasqueImporter.ee8db16d7547", "MASQUE: нужен внутренний ip или ipv6 из конфигурации") }
        require(profile != "cloudflare" || raw.has("private_key") && raw.has("public_key")) { localized("MasqueImporter.5912831f28bd", "MASQUE: нужны личный private_key и public_key сервера из регистрации WARP") }
        val out = obj("type" to "masque", "server" to host, "server_port" to port, "profile" to profile, "vhttp" to vhttp, "ip" to ip, "ipv6" to ipv6)
        listOf("private_key", "public_key").forEach { field -> if (raw.has(field)) out.put(field, MasqueKeys.validate(text(raw.get(field)), field == "private_key")) }
        if (raw.has("uri")) {
            val value = text(raw.get("uri")); val uri = URI(value)
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawFragment == null) { localized("MasqueImporter.51b343d36cb1", "MASQUE: CONNECT-IP URI должен быть HTTPS без пароля и fragment") }
            out.put("uri", value)
        } else require(profile != "standard") { localized("MasqueImporter.ad612339c393", "MASQUE: для standard нужен URI сервера CONNECT-IP") }
        out.put("mtu", if (raw.has("mtu")) integer(raw.get("mtu"), if (ipv6 != null) 1280 else 576, 9000) else 1280)
        val tls = if (raw.has("tls")) raw.getJSONObject("tls") else JSONObject()
        keys(tls, tlsFields)
        require(!tls.has("enabled") || tls.get("enabled") == true) { localized("MasqueImporter.612916f8e666", "MASQUE: TLS нельзя отключить") }
        require(!tls.has("insecure") || tls.get("insecure") == false) { localized("MasqueImporter.93679b483c07", "MASQUE: проверка сертификата или ключа сервера обязательна") }
        val safeTls = obj("enabled" to true)
        listOf("disable_sni", "fragment", "record_fragment").forEach { field -> if (tls.has(field)) {
            val value = tls.get(field); require(value is Boolean) { localized("MasqueImporter.66333728ff73", "MASQUE: TLS-флаг должен быть true или false") }
            require(field == "disable_sni" || !value || vhttp != "h3") { localized("MasqueImporter.afaa181abfca", "MASQUE: фрагментация TLS не применяется к HTTP/3") }
            safeTls.put(field, value)
        } }
        if (tls.has("server_name")) safeTls.put("server_name", ProfileImporter.host(text(tls.get("server_name"), 253)))
        if (tls.has("fragment_fallback_delay")) safeTls.put("fragment_fallback_delay", duration(tls.get("fragment_fallback_delay")))
        out.put("tls", safeTls)
        listOf("idle_timeout", "keep_alive_period").forEach { field -> if (raw.has(field)) out.put(field, duration(raw.get(field), field == "keep_alive_period")) }
        if (raw.has("udp_fragment")) { require(raw.get("udp_fragment") is Boolean); out.put("udp_fragment", raw.get("udp_fragment")) }
        if (raw.has("network_list")) {
            val value = raw.get("network_list")
            val values = if (value is String) listOf(value) else (value as? JSONArray)?.let { a -> (0 until a.length()).map { a.get(it) } }
            require(values != null && values.size in 1..2 && values.all { it in setOf("tcp", "udp") } && values.distinct().size == values.size) { localized("MasqueImporter.7fb24c494e88", "MASQUE: network_list должен содержать tcp и/или udp") }
            out.put("network_list", jsonArray(values))
        }
        return TunnelProfile(name = ProfileImporter.name(raw.optString("tag"), "MASQUE $host"),
            protocol = "MASQUE · ${if (profile == "cloudflare") "WARP" else "CONNECT-IP"} · ${vhttp.uppercase()}", host = host, port = port,
            config = out.toString(), addresses = listOfNotNull(ip, ipv6), source = "personal")
    }
}

/** SEC1 -> PKCS8 wrapping lets the platform EC provider validate the same key type the native core accepts. */
private object MasqueKeys {
    private val curves = setOf("06082a8648ce3d030107", "06052b81040022", "06052b81040023")
    private fun der(tag: Int, content: ByteArray): ByteArray = byteArrayOf(tag.toByte()) +
        (if (content.size < 128) byteArrayOf(content.size.toByte()) else if (content.size < 256) byteArrayOf(0x81.toByte(), content.size.toByte())
         else byteArrayOf(0x82.toByte(), (content.size ushr 8).toByte(), content.size.toByte())) + content
    private class Reader(private val bytes: ByteArray) {
        var at = 0
        fun read(tag: Int): ByteArray {
            require(at < bytes.size && bytes[at++].toInt() and 255 == tag)
            require(at < bytes.size)
            var length = bytes[at++].toInt() and 255
            if (length >= 128) {
                val count = length and 127; require(count in 1..2 && at + count <= bytes.size)
                length = 0; repeat(count) { length = (length shl 8) or (bytes[at++].toInt() and 255) }
                require(length >= 128 && (count == 1 || length >= 256))
            }
            require(length <= bytes.size - at)
            return bytes.copyOfRange(at, at + length).also { at += length }
        }
        fun next() = if (at < bytes.size) bytes[at].toInt() and 255 else -1
        fun done() = require(at == bytes.size)
    }
    fun validate(raw: String, private: Boolean): String {
        try {
            require(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?").matches(raw))
            val bytes = Base64.getDecoder().decode(raw); require(bytes.size in 32..4096)
            val top = Reader(bytes); val content = top.read(0x30); top.done()
            val factory = KeyFactory.getInstance("EC")
            if (private) {
                val sec1 = Reader(content); require(sec1.read(2).contentEquals(byteArrayOf(1)))
                val scalar = sec1.read(4); require(scalar.size in setOf(32, 48, 66))
                val parameters = sec1.read(0xa0)
                require(parameters.joinToString("") { "%02x".format(it) } in curves)
                if (sec1.next() == 0xa1) { val pub = Reader(sec1.read(0xa1)); val bits = pub.read(3); require(bits.size > 1 && bits[0] == 0.toByte()); pub.done() }
                sec1.done()
                val algorithm = der(0x30, byteArrayOf(6, 7, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 2, 1) + parameters)
                val pkcs8 = der(0x30, byteArrayOf(2, 1, 0) + algorithm + der(4, bytes))
                val key = factory.generatePrivate(PKCS8EncodedKeySpec(pkcs8)) as ECPrivateKey
                require(key.s.signum() > 0 && key.s < key.params.order)
            } else {
                val spki = Reader(content); val algorithm = Reader(spki.read(0x30))
                require(algorithm.read(6).contentEquals(byteArrayOf(0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 2, 1)))
                val parameters = der(6, algorithm.read(6)); algorithm.done()
                require(parameters.joinToString("") { "%02x".format(it) } in curves)
                spki.read(3); spki.done()
                val key = factory.generatePublic(X509EncodedKeySpec(bytes)) as ECPublicKey
                val modulus = (key.params.curve.field as ECFieldFp).p
                val x = key.w.affineX; val y = key.w.affineY
                require(x.signum() >= 0 && x < modulus && y.signum() >= 0 && y < modulus)
                require(y.multiply(y).mod(modulus) == x.multiply(x).multiply(x).add(key.params.curve.a.multiply(x)).add(key.params.curve.b).mod(modulus))
            }
        } catch (_: Exception) { error(if (private) localized("MasqueImporter.c71c95fa3242", "MASQUE: некорректный приватный EC-ключ (SEC1)") else localized("MasqueImporter.0fe4bcfe1b37", "MASQUE: некорректный публичный EC-ключ (SPKI)")) }
        return raw
    }
}
