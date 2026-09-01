// Request-gateway semaphore: bounds concurrent agy processes and the queue
// of waiters in front of them. Ported from dsh-agy-link src/index.ts @ 46984db
// (modified: the host-context Semaphore gains a waiter counter and a queue
// cap — a request beyond maxQueueDepth fails fast with Err.BUSY instead of
// waiting unboundedly — plus depth/active probes for the status surface).
import { EngineError } from '../host/engine.ts'
import { Err } from '../common/types.ts'

export class GatewaySemaphore {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(
    private readonly max: () => number,
    private readonly maxQueued: () => number,
  ) {}

  get depth(): number {
    return this.waiting.length
  }

  get inFlight(): number {
    return this.active
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max() || this.waiting.length > 0) {
      if (this.waiting.length >= this.maxQueued()) {
        throw new EngineError(
          'request queue is full (' + this.waiting.length + ' waiting, max ' + this.maxQueued() + ')',
          Err.BUSY,
        )
      }
      const slot = new Promise<void>((resolve) => this.waiting.push(resolve))
      await slot
      // H3: the slot was transferred by release() with the count unchanged,
      // so nothing to increment here. The old active--/active++ pair let an
      // acquire issued in the same tick as the release (one I/O callback
      // finishing a run and starting another) barge past max while the woken
      // waiter's increment was still pending in the microtask queue.
      return this.release.bind(this)
    }
    this.active++
    return this.release.bind(this)
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next !== undefined) {
      // Direct slot handoff: the count stays put and the woken waiter owns
      // the slot without re-incrementing, so no same-tick acquire can slip
      // between the wake and the waiter's bookkeeping.
      next()
      return
    }
    this.active--
  }
}
