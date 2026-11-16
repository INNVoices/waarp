// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

/** ON confirms a running local VPN. Internet reachability is a separate measurement. */
enum class RuntimePhase { OFF, STARTING, ON, STOPPING, ERROR }

data class RuntimeStatus(
    val phase: RuntimePhase = RuntimePhase.OFF,
    val message: String? = null,
    val startedAt: Long = 0,
    val uploadBytes: Long = 0,
    val downloadBytes: Long = 0,
    val uploadBps: Long = 0,
    val downloadBps: Long = 0,
    val memoryBytes: Long = 0,
    val connectionCount: Int = 0,
    val coreVersion: String = "1.14.4-lx.35",
    val alwaysOn: Boolean = false,
    val lockdown: Boolean = false,
    val telemetryAvailable: Boolean = false,
)

data class RuntimeOutbound(
    val tag: String,
    val type: String,
    val delayMs: Long? = null,
    val testedAt: Long = 0,
    val endpointState: String = "",
)

data class RuntimeGroup(
    val tag: String,
    val type: String,
    val selectable: Boolean,
    val selected: String,
    val members: List<RuntimeOutbound>,
)

data class RuntimeConnection(
    val id: String,
    val network: String,
    val protocol: String,
    val source: String,
    val destination: String,
    val domain: String,
    val rule: String,
    val outbound: String,
    val chain: List<String>,
    val packages: List<String>,
    val startedAt: Long,
    val closedAt: Long,
    val uploadBytes: Long,
    val downloadBytes: Long,
) {
    val active: Boolean get() = closedAt == 0L
}

data class RuntimeLog(val timestamp: Long, val level: Int, val message: String)

data class RuntimeRule(val type: String, val payload: String, val action: String, val dns: Boolean)

data class RuntimeProbeResult(val tag: String, val delayMs: Long?, val error: String?, val checkedAt: Long)

data class RuntimeDnsQuery(
    val timestamp: Long,
    val domain: String,
    val queryType: Int,
    val server: String,
    val failed: Boolean,
    val error: String,
)
