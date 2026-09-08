// B3/P4: GatewaySemaphore abort wiring. A parked acquire with an AbortSignal
// must leave the queue on abort without consuming a slot (the abort path
// splices the waiter out before dropping it — the slot it was waiting for is
// untouched), a late abort after the slot handoff must be a no-op (the
// handoff transferred ownership; the abort listener is already gone), and a
// randomized acquire/abort/release mix must keep the count exact — peak ≤
// max, terminal inFlight 0, depth 0. The H3 direct handoff and the
// maxQueueDepth BUSY contract are pinned as regression guards.
import { describe, it, expect } from 'vitest'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

describe('GatewaySemaphore abort wiring (B3/P4)', () => {
  it('a waiter that aborts while parked leaves the queue without consuming a slot', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 10)
    const release1 = await sem.acquire()
    expect(sem.inFlight).toBe(1)
    const ac = new AbortController()
    // acquire runs synchronously up to the parked await, so the waiter is
    // queued before the returned promise is awaited.
    const parked = sem.acquire(ac.signal)
    expect(sem.depth).toBe(1)
    ac.abort()
    await expect(parked).rejects.toThrow(/aborted while waiting/)
    // Spliced out on abort: the queue is empty and the held slot is intact.
    expect(sem.depth).toBe(0)
    expect(sem.inFlight).toBe(1)
    // The live slot still works end to end.
    release1()
    const release2 = await sem.acquire()
    expect(sem.inFlight).toBe(1)
    release2()
    expect(sem.inFlight).toBe(0)
  })

  it('an abort after the slot handoff is a no-op (no double release, no negative counts)', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 10)
    const release1 = await sem.acquire()
    const ac = new AbortController()
    const parked = sem.acquire(ac.signal)
    expect(sem.depth).toBe(1)
    release1() // direct handoff: count unchanged, the waiter now owns the slot
    const release2 = await parked
    expect(sem.inFlight).toBe(1)
    expect(sem.depth).toBe(0)
    // Late abort — the listener was removed in acquire's finally, and the
    // settled latch would no-op it regardless. Ownership is unaffected.
    ac.abort()
    await new Promise((r) => setTimeout(r, 5))
    expect(sem.inFlight).toBe(1)
    release2()
    expect(sem.inFlight).toBe(0)
  })

  it('release after every waiter dropped decrements the count (skip-and-retry)', async () => {
    const sem = new GatewaySemaphore(() => 2, () => 10)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.inFlight).toBe(2)
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const p1 = sem.acquire(ac1.signal)
    const p2 = sem.acquire(ac2.signal)
    expect(sem.depth).toBe(2)
    ac1.abort()
    ac2.abort()
    await expect(p1).rejects.toThrow(/aborted while waiting/)
    await expect(p2).rejects.toThrow(/aborted while waiting/)
    expect(sem.depth).toBe(0)
    // Both releases find no live waiter → the fast-path increments are
    // returned; a settled waiter left in the queue would swallow a slot.
    r1()
    r2()
    expect(sem.inFlight).toBe(0)
    const r3 = await sem.acquire()
    expect(sem.inFlight).toBe(1)
    r3()
    expect(sem.inFlight).toBe(0)
  })

  it('maxQueueDepth BUSY and H3 direct handoff survive the rewrite', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 1)
    const r1 = await sem.acquire()
    const parked = sem.acquire(new AbortController().signal)
    expect(sem.depth).toBe(1)
    // Queue cap: the second waiter fails fast with BUSY.
    await expect(sem.acquire()).rejects.toThrow(/queue is full/)
    // Handoff: release wakes the parked waiter without touching the count.
    r1()
    const release2 = await parked
    expect(sem.inFlight).toBe(1)
    release2()
    expect(sem.inFlight).toBe(0)
  })

  it('400 randomized acquire/abort/release ops keep the count exact (chaos)', async () => {
    const max = 4
    const sem = new GatewaySemaphore(() => max, () => 1000)
    // Deterministic LCG so a failure reproduces with the same interleaving.
    let seed = 42
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const controllers: AbortController[] = []
    const releases: Array<() => void> = []
    let peak = 0
    const ops: Array<Promise<unknown>> = []
    for (let i = 0; i < 400; i++) {
      const roll = rnd()
      if (roll < 0.55) {
        const ac = new AbortController()
        controllers.push(ac)
        const useSignal = rnd() < 0.5
        ops.push(
          sem.acquire(useSignal ? ac.signal : undefined).then(
            (rel) => {
              releases.push(rel)
              peak = Math.max(peak, sem.inFlight)
              if (rnd() < 0.3) {
                rel()
                const idx = releases.indexOf(rel)
                if (idx >= 0) releases.splice(idx, 1)
              }
            },
            () => undefined, // an aborted acquire rejects — already covered by the final count assertions
          ),
        )
        if (rnd() < 0.25) ac.abort() // abort before the waiter was even awaited
      } else if (roll < 0.8 && releases.length > 0) {
        releases.shift()!()
      } else if (controllers.length > 0) {
        controllers.shift()!.abort() // may be a late no-op after handoff
      }
      // Interleave a macrotask turn so wakeups, abort callbacks and
      // continuations overlap instead of running in lockstep.
      if (i % 7 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    // Drive to quiescence BEFORE awaiting the ops: a parked waiter is woken
    // only by a release call, and each release may wake a waiter whose own
    // release thunk is deposited only in its continuation — so keep draining
    // across macrotask turns until no slot is held and nobody is parked.
    for (let turn = 0; turn < 200; turn++) {
      await new Promise((r) => setTimeout(r, 0))
      while (releases.length > 0) releases.shift()!()
      if (releases.length === 0 && sem.inFlight === 0 && sem.depth === 0) break
    }
    await Promise.allSettled(ops)
    expect(peak).toBeLessThanOrEqual(max)
    expect(sem.inFlight).toBe(0)
    expect(sem.depth).toBe(0)
  })
})