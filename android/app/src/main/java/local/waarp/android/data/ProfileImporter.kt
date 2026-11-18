// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.IDN
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.InflaterInputStream

data class ImportResult(val profiles: List<TunnelProfile>, val skipped: Int = 0)

/** Native port of the desktop import policy. Unmapped verification/transport fields fail explicitly. */
object ProfileImporter {
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    const val DEFAULT_FINGERPRINT = "ios"
    private val fingerprints = setOf("chrome", "chrome_155", "firefox", "safari", "edge", "ios", "android", "360", "qq", "random", "randomized")
    private val links = Regex("(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic)://[^\\s\"'<>\\\\]+", RegexOption.IGNORE_CASE)
    fun name(value: String, default: String = "Сервер") = value.replace(Regex("[\\p{Cntrl}]"), " ").trim().take(80).ifEmpty { default }
    fun decode(value: String): String = URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
    fun base64(value: String): ByteArray {
        val raw = value.filterNot(Char::isWhitespace).replace('-', '+').replace('_', '/')
        require(raw.length <= MAX_IMPORT_BYTES * 2) { "Слишком большой блок base64" }
        return Base64.getDecoder().decode(raw)
    }
    fun host(value: String): String {
        val raw = value.removePrefix("[").removeSuffix("]")
        if (AddressRules.isIp(raw)) return raw
        require(!raw.contains(':') && !raw.matches(Regex("[0-9.]+"))) { "Некорректный адрес сервера" }
        val result = IDN.toASCII(raw.removeSuffix("."), IDN.USE_STD3_ASCII_RULES).lowercase()
        require(result.isNotEmpty() && result.length <= 253 && result.split('.').all {
            it.matches(Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"))
        }) { "Некорректный адрес сервера" }
        return result
    }
    fun port(value: String): Int = value.toIntOrNull()?.takeIf { it in 1..65535 } ?: error("Порт должен быть от 1 до 65535")
    fun endpoint(value: String): Pair<String, Int> {
        val match = Regex("^(?:\\[([^]]+)\\]|([^:\\s]+)):(\\d+)$").matchEntire(value.trim())
            ?: error("Endpoint должен быть host:port или [IPv6]:port")
        val h = match.groupValues[1].ifEmpty { match.groupValues[2] }
        if (match.groupValues[1].isNotEmpty()) require(h.contains(':') && AddressRules.isIp(h)) { "Некорректный IPv6" }
        return host(h) to port(match.groupValues[3])
    }
    fun isSubscription(text: String) = Regex("^https://[^\\s]+$", RegexOption.IGNORE_CASE).matches(text.trim())

    fun parse(raw: String, suggestedName: String = "", limit: Int = MAX_PROFILES): ImportResult {
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_IMPORT_BYTES) { "Конфиг слишком большой: максимум 1 МБ" }
        var text = raw.trim().removePrefix("\uFEFF")
        require(text.isNotEmpty()) { "Вставьте конфиг или ссылку" }
        if (MasqueImporter.matches(text)) return MasqueImporter.parse(text, suggestedName, limit)
        if (text.startsWith("vpn://", true) || text.contains(Regex("\\[Interface]", RegexOption.IGNORE_CASE))) {
            return ImportResult(listOf(wireGuard(text, suggestedName)))
        }
        if (OpenVpnImporter.matches(text)) return ImportResult(listOf(OpenVpnImporter.parse(text, suggestedName)))
        if (text.startsWith("*vpn_servers") || text.startsWith("#HostName,IP,")) return vpnGate(text, limit)
        if (!text.contains("://")) {
            val decoded = runCatching { base64(text).toString(Charsets.UTF_8) }.getOrNull()
            if (decoded != null && decoded.contains("://")) text = decoded
        }
        val normalized = text.replace(Regex("\\\\u0026", RegexOption.IGNORE_CASE), "&").replace("\\/", "/")
        val structured = normalized.trimStart().let { it.startsWith('{') || it.startsWith('[') } ||
            Regex("^\\s*(?:[A-Za-z_][A-Za-z0-9_-]*:\\s|[-]\\s)", RegexOption.MULTILINE).containsMatchIn(normalized)
        val plainLines = if (structured) emptyList() else normalized.lineSequence().map(String::trim)
            .filter { it.isNotEmpty() && !it.startsWith('#') && !it.startsWith(';') }.toList()
        val found = if (structured) links.findAll(normalized).map { it.value }.distinct().toList()
            else plainLines.filter { links.matches(it) }.distinct()
        require(found.isNotEmpty()) { "Формат не распознан: нужен .conf, .ovpn, ключ Amnezia, ссылка или подписка" }
        val parsed = mutableListOf<TunnelProfile>()
        var skipped = if (structured) Regex("([A-Za-z][A-Za-z0-9+.-]*)://[^\\s\"'<>\\\\]+")
            .findAll(normalized).count { it.groupValues[1].lowercase() !in setOf("vless", "vmess", "trojan", "ss", "hysteria2", "hy2", "tuic", "https", "http") }
            else plainLines.count { !links.matches(it) }
        found.forEachIndexed { index, line ->
            if (index >= limit.coerceIn(0, MAX_PROFILES)) { skipped++; return@forEachIndexed }
            try { parsed.add(link(line)) } catch (error: Exception) {
                if (found.size == 1) throw error
                skipped++
            }
        }
        require(parsed.isNotEmpty()) { "Нет поддерживаемых профилей; проверьте формат и параметры защиты" }
        // A single pasted URL can be deliberately named; provider names stay intact in subscriptions.
        val result = if (parsed.size == 1 && suggestedName.isNotBlank()) listOf(parsed.single().copy(name = name(suggestedName))) else parsed
        return ImportResult(result, skipped)
    }

