// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.core.RuntimeProbeResult

/** Matches the desktop health round: one site's outage cannot alone condemn a tunnel. */
internal object HealthProbe {
    const val PRIMARY = "https://www.gstatic.com/generate_204"
    const val SECONDARY = "https://cp.cloudflare.com/generate_204"

    suspend fun run(tags: List<String>, url: String, healthCheck: Boolean, current: () -> Boolean,
        probe: suspend (List<String>, String) -> List<RuntimeProbeResult>): List<RuntimeProbeResult> {
        if (!current()) return emptyList()
        val first = probe(tags, url)
        if (!current()) return emptyList()
        // A user-requested diagnostic must measure that exact address, never a substitute.
        if (!healthCheck || url != PRIMARY) return first
        val failed = first.filter { it.delayMs == null }.map { it.tag }.filter { it in tags }.distinct()
        if (failed.isEmpty()) return first
        val retry = probe(failed, SECONDARY).associateBy { it.tag }
        if (!current()) return emptyList()
        return first.map { if (it.delayMs == null) retry[it.tag] ?: it else it }
    }
}
