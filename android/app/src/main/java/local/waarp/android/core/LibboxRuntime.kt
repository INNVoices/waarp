// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import local.waarp.android.i18n.localized

import android.content.Context
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.SetupOptions
import local.waarp.android.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

internal object LibboxRuntime {
    @Volatile private var ready = false
    @Volatile private var baseDirectory: File? = null

    @Synchronized fun initialize(context: Context) {
        if (ready) return
        val base = File(context.noBackupFilesDir, "libbox").apply { mkdirs() }
        baseDirectory = base
        removeConfigurationSnapshot(strict = true)
        val work = File(base, "work").apply { mkdirs() }
        val temporary = File(context.cacheDir, "libbox").apply { mkdirs() }
        Libbox.setup(SetupOptions().apply {
            basePath = base.absolutePath
            workingPath = work.absolutePath
            tempPath = temporary.absolutePath
            fixAndroidStack = true
            commandServerListenPort = 0 // Private AF_UNIX socket, no localhost API exposed.
            logMaxLines = 500
            debug = false
            crashReportSource = "waarp-android"
            appVersion = BuildConfig.VERSION_NAME
            appMarketingVersion = BuildConfig.VERSION_NAME
        })
        check(Libbox.version() == BuildConfig.ENGINE_VERSION) { localized("LibboxRuntime.9d798bc191ae", "Версия VPN-ядра не совпадает с проверенной сборкой") }
        ready = true
    }

    /** The vendor writes this diagnostic copy on every StartOrReload; it is never recovery input. */
    fun removeConfigurationSnapshot(strict: Boolean = false) {
        val base = baseDirectory ?: return
        val snapshot = File(base, "configuration.json")
        val removed = runCatching { !snapshot.exists() || snapshot.delete() }.getOrDefault(false)
        if (!removed) {
            val message = localized("LibboxRuntime.ad384d48c8f0", "Не удалось удалить диагностическую копию конфигурации ядра")
            if (strict) throw IOException(message)
            RuntimeState.appendLog(3, message)
        }
    }
}

/** Secrets never enter UI diagnostics, notifications, or exported logs. */
internal object RuntimeRedaction {
    @Volatile private var secrets: List<String> = emptyList()
    private val secretKeys = setOf(
        "private_key", "pre_shared_key", "preshared_key", "password", "uuid",
        "auth", "token", "auth_key", "secret", "client_key", "private_key_password",
        "key", "authorization", "proxy-authorization", "cookie", "uri",
    )
    private val uri = Regex("(?i)(vless|vmess|ss|ssr|trojan|hysteria2?|hy2|tuic|vpn|awg|wg)://[^\\s\\\"<>]+")
    private val assignment = Regex("(?i)((?:private[_ -]?key|preshared[_ -]?key|pre_shared_key|password|secret|token)\\s*[=:]\\s*)[^\\s,;]+")

    private fun configSecrets(config: String): List<String> {
        val found = mutableSetOf<String>()
        fun remember(value: Any?) {
            when (value) {
                is String -> if (value.length >= 4) {
                    found += value
                    if (value.contains("-----BEGIN")) found += value.lines().filter { it.length > 16 }
                }
                is JSONArray -> for (index in 0 until value.length()) remember(value.opt(index))
            }
        }
        fun visit(value: Any?) {
            when (value) {
                is JSONObject -> value.keys().forEach { key ->
                    val child = value.opt(key)
                    if (key.lowercase() in secretKeys) remember(child)
                    else visit(child)
                }
                is JSONArray -> for (index in 0 until value.length()) visit(value.opt(index))
            }
        }
        runCatching { visit(JSONObject(config)) }
        return found.sortedByDescending { it.length }
    }

    fun configure(config: String) { secrets = configSecrets(config) }

    fun forConfiguration(config: String, message: String): String {
        var clean = redact(message)
        for (secret in configSecrets(config)) clean = clean.replace(secret, localized("LibboxRuntime.7f63c2ee669d", "[скрыто]"))
        return clean
    }

    fun redact(message: String): String {
        var clean = message.take(16_384)
        for (secret in secrets) clean = clean.replace(secret, localized("LibboxRuntime.f96a86798a59", "[скрыто]"))
        return assignment.replace(uri.replace(clean, localized("LibboxRuntime.e1090333288b", "[ссылка скрыта]"))) { localized("LibboxRuntime.e6ddce1324c7", "{arg1}[скрыто]", it.groupValues[1]) }
    }
}