    fun wireGuard(raw: String, suggestedName: String = ""): TunnelProfile {
        val text = if (raw.trim().startsWith("vpn://", true)) unwrapAmnezia(raw.trim().substring(6)) else raw
        val sections = linkedMapOf<String, MutableMap<String, String>>()
        var current: MutableMap<String, String>? = null
        var section = ""
        for (source in text.lineSequence()) {
            val line = source.substringBefore('#').trim()
            if (line.isEmpty() || line.startsWith(';')) continue
            val header = Regex("\\[([A-Za-z]+)]").matchEntire(line)
            if (header != null) {
                section = header.groupValues[1].lowercase()
                require(section in setOf("interface", "peer") && section !in sections) { "Нужен один [Interface] и один [Peer]" }
                current = linkedMapOf(); sections[section] = current; continue
            }
            val pair = Regex("([A-Za-z0-9_]+)\\s*=\\s*(.*)").matchEntire(line) ?: error("Некорректная строка конфига")
            val values = current ?: error("Параметр вне секции")
            val key = pair.groupValues[1].lowercase(); val value = pair.groupValues[2].trim()
            if ((section == "interface" && key in setOf("address", "dns")) || (section == "peer" && key == "allowedips"))
                values[key] = listOfNotNull(values[key], value).joinToString(",")
            else {
                require(key !in values || values[key] == value) { "Параметр задан повторно с другим значением" }
                values[key] = value
            }
        }
        val i = sections["interface"] ?: error("Нет [Interface]")
        val p = sections["peer"] ?: error("Нет [Peer]")
        val numeric = setOf("jc", "jmin", "jmax", "s1", "s2", "s3", "s4")
        val magic = setOf("h1", "h2", "h3", "h4", "i1", "i2", "i3", "i4", "i5")
        require(i.keys.all { it in numeric + magic + setOf("privatekey", "address", "dns", "mtu", "listenport") }) { "Конфиг содержит неподдерживаемую системную директиву" }
        require(p.keys.all { it in setOf("publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive") }) { "Неподдерживаемый параметр [Peer]" }
        fun key(value: String?): String {
            require(value != null && value.matches(Regex("[A-Za-z0-9+/]{43}=")) && base64(value).size == 32) { "Нужен ключ WireGuard: 32 байта base64" }
            return value
        }
        fun list(value: String?) = value.orEmpty().split(',').map(String::trim).filter(String::isNotEmpty).distinct()
        val addresses = list(i["address"]).map(AddressRules::prefix).also { require(it.isNotEmpty()) { "Нет Address" } }
        val allowed = list(p["allowedips"]).map(AddressRules::prefix).also { require(it.isNotEmpty()) { "Нет AllowedIPs" } }
        val (server, serverPort) = endpoint(p["endpoint"] ?: error("Нет Endpoint"))
        val peer = obj("address" to server, "port" to serverPort, "public_key" to key(p["publickey"]), "allowed_ips" to allowed,
            "persistent_keepalive_interval" to p["persistentkeepalive"]?.let { if (it.equals("off", true)) 0 else unsigned(it, 65535) }?.toInt().let { it ?: 0 })
        p["presharedkey"]?.let { peer.put("pre_shared_key", key(it)) }
        val mtu = i["mtu"]?.let { unsigned(it, 9000).also { n -> require(n >= 576) { "MTU должен быть от 576 до 9000" } } } ?: 1280
        val node = obj("type" to "wireguard", "system" to false, "mtu" to mtu, "address" to addresses,
            "private_key" to key(i["privatekey"]), "peers" to listOf(peer))
        i["listenport"]?.let { node.put("listen_port", unsigned(it, 65535)) }
        numeric.forEach { field -> i[field]?.let { node.put(field, unsigned(it, if (field.startsWith('s')) 65535 else 0xffffffffL)) } }
        require(node.optLong("jmin", 0) <= node.optLong("jmax", 0)) { "Jmin больше Jmax" }
        val headers = (1..4).map { index ->
            val value = i["h$index"]
            if (value == null) return@map index.toLong() to index.toLong()
            val match = Regex("(\\d+)\\s*(?:-\\s*(\\d+))?").matchEntire(value) ?: error("H должен быть числом или диапазоном")
            val lo = unsigned(match.groupValues[1], 0xffffffffL)
            val hi = match.groupValues[2].takeIf(String::isNotEmpty)?.let { unsigned(it, 0xffffffffL) } ?: lo
            require(lo <= hi) { "Обратный диапазон H" }
            node.put("h$index", if (lo == hi) lo else "$lo-$hi")
            if (lo == 0L && hi == 0L) index.toLong() to index.toLong() else lo to hi
        }
        for (a in headers.indices) for (b in a + 1 until headers.size)
            require(headers[a].first > headers[b].second || headers[b].first > headers[a].second) { "Диапазоны H не должны пересекаться" }
        (1..5).forEach { index -> i["i$index"]?.let { value ->
            val tags = Regex("<([^<>]*)>").findAll(value).toList()
            require(tags.isNotEmpty() && value.replace(Regex("<[^<>]*>"), "").isBlank()) { "I должен содержать теги <...>" }
            tags.forEach { match ->
                val words = match.groupValues[1].trim().split(Regex("\\s+"))
                when (words[0]) {
                    "r", "rc", "rd", "dz" -> { require(words.size == 2); unsigned(words[1], 2016) }
                    "b" -> require(words.size == 2 && words[1].matches(Regex("(?:0x)?(?:[0-9a-fA-F]{2})+"))) { "Некорректные байты I" }
                    "t", "d", "ds" -> require(words.size == 1)
                    else -> error("Неподдерживаемый тег I")
                }
            }
            node.put("i$index", value)
        } }
        val awg = (numeric + magic).any(i::containsKey)
        val v2 = listOf("s3", "s4", "i1", "i2", "i3", "i4", "i5").any(i::containsKey) || headers.any { it.first != it.second }
        return TunnelProfile(name = name(suggestedName, server), protocol = if (!awg) "WireGuard" else if (v2) "AWG2" else "AWG1",
            host = server, port = serverPort, config = node.toString(), endpoint = true, addresses = addresses, dns = list(i["dns"]))
    }

