/**
 * Small process-local FIFO for state mutations that must be atomic across await points.
 * A failed operation never poisons the queue; the next write still runs.
 */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve()

  run<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const next = this.tail.then(() => work(), () => work())
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
}
