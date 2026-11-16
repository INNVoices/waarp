// C08: "engine running", "tunnel reachable" and "resource reachable" are different facts.
// Tunnel health from probe rounds: a round answers -> ok; one failed round -> degraded; two in a row -> down.
import type { TunnelHealth } from '../shared/types'

export class Health {
  private fails = new Map<string, number>()
  step(pings: Record<string, number | undefined>, ids: string[], busy: Set<string> = new Set()): Record<string, TunnelHealth> {
    const out: Record<string, TunnelHealth> = {}
    const active = new Set(ids)
    // A deleted profile must not leave stale failure history behind if its ID is reused.
    for (const id of this.fails.keys()) if (!active.has(id)) this.fails.delete(id)
    for (const id of ids) {
      if (busy.has(id)) { out[id] = 'busy'; continue }
      const latency = pings[id]
      // NaN, negative values and infinity are not successful network probes.
      if (latency !== undefined && Number.isFinite(latency) && latency >= 0) {
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
