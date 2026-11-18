// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

/** A use describes the evidence the user needs; it never changes a transport or routing rule. */
object ConnectionUses {
    val ids = setOf("general", "web", "interactive", "game")
    fun normalize(value: String?) = value?.takeIf { it in ids } ?: "general"
    fun label(value: String) = when (normalize(value)) {
        "web" -> "Веб и приложения"
        "interactive" -> "Звонки и общение"
        "game" -> "Игра"
        else -> "Обычное использование"
    }
    fun coverage(value: String) = when (normalize(value)) {
        "interactive" -> "Проверяется HTTPS к указанному адресу. Голос, UDP и потери пакетов ещё не проверены."
        "game" -> "Проверяется HTTPS к указанному адресу. Вход в игру, игровой UDP и потери пакетов ещё не проверены."
        else -> "Ответ HTTPS подтверждает доступ к этому адресу. Вход в аккаунт и остальные функции приложения не проверяются."
    }
}

data class HttpPathSample(val delayMs: Long?, val checkedAt: Long)
data class HttpPathAssessment(val id: String, val attempted: Int, val responded: Int,
    val noResponse: Int, val medianMs: Double?, val spreadMs: Long?) {
    val consistent get() = attempted >= ConnectionQuality.ROUNDS && responded == attempted
}

object ConnectionQuality {
    const val ROUNDS = 2
    const val CANDIDATES = 3
    const val TIMEOUT_MS = 3000
    const val TOTAL_TIMEOUT_MS = 22_000L
    const val PROOF_TTL_MS = 5 * 60_000L

    /** A skipped/cancelled native call has checkedAt=0 and is not a failed HTTP check. */
    fun assess(id: String, samples: List<HttpPathSample>): HttpPathAssessment {
        val measured = samples.filter { it.checkedAt > 0 }
        val replies = measured.mapNotNull { it.delayMs?.takeIf { delay -> delay >= 0 } }.sorted()
        val median = when {
            replies.isEmpty() -> null
            replies.size % 2 == 1 -> replies[replies.size / 2].toDouble()
            else -> replies[replies.size / 2 - 1] / 2.0 + replies[replies.size / 2] / 2.0
        }
        return HttpPathAssessment(id, measured.size, replies.size, measured.size - replies.size,
            median, if (replies.size >= 2) replies.last() - replies.first() else null)
    }

    /** No optimization from one small timing difference. Unknown current path is not a failure. */
    fun recommend(currentId: String?, paths: List<HttpPathAssessment>): String? {
        val current = paths.find { it.id == currentId } ?: return null
        if (current.attempted < ROUNDS || current.responded > 0) return null
        return paths.filter { it.id != currentId && it.consistent }.minByOrNull { it.medianMs ?: Double.MAX_VALUE }?.id
    }
}

/** Private control-plane proof. No fingerprints/configuration are projected to Compose or exported. */
data class ConnectionProofContext(val revision: Long, val intent: Long, val nativeSession: Long,
    val physicalNetwork: Long, val phase: String, val selections: String = "")

data class ConnectionProof(
    val id: String, val contextId: String, val routeId: String?, val kind: String, val match: String,
    val connectionUse: String, val target: String, val context: ConnectionProofContext,
    val createdElapsed: Long, val checkedProfiles: Map<String, String>,
) {
    override fun toString() = "ConnectionProof(id=$id, profiles=[redacted])"
    fun current(actual: ConnectionProofContext, elapsed: Long, profiles: List<TunnelProfile>): Boolean =
        elapsed >= createdElapsed && elapsed - createdElapsed <= ConnectionQuality.PROOF_TTL_MS && actual == context &&
            checkedProfiles.isNotEmpty() && checkedProfiles.all { (id, config) -> profiles.any {
                it.id == id && it.config == config && !it.revoked && !it.subscriptionMissing
            } }

    fun allows(routeId: String?, kind: String, match: String, use: String, selected: String): Boolean =
        this.routeId == routeId && this.kind == kind && this.match == match &&
            connectionUse == ConnectionUses.normalize(use) && selected in checkedProfiles
}
