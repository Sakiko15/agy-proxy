import { describe, it, expect } from 'vitest'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import { EngineError } from '../src/host/engine.ts'
import { Err } from '../src/common/types.ts'

describe('GatewaySemaphore', () => {
  it('acquires up to max, queues further waiters, wakes on release', async () => {
    const sem = new GatewaySemaphore(() => 2, () => 8)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.inFlight).toBe(2)
    let released = false
    const third = sem.acquire().then((rel) => {
      released = true
      return rel
    })
    // give the microtask loop a tick to register the waiter
    await new Promise((r) => setTimeout(r, 10))
    expect(sem.depth).toBe(1)
    expect(released).toBe(false)
    r1()
    const r3 = await third
    expect(released).toBe(true)
    expect(sem.inFlight).toBe(2)
    r2()
    r3()
    expect(sem.inFlight).toBe(0)
    expect(sem.depth).toBe(0)
  })

  it('throws EngineError BUSY when the queue is full', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 1)
    const r1 = await sem.acquire()
    void sem.acquire().catch(() => {}) // occupies the single queue slot
    await new Promise((r) => setTimeout(r, 10))
    await expect(sem.acquire()).rejects.toMatchObject({
      name: 'EngineError',
      code: Err.BUSY,
    })
    r1()
  })

  it('release order is FIFO', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 8)
    const r1 = await sem.acquire()
    const order: number[] = []
    const w1 = sem.acquire().then((rel) => { order.push(1); return rel })
    const w2 = sem.acquire().then((rel) => { order.push(2); return rel })
    await new Promise((r) => setTimeout(r, 10))
    r1()
    const rel1 = await w1
    rel1()
    await w2
    expect(order).toEqual([1, 2])
  })
})
