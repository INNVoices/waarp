package local.waarp.android.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.IDN
import java.net.InetAddress
import java.util.UUID

const val DIRECT = "direct"
const val AUTO = "g-auto"
const val MAX_IMPORT_BYTES = 1_048_576
const val MAX_PROFILES = 2000

fun newId(prefix: String = ""): String = prefix + UUID.randomUUID().toString()
fun jsonArray(items: Iterable<*>): JSONArray = JSONArray().apply { items.forEach { put(jsonValue(it)) } }
private fun jsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is Iterable<*> -> jsonArray(value)
    is Map<*, *> -> JSONObject().apply { value.forEach { (k, v) -> put(k.toString(), jsonValue(v)) } }
    else -> value
}
fun obj(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().apply {
    fields.forEach { (key, value) -> if (value != null) put(key, jsonValue(value)) }
}
fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
fun JSONObject.stringList(key: String): List<String> = optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
fun JSONObject.optionalString(key: String): String? = if (has(key) && !isNull(key)) getString(key).takeIf { it.isNotBlank() } else null

/** Secrets are confined to encrypted persistence and native configuration, never screen DTOs. */
data class TunnelProfile(
    val id: String = newId(), val name: String, val protocol: String, val host: String, val port: Int,
    val config: String, val endpoint: Boolean = false,
    val addresses: List<String> = emptyList(), val dns: List<String> = emptyList(),
    val source: String = "personal", val country: String = "", val revoked: Boolean = false,
    val addedAt: Long = System.currentTimeMillis(), val subscription: String? = null,
    val subscriptionKey: String? = null, val subscriptionMissing: Boolean = false,
    val clientPublicKey: String? = null,
) {
    override fun toString(): String = "TunnelProfile(id=$id, protocol=$protocol, source=$source, credentials=[redacted])"
    fun json(): JSONObject = obj("id" to id, "name" to name, "protocol" to protocol, "host" to host, "port" to port,
        "config" to JSONObject(config), "endpoint" to endpoint, "addresses" to addresses, "dns" to dns,
        "source" to source, "country" to country, "revoked" to revoked, "addedAt" to addedAt,
        "subscription" to subscription, "subscriptionKey" to subscriptionKey, "subscriptionMissing" to subscriptionMissing,
        "clientPublicKey" to clientPublicKey)
    companion object {
        fun fromJson(j: JSONObject) = TunnelProfile(j.getString("id"), j.getString("name"), j.getString("protocol"),
            j.getString("host"), j.getInt("port"), j.getJSONObject("config").toString(), j.optBoolean("endpoint"),
            j.stringList("addresses"), j.stringList("dns"), j.optString("source", "personal"), j.optString("country"),
            j.optBoolean("revoked"), j.optLong("addedAt"), j.optionalString("subscription"), j.optionalString("subscriptionKey"),
            j.optBoolean("subscriptionMissing"), j.optionalString("clientPublicKey"))
    }
}
data class TunnelGroup(val id: String = newId("g-"), val name: String, val policy: String = "fastest", val members: List<String>) {
    fun json() = obj("id" to id, "name" to name, "policy" to policy, "members" to members)
    companion object { fun fromJson(j: JSONObject) = TunnelGroup(j.getString("id"), j.getString("name"), j.getString("policy"), j.stringList("members")) }
}
data class TrafficRoute(val id: String = newId("r-"), val name: String, val kind: String, val match: String,
    val via: String, val fallback: String? = null, val enabled: Boolean = true) {
    fun json() = obj("id" to id, "name" to name, "kind" to kind, "match" to match, "via" to via, "fallback" to fallback, "enabled" to enabled)
    companion object { fun fromJson(j: JSONObject) = TrafficRoute(j.getString("id"), j.getString("name"), j.getString("kind"),
        j.getString("match"), j.getString("via"), j.optionalString("fallback"), j.optBoolean("enabled", true)) }
}
data class AppSettings(val defaultVia: String = DIRECT, val lastWholeDeviceVia: String = AUTO,
    val lanDirect: Boolean = true, val ruDirect: Boolean = false, val autoConnect: Boolean = false,
    val notifications: Boolean = true) {
    fun json() = obj("defaultVia" to defaultVia, "lastWholeDeviceVia" to lastWholeDeviceVia, "lanDirect" to lanDirect,
        "ruDirect" to ruDirect, "autoConnect" to autoConnect, "notifications" to notifications)
    companion object { fun fromJson(j: JSONObject) = AppSettings(j.optString("defaultVia", DIRECT), j.optString("lastWholeDeviceVia", AUTO),
        j.optBoolean("lanDirect", true), j.optBoolean("ruDirect"), j.optBoolean("autoConnect"), j.optBoolean("notifications", true)) }
}
data class AppData(val profiles: List<TunnelProfile> = emptyList(), val groups: List<TunnelGroup> = emptyList(),
    val routes: List<TrafficRoute> = emptyList(), val settings: AppSettings = AppSettings(), val revision: Long = 0) {
    fun json() = obj("schema" to 1, "revision" to revision, "profiles" to profiles.map { it.json() },
        "groups" to groups.map { it.json() }, "routes" to routes.map { it.json() }, "settings" to settings.json())
    fun checked(): AppData {
        require(profiles.size <= MAX_PROFILES && routes.size <= 2000 && groups.size <= 250) { "Слишком много сохранённых записей" }
        require(profiles.map { it.id }.distinct().size == profiles.size && groups.map { it.id }.distinct().size == groups.size &&
            routes.map { it.id }.distinct().size == routes.size) { "Повторяющиеся идентификаторы" }
        require(profiles.all { it.id != DIRECT && it.id != AUTO && it.name.isNotBlank() && it.port in 1..65535 }) { "Некорректный профиль" }
        require(groups.all { it.id.startsWith("g-") && it.id != AUTO && it.policy in setOf("first", "fastest") && it.members.distinct().size == it.members.size }) { "Некорректная группа" }
        require(routes.all { it.kind in setOf("app", "preset", "custom") && it.name.isNotBlank() && it.match.isNotBlank() }) { "Некорректный маршрут" }
        return this
    }
    companion object {
        fun fromJson(j: JSONObject): AppData {
            require(j.getInt("schema") == 1) { "Неизвестная версия хранилища" }
            return AppData(j.getJSONArray("profiles").objects().map(TunnelProfile::fromJson),
                j.getJSONArray("groups").objects().map(TunnelGroup::fromJson),
                j.getJSONArray("routes").objects().map(TrafficRoute::fromJson), AppSettings.fromJson(j.getJSONObject("settings")), j.optLong("revision")).checked()
        }
    }
}

data class ServicePreset(val id: String, val name: String, val hint: String, val domains: List<String>, val cidrs: List<String> = emptyList())
object Presets {
    val all = listOf(
        ServicePreset("youtube", "YouTube", "Видео и CDN", listOf("youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "ggpht.com", "youtube-nocookie.com", "youtubei.googleapis.com")),
        ServicePreset("discord", "Discord", "Сайт, CDN и голос", listOf("discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordcdn.com", "discord.dev", "discordstatus.com")),
        ServicePreset("telegram", "Telegram", "Сайт и серверы MTProto", listOf("telegram.org", "t.me", "telegra.ph", "telesco.pe", "tdesktop.com", "telegram.me"),
            listOf("91.108.4.0/22", "91.108.8.0/22", "91.108.12.0/22", "91.108.16.0/22", "91.108.56.0/22", "149.154.160.0/20", "95.161.64.0/20")),
        ServicePreset("chatgpt", "ChatGPT", "OpenAI, Codex, Sora", listOf("openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "sora.com", "auth0.com")),
        ServicePreset("claude", "Claude", "Claude и API", listOf("anthropic.com", "claude.ai", "claude.com", "claudeusercontent.com", "clau.de")),
        ServicePreset("gemini", "Gemini", "Gemini и AI Studio", listOf("gemini.google.com", "aistudio.google.com", "generativelanguage.googleapis.com", "bard.google.com", "notebooklm.google.com", "alkalimakersuite-pa.clients6.google.com")),
        ServicePreset("meta", "Instagram", "Instagram, Facebook, Threads", listOf("instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net", "fb.com", "threads.net", "threads.com", "messenger.com")),
        ServicePreset("x", "X", "X и Grok", listOf("x.com", "twitter.com", "twimg.com", "t.co", "x.ai", "grok.com")),
        ServicePreset("spotify", "Spotify", "Музыка и подкасты", listOf("spotify.com", "scdn.co", "spotifycdn.com", "spotify.design", "pscdn.co")),
        ServicePreset("dev", "Dev", "GitHub, Docker, npm", listOf("github.com", "githubusercontent.com", "githubcopilot.com", "docker.io", "docker.com", "npmjs.org", "jetbrains.com", "cursor.sh", "cursor.com")),
    )
}

object AddressRules {
    fun isIp(value: String): Boolean {
        if (value.contains(':')) return value.matches(Regex("[0-9a-fA-F:.]+")) && runCatching { InetAddress.getByName(value) }.isSuccess
        val parts = value.split('.')
        return parts.size == 4 && parts.all { it.matches(Regex("0|[1-9][0-9]{0,2}")) && (it.toIntOrNull() ?: 256) <= 255 }
    }
    fun prefix(value: String): String {
        val raw = value.trim(); val parts = raw.split('/')
        require(parts.size <= 2 && isIp(parts[0])) { "Некорректный IP или подсеть" }
        val max = if (parts[0].contains(':')) 128 else 32
        val bits = if (parts.size == 1) max else parts[1].toIntOrNull() ?: -1
        require(bits in 0..max) { "Некорректная маска сети" }
        return "${parts[0]}/$bits"
    }
    fun selector(value: String): Pair<String, Boolean> {
        val raw = value.trim().lowercase().removePrefix("https://").removePrefix("http://").removeSuffix("/")
        if (raw.contains(':') || isIp(raw.substringBefore('/'))) return prefix(raw) to true
        require(!raw.matches(Regex("[0-9./]+"))) { "Некорректный IP или подсеть" }
        val domain = IDN.toASCII(raw.removePrefix("*.").removeSuffix("."), IDN.USE_STD3_ASCII_RULES)
        require(domain.length <= 253 && domain.contains('.') && domain.split('.').all { it.isNotEmpty() && it.length <= 63 && !it.startsWith('-') && !it.endsWith('-') }) { "Нужен домен, IP или подсеть" }
        return domain to false
    }
}