    private fun unsigned(value: String, max: Long): Long = value.toLongOrNull()?.takeIf {
        value.matches(Regex("[0-9]+")) && it in 0..max
    } ?: error("Числовой параметр вне допустимого диапазона")

    private fun unwrapAmnezia(encoded: String): String {
        val bytes = base64(encoded)
        fun inflate(offset: Int): String = InflaterInputStream(ByteArrayInputStream(bytes, offset, bytes.size - offset)).use { input ->
            val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (true) { val n = input.read(buffer); if (n == -1) break; require(out.size() + n <= MAX_IMPORT_BYTES); out.write(buffer, 0, n) }
            out.toString("UTF-8")
        }
        val text = runCatching { inflate(4) }.getOrElse { runCatching { inflate(0) }.getOrElse { bytes.toString(Charsets.UTF_8) } }
        checkJsonDepth(text)
        fun find(value: Any?, depth: Int): String? {
            if (depth > 32) return null
            return when (value) {
                is String -> when {
                    value.trimStart().startsWith('{') -> { checkJsonDepth(value); runCatching { find(JSONObject(value), depth + 1) }.getOrNull() }
                    value.contains(Regex("\\[Interface]", RegexOption.IGNORE_CASE)) -> value
                    else -> null
                }
                is JSONObject -> value.keys().asSequence().mapNotNull { find(value.opt(it), depth + 1) }.firstOrNull()
                is JSONArray -> (0 until value.length()).firstNotNullOfOrNull { find(value.opt(it), depth + 1) }
                else -> null
            }
        }
        return find(JSONObject(text), 0) ?: error("В vpn:// нет конфига WireGuard/AmneziaWG; экспортируйте нативный .conf")
    }

