package local.waarp.android.i18n

import android.content.Context
import android.content.res.Configuration
import org.json.JSONObject
import java.util.Locale

internal object Localization {
    @Volatile private var messages: Map<String, String> = emptyMap()
    private var active: String? = null
    private val supported = setOf("ru", "en", "de", "fr", "es", "pt-BR", "zh-Hans", "zh-Hant",
        "ja", "ko", "uk", "it", "pl", "tr", "ar", "hi", "id", "vi", "fa")

    fun configure(context: Context, configuration: Configuration) {
        val locales = configuration.locales
        val code = (0 until locales.size()).asSequence().map { tag(locales[it]) }.firstOrNull { it in supported } ?: "ru"
        if (active == code) return
        messages = if (code == "ru") emptyMap() else {
            val json = context.assets.open("locales/$code.json").bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
            json.keys().asSequence().associateWith { json.getString(it) }
        }
        active = code
    }

    private fun tag(locale: Locale): String = when (locale.language) {
        "pt" -> "pt-BR"
        "zh" -> if (android.icu.util.ULocale.addLikelySubtags(android.icu.util.ULocale.forLocale(locale)).script == "Hant") "zh-Hant" else "zh-Hans"
        "in" -> "id"
        else -> locale.language
    }

    fun template(id: String, fallback: String): String = messages[id] ?: fallback
}

private val placeholder = Regex("""\{arg(\d+)\}""")

internal fun localized(id: String, fallback: String, vararg args: Any?): String {
    val template = Localization.template(id, fallback)
    if (args.isEmpty()) return template
    return placeholder.replace(template) { args[it.groupValues[1].toInt() - 1].toString() }
}
