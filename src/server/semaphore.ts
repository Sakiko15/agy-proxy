// Request-gateway semaphore: bounds concurrent agy processes and the queue
// of waiters in front of them. Ported from dsh-agy-link src/index.ts @ 46984db
// (modified: the host-context Semaphore gains a waiter counter and a queue
// cap — a request beyond maxQueueDepth fails fast with Err.BUSY instead of
// waiting unboundedly — plus depth/active probes for the status surface;
// B3/P4: acquire() takes an optional AbortSignal so a client that disconnects
// while parked leaves the queue instead of eventually winning a slot it would
// hand straight back).
import { EngineError } from '../host/engine.ts'
import { Err } from '../common/types.ts'

/**
 * One parked acquire. `settled` is the single latch: exactly one of wake()
 * (release handed this waiter a slot) or drop() (the waiter aborted) ever
 * runs — whichever flips the flag first wins, and the other becomes
 * unreachable (a dropped waiter is spliced out of the queue before drop(), so
 * release() can never shift it afterward).
 */
interface Waiter {
  settled: boolean
  wake(): void
  drop(): void
}

export class GatewaySemaphore {
  private active = 0
  private waiting: Array<Waiter> = []

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

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.max() || this.waiting.length > 0) {
      // B3/P4: an already-aborted call must not occupy a queue slot. The
      // fast path below deliberately does NOT consult the signal — a call
      // that can be served immediately keeps today's semantics, and the
      // engine's post-acquire check (A-M2) remains the backstop for races.
      if (signal?.aborted ?? false) {
        throw new EngineError('request aborted while waiting for a concurrency slot', 'ABORTED')
      }
      if (this.waiting.length >= this.maxQueued()) {
        throw new EngineError(
          'request queue is full (' + this.waiting.length + ' waiting, max ' + this.maxQueued() + ')',
          Err.BUSY,
        )
      }
      let waiter!: Waiter
      const slot = new Promise<void>((resolve, reject) => {
        waiter = {
          settled: false,
          // H3: the slot is transferred by release() with the count
          // unchanged, so nothing to increment here. The old active--/active++
          // pair let an acquire issued in the same tick as the release (one
          // I/O callback finishing a run and starting another) barge past max
          // while the woken waiter's increment was still pending in the
          // microtask queue.
          wake: () => resolve(),
          // B3/P4: reject the parked promise so the awaiting caller fails
          // with ABORTED — a dropped waiter never owned a slot, so there is
          // nothing to release (and no active++ to undo).
          drop: () => reject(new EngineError('request aborted while waiting for a concurrency slot', 'ABORTED')),
        }
        this.waiting.push(waiter)
      })
      const onAbort = (): void => {
        if (waiter.settled) return // handoff already won (or the listener leaked past finally)
        waiter.settled = true
        const i = this.waiting.indexOf(waiter)
        if (i >= 0) this.waiting.splice(i, 1)
        waiter.drop()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await slot
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      return this.release.bind(this)
    }
    this.active++
    return this.release.bind(this)
  }

  private release(): void {
    // Skip-and-retry double guard (B3/P4): a settled entry in the queue would
    // mean a dropped waiter was left behind — it never owned a slot, so it
    // must not be woken (that would silently hand the slot to a dead caller
    // and leak the count). The abort path splices before dropping, so this
    // loop should never actually skip; it exists so a future edit cannot
    // resurrect the double-release class of bug.
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      if (next.settled) continue
      next.settled = true
      next.wake()
      return
    }
    this.active--
  }
}