    fun checkJsonDepth(text: String) {
        var depth = 0; var quoted = false; var escaped = false
        text.forEach { c ->
            if (quoted) { if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false }
            else when (c) { '"' -> quoted = true; '{', '[' -> { depth++; require(depth <= 32) { "Слишком глубокий JSON" } }; '}', ']' -> depth-- }
        }
    }
    private data class Share(val scheme: String, val credential: String, val host: String, val port: Int, val query: Map<String, String>, val name: String)
    private fun share(raw: String): Share {
        val match = Regex("^([a-z0-9]+)://([^/?#]*)@([^/?#]+)(?:/)?(?:\\?([^#]*))?(?:#(.*))?$", RegexOption.IGNORE_CASE).matchEntire(raw)
            ?: error("Некорректная ссылка подключения")
        val scheme = match.groupValues[1].lowercase()
        val authority = match.groupValues[3].removeSuffix("/")
        val ep = if (authority.startsWith('[') && authority.endsWith(']') || !authority.contains(':')) host(authority) to 443 else endpoint(authority)
        val q = linkedMapOf<String, String>()
        match.groupValues[4].split('&').filter(String::isNotEmpty).forEach {
            val key = decode(it.substringBefore('=')); val value = decode(it.substringAfter('=', "")).trim()
            require(key !in q || q[key] == value) { "Противоречащие параметры ссылки" }; q[key] = value
        }
        return Share(scheme, match.groupValues[2], ep.first, ep.second, q, name(decode(match.groupValues[5]), ep.first))
    }
    private fun tls(q: Map<String, String>, server: String, on: Boolean = true): JSONObject? {
        require(listOf("allowInsecure", "insecure").none { q[it]?.lowercase() in setOf("1", "true") }) { "Отключённая проверка TLS не поддерживается" }
        require(listOf("pinSHA256", "ech", "pqv").none { !q[it].isNullOrBlank() }) { "Параметр проверки TLS не поддерживается" }
        val fp = q["fp"]?.takeIf(String::isNotBlank)?.lowercase()
        require(fp == null || fp in fingerprints) { "Неподдерживаемый TLS fingerprint" }
        if (!on) return null
        return obj("enabled" to true, "server_name" to (q["sni"]?.takeIf(String::isNotBlank) ?: q["peer"]?.takeIf(String::isNotBlank) ?: server),
            "alpn" to q["alpn"]?.takeIf(String::isNotBlank)?.split(',')?.map(String::trim),
            "utls" to fp?.let { obj("enabled" to true, "fingerprint" to it) })
    }
    private fun transport(type: String?, q: Map<String, String>): JSONObject? {
        require(q["headerType"].isNullOrBlank() || q["headerType"] == "none") { "Неподдерживаемый transport header" }
        return when (type?.lowercase().orEmpty()) {
            "", "tcp", "raw" -> null
            "ws" -> obj("type" to "ws", "path" to (q["path"]?.ifEmpty { "/" } ?: "/"), "headers" to q["host"]?.takeIf(String::isNotBlank)?.let { obj("Host" to it) })
            "grpc" -> obj("type" to "grpc", "service_name" to (q["serviceName"] ?: q["path"] ?: ""))
            "http", "h2" -> obj("type" to "http", "path" to (q["path"] ?: "/"), "host" to q["host"]?.takeIf(String::isNotBlank)?.let(::listOf))
            "httpupgrade" -> obj("type" to "httpupgrade", "path" to (q["path"] ?: "/"), "host" to q["host"]?.takeIf(String::isNotBlank))
            "xhttp", "splithttp" -> {
                val mode = q["mode"]?.takeIf(String::isNotBlank)
                require(mode == null || mode in setOf("auto", "packet-up", "stream-up", "stream-one")) { "Неподдерживаемый режим XHTTP" }
                obj("type" to "xhttp", "mode" to mode, "path" to q["path"], "host" to q["host"]).also { result ->
                    q["extra"]?.let { raw ->
                        checkJsonDepth(raw); val extra = JSONObject(raw)
                        require(extra.keys().asSequence().all { it in setOf("headers", "xPaddingBytes", "xmux") }) { "Неподдерживаемый параметр XHTTP extra" }
                        require(!extra.has("headers") || extra.opt("headers") is JSONObject) { "headers должен быть объектом" }
                        require(!extra.has("xmux") || extra.opt("xmux") is JSONObject) { "xmux должен быть объектом" }
                        extra.optJSONObject("headers")?.let { headers ->
                            require(headers.keys().asSequence().all { headers.get(it) is String })
                            result.put("headers", headers)
                        }
                        fun range(v: Any): String? {
                            if (v is JSONObject) {
                                val from = v.getLong("from"); val to = v.getLong("to"); require(from >= 0 && to >= from)
                                return if (from == 0L && to == 0L) null else if (from == to) "$from" else "$from-$to"
                            }
                            val s = v.toString(); require(s.matches(Regex("[0-9]+(?:-[0-9]+)?")))
                            val parts = s.split('-').map(String::toLong); require(parts.size == 1 || parts[0] <= parts[1])
                            return s.takeUnless { it == "0" || it == "0-0" }
                        }
                        if (extra.has("xPaddingBytes")) range(extra.get("xPaddingBytes"))?.let { result.put("x_padding_bytes", it) }
                        extra.optJSONObject("xmux")?.let { xmux ->
                            val fields = mapOf("maxConcurrency" to "max_concurrency", "maxConnections" to "max_connections", "cMaxReuseTimes" to "c_max_reuse_times",
                                "hMaxRequestTimes" to "h_max_request_times", "hMaxReusableSecs" to "h_max_reusable_secs", "hKeepAlivePeriod" to "h_keep_alive_period")
                            require(!(xmux.has("maxConcurrency") && xmux.has("maxConnections"))) { "XHTTP задаёт два взаимоисключающих лимита" }
                            val mapped = JSONObject()
                            xmux.keys().forEach { key ->
                                val target = fields[key] ?: error("Неподдерживаемый параметр xmux")
                                if (key == "hKeepAlivePeriod") mapped.put(target, xmux.getInt(key).also { require(it >= 0) })
                                else range(xmux.get(key))?.let { mapped.put(target, it) }
                            }; result.put("xmux", mapped)
                        }
                    }
                }
            }
            else -> error("Неподдерживаемый транспорт")
        }
    }
    fun link(raw: String): TunnelProfile {
        val scheme = raw.substringBefore("://").lowercase()
        if (scheme == "vmess") {
            val text = base64(raw.substringAfter("://").substringBefore('#')).toString(Charsets.UTF_8); checkJsonDepth(text)
            val j = JSONObject(text); val server = host(j.getString("add")); val serverPort = port(j.get("port").toString())
            val id = j.getString("id"); require(uuid.matches(id)) { "Некорректный UUID VMess" }
            val q = listOf("path", "host", "sni", "fp", "alpn", "allowInsecure", "insecure", "pinSHA256", "ech").associateWith { j.optString(it) }.toMutableMap()
            q["headerType"] = j.optString("type", "none"); q["serviceName"] = j.optString("path")
            val security = j.optString("tls").lowercase(); require(security in setOf("", "none", "tls")) { "Неподдерживаемая защита VMess" }
            val cipher = j.optString("scy", "auto").ifEmpty { "auto" }
            require(cipher in setOf("auto", "none", "zero", "aes-128-gcm", "chacha20-poly1305", "aes-128-ctr"))
            val aidValue = j.opt("aid")?.toString() ?: "0"
            require(aidValue.matches(Regex("[0-9]+"))) { "VMess alterId должен быть целым числом" }
            val aid = aidValue.toIntOrNull(); require(aid != null && aid in 0..65535) { "Некорректный VMess alterId" }
            return TunnelProfile(name = name(j.optString("ps"), server), protocol = "VMess", host = server, port = serverPort,
                config = obj("type" to "vmess", "server" to server, "server_port" to serverPort, "uuid" to id, "alter_id" to aid,
                    "security" to cipher, "tls" to tls(q, server, security == "tls"), "transport" to transport(j.optString("net"), q)).toString())
        }
        if (scheme == "ss") {
            val body = raw.substringAfter("://"); val fragment = body.substringAfter('#', ""); val main = body.substringBefore('#')
            val ssQuery = main.substringAfter('?', "").split('&').filter(String::isNotEmpty)
            require(ssQuery.none { decode(it.substringBefore('=')).equals("plugin", true) }) { "Плагины Shadowsocks не поддерживаются" }
            require(ssQuery.all { decode(it.substringBefore('=')) in setOf("outline") }) { "Неподдерживаемый параметр Shadowsocks" }
            val dec = if ('@' in main) {
                val credentials = main.substringBeforeLast('@')
                (if (':' in credentials) decode(credentials) else base64(credentials).toString(Charsets.UTF_8)) + "@" + main.substringAfterLast('@').substringBefore('?').removeSuffix("/")
            } else base64(main.substringBefore('?')).toString(Charsets.UTF_8)
            val method = dec.substringBefore(':'); val password = dec.substringAfter(':').substringBeforeLast('@')
            require(':' in dec && '@' in dec && method.isNotBlank() && password.isNotEmpty()) { "Некорректный Shadowsocks" }
            val (server, serverPort) = endpoint(dec.substringAfterLast('@'))
            return TunnelProfile(name = name(decode(fragment), server), protocol = "Shadowsocks", host = server, port = serverPort,
                config = obj("type" to "shadowsocks", "server" to server, "server_port" to serverPort, "method" to method, "password" to password).toString())
        }
        val hopping = if (scheme == "hy2" || scheme == "hysteria2") Hysteria2Ports.normalize(raw) else null
        val u = share(hopping?.url ?: raw); val q = u.query
        val tlsKeys = setOf("sni", "peer", "alpn", "fp", "allowInsecure", "insecure", "pinSHA256", "ech")
        val transportKeys = setOf("type", "path", "host", "serviceName", "headerType")
        val allowedQuery = when (scheme) {
            "vless" -> tlsKeys + transportKeys + setOf("security", "pbk", "sid", "mode", "flow", "encryption", "extra", "spx", "pqv")
            "trojan" -> tlsKeys + transportKeys + setOf("security", "flow")
            "hy2", "hysteria2" -> tlsKeys + setOf("obfs", "obfs-password")
            "tuic" -> tlsKeys + setOf("congestion_control")
            else -> emptySet()
        }
        require(q.keys.all { it in allowedQuery }) { "Ссылка содержит неподдерживаемый параметр; он не будет пропущен молча" }
        require(q["extra"].isNullOrBlank() || q["type"]?.lowercase() in setOf("xhttp", "splithttp")) { "extra поддерживается только с XHTTP" }
        val node = obj("server" to u.host, "server_port" to u.port)
        val label = when (scheme) {
            "vless" -> {
                val id = decode(u.credential); require(uuid.matches(id)) { "Некорректный UUID VLESS" }
                val security = q["security"]?.lowercase() ?: "none"; require(security in setOf("none", "tls", "reality"))
                require(security == "reality" || listOf("pbk", "sid").all { q[it].isNullOrBlank() }) { "Ключи REALITY требуют security=reality" }
                require(q["spx"].isNullOrBlank() || q["spx"] == "/") { "Неподдерживаемый REALITY spider path" }
                val flow = q["flow"]?.takeIf(String::isNotBlank); require(flow == null || flow == "xtls-rprx-vision") { "Неподдерживаемый VLESS flow" }
                node.put("type", "vless").put("uuid", id)
                flow?.let { node.put("flow", it) }
                q["encryption"]?.takeUnless { it == "none" || it.isBlank() }?.let { node.put("encryption", it) }
                // Default uTLS hello must fit one TCP segment: the pinned core's firefox/chrome/safari
                // hellos carry a post-quantum key share (~1.5-1.9 KB, two segments) and a Russian mobile
                // operator drops the second segment, so REALITY stalls. ios is a 517-byte hello.
                tls(q + ("fp" to (q["fp"]?.takeIf(String::isNotBlank) ?: DEFAULT_FINGERPRINT)), u.host, security != "none")?.let { t ->
                    if (security == "reality") {
                        val pk = q["pbk"].orEmpty(); val sid = q["sid"].orEmpty()
                        require(pk.matches(Regex("[A-Za-z0-9_-]{43}")) && sid.matches(Regex("(?:[0-9a-fA-F]{2}){0,8}")) && !q["sni"].isNullOrBlank()) { "Неполные параметры REALITY" }
                        t.put("reality", obj("enabled" to true, "public_key" to pk, "short_id" to sid))
                    }; node.put("tls", t)
                }
                transport(q["type"], q)?.let { node.put("transport", it) }; "VLESS"
            }
            "trojan" -> {
                require(u.credential.isNotBlank() && ':' !in u.credential) { "Пароль Trojan должен быть percent-encoded" }
                require(q["security"].isNullOrBlank() || q["security"].equals("tls", true)); require(q["flow"].isNullOrBlank())
                node.put("type", "trojan").put("password", decode(u.credential)).put("tls", tls(q, u.host))
                transport(q["type"], q)?.let { node.put("transport", it) }; "Trojan"
            }
            "hy2", "hysteria2" -> {
                require(u.credential.isNotEmpty()); node.put("type", "hysteria2").put("password", decode(u.credential)).put("tls", tls(q, u.host))
                hopping?.ports?.let { node.put("server_ports", jsonArray(it)).put("hop_interval", "30s") }
                q["obfs"]?.takeIf(String::isNotBlank)?.let {
                    require(it == "salamander" && !q["obfs-password"].isNullOrBlank()) { "Неполная обфускация Hysteria2" }
                    node.put("obfs", obj("type" to it, "password" to q["obfs-password"]))
                }; "Hysteria2"
            }
            "tuic" -> {
                val id = decode(u.credential.substringBefore(':')); val password = decode(u.credential.substringAfter(':', ""))
                require(uuid.matches(id) && password.isNotEmpty()) { "Некорректные параметры TUIC" }
                val congestion = q["congestion_control"] ?: "bbr"; require(congestion in setOf("cubic", "new_reno", "bbr"))
                node.put("type", "tuic").put("uuid", id).put("password", password).put("congestion_control", congestion)
                    .put("tls", tls(q + ("alpn" to (q["alpn"] ?: "h3")), u.host)); "TUIC"
            }
            else -> error("Неподдерживаемый протокол")
        }
        return TunnelProfile(name = u.name, protocol = label, host = u.host, port = u.port, config = node.toString())
    }
    private fun vpnGate(raw: String, limit: Int): ImportResult {
        val result = mutableListOf<TunnelProfile>(); var skipped = 0
        raw.lineSequence().filter { it.isNotBlank() && !it.startsWith('#') && !it.startsWith('*') }.forEach { line ->
            if (result.size >= limit) { skipped++; return@forEach }
            try {
                val cols = line.trim().split(','); require(cols.size >= 15)
                result.add(OpenVpnImporter.parse(base64(cols[14]).toString(Charsets.UTF_8), cols[0]).copy(country = cols[6], source = "public"))
            } catch (_: Exception) { skipped++ }
        }
        return ImportResult(result, skipped)
    }
    /** Connection identity includes DNS policy and ignores JSON object insertion order. */
    fun identity(profile: TunnelProfile): String {
        fun canonical(value: Any?): String = when (value) {
            is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") {
                JSONObject.quote(it) + ":" + canonical(value.get(it))
            }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            null, JSONObject.NULL -> "null"
            is String -> JSONObject.quote(value)
            else -> value.toString()
        }
        val config = JSONObject(profile.config).apply { remove("tag") }
        val input = canonical(obj("config" to config, "dns" to profile.dns))
        return MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
    fun credentialIdentity(profile: TunnelProfile): String {
        val j = JSONObject(profile.config)
        val tls = j.optJSONObject("tls")
        val mode = if (tls?.optBoolean("enabled") != true) "none" else if (tls.optJSONObject("reality")?.optBoolean("enabled") == true) "reality" else "tls"
        return listOf(j.optString("type"), j.optString("uuid", j.optString("password", j.optString("private_key"))),
            j.optJSONObject("transport")?.optString("type").orEmpty(), mode).joinToString("|")
    }
    fun subscriptionKey(profile: TunnelProfile): String = credentialIdentity(profile) + "|" + profile.name
}
