// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.json.JSONObject

/** A candidate is an immutable copy. The caller owns network freshness, measurement, apply and rollback. */
data class ProfileTuneVariant(val id: String, val label: String, val detail: String, val profile: TunnelProfile)

object ProfileTuning {
    const val ORIGINAL = "original"
    const val RESULT_TTL_MS = 5 * 60_000L
    const val MAX_VARIANTS = 6
    fun signature(profile: TunnelProfile): String = ProfileImporter.identity(profile)

    fun variants(profile: TunnelProfile): List<ProfileTuneVariant> {
        if (profile.revoked || profile.subscriptionMissing || profile.source in setOf("public", "managed")) return emptyList()
        val original = JSONObject(profile.config)
        val type = original.optString("type")
        val result = mutableListOf(ProfileTuneVariant(ORIGINAL, "Исходная конфигурация", "Контрольная проверка без изменений", profile))
        fun candidate(id: String, label: String, detail: String, mutate: (JSONObject) -> Unit) {
            val node = JSONObject(profile.config); mutate(node)
            val copy = profile.copy(config = node.toString(), protocol = if (type == "masque")
                "MASQUE · ${if (node.optString("profile", "cloudflare") == "cloudflare") "WARP" else "CONNECT-IP"} · ${node.optString("vhttp").uppercase()}" else profile.protocol)
            if (signature(copy) != signature(profile) && result.size < MAX_VARIANTS) result += ProfileTuneVariant(id, label, detail, copy)
        }
        val tls = original.optJSONObject("tls")
        if (type in setOf("vless", "trojan", "vmess") && tls?.optBoolean("enabled") == true) {
            // Client-side hello only: credentials, REALITY key, SNI, transport and server stay intact.
            listOf("ios", "edge", "chrome_155").forEach { fp ->
                candidate("fp-$fp", "TLS · $fp", "Меняется только отпечаток ClientHello; проверка сервера сохраняется") { node ->
                    node.getJSONObject("tls").put("utls", obj("enabled" to true, "fingerprint" to fp))
                }
            }
            candidate("record-fragment", "Фрагментация TLS", "Разделяет записи TLS поверх TCP, без изменения параметров сервера") { node ->
                node.getJSONObject("tls").put("record_fragment", true)
            }
        } else if (type == "wireguard") {
            listOf(1280, 1360).filter { it != original.optInt("mtu", 1280) }.forEach { mtu -> candidate("mtu-$mtu", "MTU $mtu", "Размер пакетов внутри туннеля; ключи и параметры сервера сохраняются") { it.put("mtu", mtu) } }
            // Junk is client-side; magic headers, padding/signatures and keys need a server counterpart.
            if (profile.protocol.startsWith("AWG", true)) {
                candidate("junk-small", "Меньше служебных пакетов", "Jc 4, Jmin 8, Jmax 80; H, S, I и ключи не меняются") { it.put("jc", 4).put("jmin", 8).put("jmax", 80) }
            }
        } else if (type == "masque" && original.optString("profile", "cloudflare") == "cloudflare") {
            listOf("auto", "h3", "h2").forEach { mode -> candidate("vhttp-$mode", when (mode) {
                "auto" -> "WARP · автоматически"; "h3" -> "WARP · HTTP/3 (UDP)"; else -> "WARP · HTTP/2 (TCP)"
            }, "Тот же endpoint и ключи Cloudflare. ${if (mode == "auto") "HTTP/3 с резервом HTTP/2" else if (mode == "h3") "Требуется доступный UDP; фрагментация TCP не применяется" else "Требуется поддержка HTTP/2 на endpoint"}") { node ->
                node.put("vhttp", mode)
                if (mode == "h3") node.optJSONObject("tls")?.apply { remove("fragment"); remove("record_fragment"); remove("fragment_fallback_delay") }
            } }
        }
        return result.takeIf { it.size > 1 } ?: emptyList()
    }

    fun apply(profile: TunnelProfile, variantId: String): TunnelProfile =
        variants(profile).firstOrNull { it.id == variantId }?.profile ?: error("Вариант не подходит этому профилю")

    /** Local technical view is an allowlist: no URI, custom headers, private key or arbitrary JSON. */
    fun technical(profile: TunnelProfile): List<Pair<String, String>> = runCatching {
        val j = JSONObject(profile.config)
        buildList {
            fun field(label: String, value: String?) { value?.takeIf { it.isNotBlank() }?.let { add(label to it.take(240)) } }
            val tls = j.optJSONObject("tls")
            field("Транспорт", j.optJSONObject("transport")?.optString("type"))
            field("TLS fingerprint", tls?.optJSONObject("utls")?.optString("fingerprint"))
            if (tls?.optBoolean("record_fragment") == true) field("Фрагментация TLS", "Включена")
            if (j.has("mtu")) field("MTU", j.get("mtu").toString())
            if (j.has("server_ports")) field("Порты сервера", j.stringList("server_ports").joinToString(", "))
            if (j.optString("type") == "masque") {
                field("HTTP", j.optString("vhttp").uppercase())
                field("Проверка сервера", if (j.optString("profile", "cloudflare") == "cloudflare") "Закреплённый публичный ключ Cloudflare" else "Сертификат TLS")
            }
        }
    }.getOrDefault(emptyList())
}
