import type { Conn } from '../shared/types'

/** A missing/stale controller sample is not evidence that an application is
 * idle. A short quiet interval also joins adjacent TCP/UDP channels of one
 * active path, without pretending to recognize a game's application session. */
export const FLOW_SAMPLE_MAX_AGE_MS = 3000
export const FLOW_QUIET_MS = 5000

export class FlowActivity {
  private observedAt?: number
  private observingSince?: number
  private lastActive = new Map<string, number>()

  observe(connections: readonly Pick<Conn, 'via'>[], loaded: ReadonlySet<string>, now = performance.now()): void {
    if (this.observedAt !== undefined && (now < this.observedAt || now - this.observedAt > FLOW_SAMPLE_MAX_AGE_MS))
      this.observingSince = undefined
    this.observingSince ??= now
    this.observedAt = now
    for (const id of this.lastActive.keys()) if (!loaded.has(id)) this.lastActive.delete(id)
    for (const connection of connections) if (loaded.has(connection.via)) this.lastActive.set(connection.via, now)
  }

  idle(paths: readonly string[], now = performance.now()): boolean {
    if (!paths.length || this.observedAt === undefined || this.observingSince === undefined ||
      now < this.observedAt || now - this.observedAt > FLOW_SAMPLE_MAX_AGE_MS ||
      now - this.observingSince < FLOW_QUIET_MS) return false
    return paths.every(id => now - (this.lastActive.get(id) ?? this.observingSince!) >= FLOW_QUIET_MS)
  }

  invalidate(): void { this.observedAt = undefined; this.observingSince = undefined }
  reset(): void { this.invalidate(); this.lastActive.clear() }
}
