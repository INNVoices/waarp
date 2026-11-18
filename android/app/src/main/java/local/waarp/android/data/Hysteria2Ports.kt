// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

/** Only server-supplied ports; never scan or invent an endpoint. Matches desktop hy2Ports. */
internal object Hysteria2Ports {
    data class Normalized(val url: String, val ports: List<String>? = null)
    private val authority = Regex("^([a-z0-9]+://[^@/?#]*@)(\\[[^]]+]|[^:/?#]+):([0-9,-]+)([/?#].*)?$", RegexOption.IGNORE_CASE)
    fun normalize(raw: String): Normalized {
        val match = authority.matchEntire(raw) ?: return Normalized(raw)
        val value = match.groupValues[3]
        if (value.matches(Regex("[0-9]+"))) return Normalized(raw)
        val entries = value.split(',')
        require(entries.size in 1..32) { localized("Hysteria2Ports.548972f3ec33", "Hysteria2: укажите от 1 до 32 портов или диапазонов") }
        val ports = entries.map { entry ->
            val range = Regex("([0-9]+)(?:-([0-9]+))?").matchEntire(entry) ?: error(localized("Hysteria2Ports.51dd67ad2801", "Некорректный список портов Hysteria2"))
            val from = range.groupValues[1].toIntOrNull() ?: error(localized("Hysteria2Ports.e58d9f3cb5df", "Некорректный порт Hysteria2"))
            val upper = range.groupValues[2]
            val to = if (upper.isEmpty()) from else upper.toIntOrNull() ?: error(localized("Hysteria2Ports.e58d9f3cb5df", "Некорректный порт Hysteria2"))
            require(from in 1..65535 && to in from..65535) { localized("Hysteria2Ports.8e4553d25279", "Порты Hysteria2 должны быть от 1 до 65535; диапазон не может быть обратным") }
            "$from:$to"
        }
        return Normalized(match.groupValues[1] + match.groupValues[2] + ":" + ports.first().substringBefore(':') + match.groupValues[4], ports)
    }
}
