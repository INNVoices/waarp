import { localized } from '../shared/localization'
import type { Phase } from '../shared/types'
import type { Prepared } from './connect'

export type ConnectionResult = { ok: boolean; error?: string }
interface ControlDeps {
  phase: () => Phase
  error: () => string | undefined
  demandsTunnel: () => boolean
  prepare: (current: () => boolean) => Promise<Prepared>
  start: (current: () => boolean, began: () => void) => Promise<void>
  stop: () => Promise<boolean>
  /** Shared with profile and routing mutations; OFF deliberately does not wait for this queue. */
  serial: <T>(work: () => Promise<T>) => Promise<T>
  changed: () => void
}

/** The master owns intent, the engine owns processes. An older async operation cannot consume a newer ON. */
export class ConnectionControl {
  open = false
  revision = 0
  constructor(private d: ControlDeps) {}

  set(open: boolean): void {
    if (open === this.open) return
    this.open = open
    this.revision++
    this.d.changed()
  }

  current(revision: number): boolean { return this.open && this.revision === revision }

  connect(): Promise<ConnectionResult> {
    this.set(true)
    const revision = this.revision
    return this.d.serial(() => this.reconnect(revision))
  }

  /** Called from inside the shared mutation queue. It never reopens a user-closed master. */
  async reconnect(revision = this.revision, options: { restart?: boolean; preserveIntent?: boolean; retainCore?: boolean; beforeStart?: () => boolean } = {}): Promise<ConnectionResult> {
    const canceled = (): ConnectionResult => ({ ok: false, error: localized("winInline.connection-control.dd88cb45e978") })
    const current = () => this.current(revision) && (!options.beforeStart || options.beforeStart())
    if (!current()) return canceled()
    const keepPreparedSession = options.preserveIntent && this.d.phase() === 'on'
    let starting = false
    const idle = async (): Promise<ConnectionResult> => {
      // Direct-only routing cannot implicitly close an open TUN.
      if (!this.current(revision)) return canceled()
      const phase = this.d.phase()
      if (phase === 'error' || phase === 'stopping')
        return { ok: false, error: this.d.error() ?? localized("winInline.connection-control.9ce1acd606b7") }
      return { ok: true }
    }
    try {
      // Open but idle is valid only after the previous core has actually stopped.
      if (!this.d.demandsTunnel() && !options.retainCore) return await idle()
      if (!options.restart && this.d.phase() === 'on') return { ok: true }
      const ready = await this.d.prepare(current)
      if (!current()) return canceled()
      if (!ready.ok) {
        if (!options.preserveIntent) this.set(false)
        if (!keepPreparedSession) await this.d.stop().catch(() => false)
        return ready
      }
      if (!this.d.demandsTunnel() && !options.retainCore) return await idle()
      await this.d.start(current, () => { starting = true })
      // OFF has already requested engine.stop. Do not stop a newer ON from an obsolete completion.
      if (!this.current(revision)) return canceled()
      if (!starting && !current()) return canceled()
      if (this.d.phase() === 'on') return { ok: true }
      const error = this.d.error() ?? localized("winInline.connection-control.dc36b6426b6c")
      if (!options.preserveIntent) this.set(false)
      return { ok: false, error }
    } catch {
      if (!this.current(revision)) return canceled()
      if (!options.preserveIntent) this.set(false)
      if (starting || !keepPreparedSession) await this.d.stop().catch(() => false)
      return { ok: false, error: localized("winInline.connection-control.b521a8a413ca") }
    }
  }

  async disconnect(): Promise<ConnectionResult> {
    this.set(false)
    try {
      return await this.d.stop() ? { ok: true } : { ok: false, error: this.d.error() ?? localized("winInline.connection-control.c0aabad2ad21") }
    } catch { return { ok: false, error: localized("winInline.connection-control.c0aabad2ad21") } }
  }

  toggle(): Promise<ConnectionResult> {
    return this.open || this.d.phase() === 'on' || this.d.phase() === 'starting' ? this.disconnect() : this.connect()
  }
}
