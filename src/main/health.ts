// C08: "engine running", "tunnel reachable" and "resource reachable" are different facts.
// Tunnel health from probe rounds: a round answers -> ok; one failed round -> degraded; two in a row -> down.
import type { TunnelHealth } from '../shared/types'

/** sing-box reports whole milliseconds: zero is a valid fast response, non-finite values are not. */
export const validLatency = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export class Health {
  private fails = new Map<string, number>()
  step(pings: Record<string, number | undefined>, ids: string[], busy: Set<string> = new Set(), members: readonly string[] = ids): Record<string, TunnelHealth> {
    const out: Record<string, TunnelHealth> = {}
    const active = new Set(members)
    // Only removal from the actual membership clears history. A bounded rotating
    // probe batch must not erase failures of a member omitted from this one round.
    for (const id of this.fails.keys()) if (!active.has(id)) this.fails.delete(id)
    for (const id of ids) {
      if (!active.has(id)) continue
      if (busy.has(id)) { out[id] = 'busy'; continue }
      const latency = pings[id]
      // NaN, negative values and infinity are not successful network probes.
      if (validLatency(latency)) {
        this.fails.set(id, 0); out[id] = 'ok'; continue
      }
      const n = (this.fails.get(id) ?? 0) + 1
      this.fails.set(id, n)
      out[id] = n >= 2 ? 'down' : 'degraded'
    }
    return out
  }
  reset(): void { this.fails.clear() }
}
