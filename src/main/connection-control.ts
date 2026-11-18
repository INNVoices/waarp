import type { Phase } from '../shared/types'
import type { Prepared } from './connect'

export type ConnectionResult = { ok: boolean; error?: string }
interface ControlDeps {
  phase: () => Phase
  error: () => string | undefined
  demandsTunnel: () => boolean
  prepare: () => Promise<Prepared>
  start: () => Promise<void>
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
  async reconnect(revision = this.revision, options: { restart?: boolean; preserveIntent?: boolean; retainCore?: boolean } = {}): Promise<ConnectionResult> {
    const canceled = (): ConnectionResult => ({ ok: false, error: 'Подключение отменено' })
    if (!this.current(revision)) return canceled()
    const idle = async (): Promise<ConnectionResult> => {
      // Direct-only routing cannot implicitly close an open TUN.
      return this.current(revision) ? { ok: true } : canceled()
    }
    try {
      // Open but idle is valid only after the previous core has actually stopped.
      if (!this.d.demandsTunnel() && !options.retainCore) return await idle()
      if (!options.restart && this.d.phase() === 'on') return { ok: true }
      const ready = await this.d.prepare()
      if (!this.current(revision)) return canceled()
      if (!ready.ok) {
        if (!options.preserveIntent) this.set(false)
        await this.d.stop().catch(() => false)
        return ready
      }
      if (!this.d.demandsTunnel() && !options.retainCore) return await idle()
      await this.d.start()
      // OFF has already requested engine.stop. Do not stop a newer ON from an obsolete completion.
      if (!this.current(revision)) return canceled()
      if (this.d.phase() === 'on') return { ok: true }
      const error = this.d.error() ?? 'Туннель не запустился. Проверь подключение и попробуй снова'
      if (!options.preserveIntent) this.set(false)
      return { ok: false, error }
    } catch {
      if (!this.current(revision)) return canceled()
      if (!options.preserveIntent) this.set(false)
      await this.d.stop().catch(() => false)
      return { ok: false, error: 'Не удалось подключиться. Проверь сеть и повтори попытку' }
    }
  }

  async disconnect(): Promise<ConnectionResult> {
    this.set(false)
    try {
      return await this.d.stop() ? { ok: true } : { ok: false, error: this.d.error() ?? 'Не удалось подтвердить остановку туннеля' }
    } catch { return { ok: false, error: 'Не удалось подтвердить остановку туннеля' } }
  }

  toggle(): Promise<ConnectionResult> {
    return this.open || this.d.phase() === 'on' || this.d.phase() === 'starting' ? this.disconnect() : this.connect()
  }
}
