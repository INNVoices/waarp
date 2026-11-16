export type RecoveryState = 'recovering' | 'ready' | 'failed'

interface RecoveryDeps {
  /** The engine may invalidate this after a later ownership-recording failure. */
  ready: () => boolean
  recover: () => Promise<boolean>
  changed: () => void
}

/** One recovery pass at a time. A failed pass is retryable; a healthy running core is never rescanned. */
export class RuntimeRecovery {
  private pending?: Promise<boolean>
  private attempted = false
  private succeeded = false

  constructor(private d: RecoveryDeps) {}

  get ready(): boolean { return !this.pending && this.succeeded && this.d.ready() }
  get state(): RecoveryState { return this.pending || !this.attempted ? 'recovering' : this.ready ? 'ready' : 'failed' }

  ensure(force = false): Promise<boolean> {
    if (this.pending) return this.pending
    if (!force && this.ready) return Promise.resolve(true)
    // Defer the native work until pending is installed: concurrent UI/startup/reset callers join the same pass.
    const pending = Promise.resolve().then(() => this.d.recover()).catch(() => false).then(ok => {
      this.succeeded = ok && this.d.ready()
      return this.succeeded
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined
      this.attempted = true
      this.d.changed()
    })
    this.pending = pending
    this.d.changed()
    return pending
  }

  /** Shutdown joins an already-running pass without starting a new one. */
  settled(): Promise<boolean> { return this.pending ?? Promise.resolve(this.ready) }
}
