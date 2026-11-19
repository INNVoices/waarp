// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import local.waarp.android.i18n.localized

import java.net.URI

/** Native diagnostic API returns text; never treat its UTF-8 re-encoding as exact binary bytes. */
data class RuntimeHttpResult(val status: Int, val content: String, val truncated: Boolean,
    val contentType: String, val elapsedMs: Long)

internal fun validateHttpFetch(outbound: String, url: String, timeoutMs: Int, maxBytes: Int) {
    require(outbound.isNotBlank())
    val target = URI(url)
    require(target.scheme == "https" && !target.host.isNullOrBlank() && target.userInfo == null) { localized("RuntimeHttpResult.367742c3f7c4", "Для проверки нужен HTTPS-адрес без учётных данных") }
    require(timeoutMs in 100..60_000 && maxBytes in 1..1_048_576) { localized("RuntimeHttpResult.748b0cd5e17e", "Недопустимый лимит проверки") }
}
