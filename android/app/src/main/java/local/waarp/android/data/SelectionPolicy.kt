// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

data class ProbeHealth(val latencyMs: Long? = null, val failures: Int = 0, val checkedAt: Long = 0, val lastSuccess: Long = 0) {
    val healthy get() = lastSuccess > 0 && failures == 0
    val holding get() = lastSuccess > 0 && failures < 2
    val down get() = failures >= 2
    fun measured(delayMs: Long?, time: Long) = if (delayMs != null) ProbeHealth(delayMs, 0, time, time)
        else copy(latencyMs = null, failures = (failures + 1).coerceAtMost(100), checkedAt = time)
}
data class SelectionMemory(val challenger: String? = null, val rounds: Int = 0)
data class SelectionDecision(val next: String, val memory: SelectionMemory = SelectionMemory())

object SelectionPolicy {
    const val PROBE_BUDGET = 8
    /** Active sessions win over speed; a failed path can switch only to a measured working member. */
    fun select(group: TunnelGroup, current: String, health: Map<String, ProbeHealth>, memory: SelectionMemory = SelectionMemory(),
        activeConnections: Boolean = false, measuredThisRound: Set<String> = health.keys): SelectionDecision {
        val alive = group.members.filter { health[it]?.healthy == true && it in measuredThisRound }
        val best = if (group.policy == "first") alive.firstOrNull() else alive.minByOrNull { health[it]?.latencyMs ?: Long.MAX_VALUE }
        val holding = current in group.members && health[current]?.holding == true
        if (!holding) return SelectionDecision(best ?: current)
        if (group.policy == "first" || activeConnections || best == null || best == current) return SelectionDecision(current)
        if (current !in measuredThisRound) return SelectionDecision(current, memory)
        val currentDelay = health[current]?.latencyMs ?: return SelectionDecision(current)
        val bestDelay = health[best]?.latencyMs ?: return SelectionDecision(current)
        if (currentDelay - bestDelay <= maxOf(150.0, bestDelay * 0.5)) return SelectionDecision(current)
        val rounds = if (memory.challenger == best) memory.rounds + 1 else 1
        return if (rounds >= 5) SelectionDecision(best) else SelectionDecision(current, SelectionMemory(best, rounds))
    }
    fun sample(all: List<String>, current: List<String>, cursor: Int, budget: Int = PROBE_BUDGET): Pair<List<String>, Int> {
        val required = current.distinct().filter { it in all }.take(budget / 2)
        val others = all.distinct().filter { it !in required }
        val count = minOf(budget - required.size, others.size)
        val start = if (others.isEmpty()) 0 else Math.floorMod(cursor, others.size)
        return (required + List(count) { others[(start + it) % others.size] }) to if (others.isEmpty()) 0 else (start + count) % others.size
    }
}
