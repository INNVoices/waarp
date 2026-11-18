// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

import org.json.JSONObject

/** Inline OpenVPN files only: importing a profile never executes hooks or reads arbitrary paths. */
object OpenVpnImporter {
    private val unsafe = setOf("script-security", "up", "down", "route-up", "route-pre-down", "ipchange", "learn-address",
        "client-connect", "client-disconnect", "plugin", "management", "tls-verify", "auth-user-pass-verify", "config")
    private val inlineKeys = setOf("ca", "cert", "key", "auth-user-pass", "tls-auth", "tls-crypt", "tls-crypt-v2", "peer-fingerprint")
    fun matches(raw: String) = Regex("^\\s*(?:--)?remote\\s+", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)).containsMatchIn(raw)
    fun parse(raw: String, suggestedName: String = ""): TunnelProfile {
        require(raw.toByteArray().size <= MAX_IMPORT_BYTES && matches(raw)) { localized("OpenVpnImporter.2a0054e22bc3", "Нужен клиентский OpenVPN-конфиг с remote") }
        val inline = linkedMapOf<String, MutableList<String>>()
        val clean = Regex("<([a-z0-9-]+)>([\\s\\S]*?)</\\1>", RegexOption.IGNORE_CASE).replace(raw) { match ->
            val key = match.groupValues[1].lowercase(); require(key in inlineKeys) { localized("OpenVpnImporter.027c5b9676e8", "Неподдерживаемый вложенный блок OpenVPN") }
            val body = match.groupValues[2]
            val value = if (key == "auth-user-pass") body.replaceFirst(Regex("^\\r?\\n"), "").replace(Regex("\\r?\\n[\\t ]*$"), "") else body.trim()
            inline.getOrPut(key) { mutableListOf() }.add(value); ""
        }
        require(!Regex("</?[A-Za-z][^>]*>").containsMatchIn(clean)) { localized("OpenVpnImporter.04ef69276005", "Незавершённый или неизвестный блок OpenVPN") }
        val directives = linkedMapOf<String, MutableList<List<String>>>()
        clean.lineSequence().forEach { line ->
            val words = Regex("\"([^\"]*)\"|'([^']*)'|([^\\s]+)").findAll(line.trim()).map { match ->
                match.groups[1]?.value ?: match.groups[2]?.value ?: match.groupValues[3]
            }.takeWhile { !it.startsWith('#') && !it.startsWith(';') }.toList()
            if (words.isEmpty()) return@forEach
            val key = words[0].lowercase().removePrefix("--")
            require(key !in unsafe) { localized("OpenVpnImporter.8ff1ba1ecf3b", "OpenVPN-конфиг содержит запрещённую команду") }
            directives.getOrPut(key) { mutableListOf() }.add(words.drop(1))
        }
        fun one(key: String) = directives[key]?.lastOrNull()
        fun first(key: String) = one(key)?.firstOrNull()
        require(first("dev")?.startsWith("tap", true) != true && first("dev-type")?.lowercase() != "tap") { localized("OpenVpnImporter.298015d17dc6", "TAP не поддерживается; нужен TUN") }
        require(setOf("crl-verify", "capath", "verify-hash", "tls-ciphersuites", "x509-username-field", "http-proxy", "socks-proxy", "secret", "static-challenge").none(directives::containsKey)) {
            localized("OpenVpnImporter.64e5c4089203", "OpenVPN содержит неподдерживаемое ограничение проверки сервера или транспорт")
        }
        val external = setOf("ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2", "pkcs12", "auth-user-pass")
        external.forEach { key ->
            require(first(key) == null || first(key)?.lowercase() in setOf("[inline]", "inline")) { localized("OpenVpnImporter.990e7370848f", "Ключи и логин OpenVPN должны быть внутри .ovpn") }
            require(key !in directives || key in inline) { localized("OpenVpnImporter.9320e583762e", "Нет необходимого вложенного блока OpenVPN") }
        }
        fun protocol(value: String): String = value.lowercase().removeSuffix("-client").also {
            require(it.matches(Regex("(?:udp|tcp)[46]?"))) { localized("OpenVpnImporter.5b4e1ff21939", "Неподдерживаемый протокол OpenVPN") }
        }
        val remotes = directives["remote"] ?: error(localized("OpenVpnImporter.7da3405bfea4", "Нет remote"))
        val defaultNetwork = protocol(first("proto") ?: "udp")
        val servers = remotes.map { values ->
            require(values.isNotEmpty()) { localized("OpenVpnImporter.3854cd001841", "Нет адреса remote") }
            obj("server" to ProfileImporter.host(values[0]), "server_port" to ProfileImporter.port(values.getOrNull(1) ?: "1194"),
                "network" to values.getOrNull(2)?.let(::protocol))
        }
        val firstServer = servers.first()
        val network = if (servers.size == 1) firstServer.optString("network", defaultNetwork) else defaultNetwork
        val tls = JSONObject()
        val fingerprints = ((directives["peer-fingerprint"]?.flatten() ?: emptyList()) + inline["peer-fingerprint"].orEmpty().flatMap { it.lines() })
            .map { it.trim().replace(":", "").lowercase() }.filter(String::isNotEmpty).distinct()
        require(fingerprints.all { it.matches(Regex("[0-9a-f]{64}")) }) { localized("OpenVpnImporter.9feb4ab57109", "Нужен SHA-256 отпечаток сертификата OpenVPN") }
        require("ca" in inline || fingerprints.isNotEmpty()) { localized("OpenVpnImporter.7c46bc9ed171", "Нужен вложенный CA или отпечаток сервера") }
        if (fingerprints.isNotEmpty()) tls.put("peer_fingerprint", jsonArray(fingerprints))
        mapOf("ca" to "certificate", "cert" to "client_certificate", "key" to "client_key").forEach { (key, target) ->
            inline[key]?.let { tls.put(target, jsonArray(it)) }
        }
        require(("cert" in inline) == ("key" in inline)) { localized("OpenVpnImporter.73e488ed3b2b", "Нужны одновременно client certificate и client key") }
        one("verify-x509-name")?.let { values ->
            val type = values.getOrNull(1) ?: "subject"
            require(values.isNotEmpty() && values[0].isNotEmpty() && type in setOf("subject", "name", "name-prefix")) { localized("OpenVpnImporter.4bf6c936999a", "Некорректный verify-x509-name") }
            tls.put("server_name", values[0]).put("server_name_type", type)
        }
        first("remote-cert-tls")?.let { value ->
            require(value in setOf("client", "server")); tls.put("remote_certificate_tls", value)
        }
        if ("remote-cert-tls" in directives) require(!first("remote-cert-tls").isNullOrBlank())
        one("remote-cert-ku")?.let { values -> require(values.isNotEmpty()); tls.put("remote_certificate_ku", jsonArray(values)) }
        one("remote-cert-eku")?.let { values ->
            require(values.size == 1 && values[0].isNotEmpty() && "remote-cert-tls" !in directives)
            tls.put("remote_certificate_eku", values[0])
        }
        mapOf("ns-cert-type" to ("ns_certificate_type" to setOf("server", "client")),
            "tls-cert-profile" to ("certificate_profile" to setOf("insecure", "legacy", "preferred", "suiteb"))).forEach { (key, mapping) ->
            one(key)?.let { values -> require(values.size == 1 && values[0] in mapping.second); tls.put(mapping.first, values[0]) }
        }
        mapOf("tls-version-min" to "version_min", "tls-version-max" to "version_max", "tls-cipher" to "cipher", "tls-groups" to "groups").forEach { (key, target) ->
            one(key)?.let { values ->
                require(values.size == 1 && values[0].isNotEmpty())
                if (key.startsWith("tls-version")) require(values[0] in setOf("1.0", "1.1", "1.2", "1.3"))
                tls.put(target, values[0])
            }
        }
        val wraps = setOf("tls-auth", "tls-crypt", "tls-crypt-v2").filter(inline::containsKey)
        require(wraps.size <= 1) { localized("OpenVpnImporter.ef737323c5be", "Несколько способов защиты управляющего канала OpenVPN") }
        wraps.firstOrNull()?.let { key ->
            val direction = first("key-direction") ?: one("tls-auth")?.getOrNull(1)
            if (key == "tls-auth") require(direction == null || direction in setOf("0", "1"))
            tls.put("control_wrap", obj("type" to key.replace('-', '_'), "key" to inline[key],
                "direction" to if (key == "tls-auth" && direction != null) (if (direction == "0") "server" else "client") else null))
        }
        val node = obj("type" to "openvpn-client", "mode" to "tls", "network" to network, "tls" to tls)
        if (servers.size == 1) node.put("server", firstServer.getString("server")).put("server_port", firstServer.getInt("server_port"))
        else node.put("servers", jsonArray(servers))
        first("data-ciphers")?.let { node.put("data_ciphers", jsonArray(it.split(':').filter(String::isNotEmpty))) }
        (first("data-ciphers-fallback") ?: first("cipher"))?.let { node.put("data_ciphers_fallback", it) }
        first("auth")?.let { node.put("auth", it) }
        one("compress")?.let { node.put("compression", it.firstOrNull() ?: "stub") }
        one("comp-lzo")?.let { node.put("compression_lzo", it.firstOrNull() ?: "adaptive").put("allow_compression", "asym") }
        first("allow-compression")?.let { require(it in setOf("no", "asym", "yes")); node.put("allow_compression", it) }
        if ("allow-compression" in directives) require(first("allow-compression") in setOf("no", "asym", "yes")) { localized("OpenVpnImporter.3442feb72940", "Некорректный allow-compression") }
        mapOf("mssfix" to "mss_fix", "fragment" to "fragment", "explicit-exit-notify" to "explicit_exit_notify").forEach { (key, target) ->
            first(key)?.let { value -> val number = value.toIntOrNull(); require(number != null && number >= 0); node.put(target, number) }
        }
        mapOf("ping" to "ping_interval", "ping-restart" to "ping_restart").forEach { (key, target) ->
            first(key)?.let { require(it.matches(Regex("[0-9]+"))); node.put(target, "${it}s") }
        }
        inline["auth-user-pass"]?.let { entries ->
            val values = entries.singleOrNull()?.split(Regex("\\r?\\n"))
            require(values != null && values.size == 2 && values.all(String::isNotEmpty)) { localized("OpenVpnImporter.dbc5254f47fb", "auth-user-pass: ровно две непустые строки") }
            node.put("username", values[0]).put("password", values[1])
        }
        return TunnelProfile(name = ProfileImporter.name(suggestedName, firstServer.getString("server")), protocol = "OpenVPN",
            host = firstServer.getString("server"), port = firstServer.getInt("server_port"), config = node.toString(), endpoint = true)
    }
}
