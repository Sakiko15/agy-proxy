// Unit tests for SseWriter's backpressure waiter (M5'): a frame write that
// returns false parks the producer on a 'drain' event — but a client that
// disconnects mid-backpressure never drains, so the waiter must also settle
// on 'close'/'error' or the streaming loop hangs forever. The stall timer
// (batch 2, B-M1) adds the last resort: a parked write that never drains is
// force-destroyed after the stall window so the parked producer settles and
// the disconnect cascade can free its semaphore slot.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { FastifyReply } from 'fastify'
import { SseWriter, stallWindowMs } from '../src/server/sse.ts'

/** Minimal raw ServerResponse double: every write reports backpressure. */
class BackpressuredRaw extends EventEmitter {
  destroyed = false
  writableEnded = false
  writableFinished = false
  writeHead(): void {}
  flushHeaders(): void {}
  write(): boolean {
    return false
  }
  end(): void {
    this.writableEnded = true
  }
}

function makeWriter(): { writer: SseWriter; raw: BackpressuredRaw } {
  const raw = new BackpressuredRaw()
  const reply = {
    raw,
    hijack: () => undefined,
  } as unknown as FastifyReply
  const writer = new SseWriter(reply, { heartbeatMs: 0, keepalive: () => ': ka\n\n' })
  writer.open()
  return { writer, raw }
}

describe('SseWriter backpressure waiter (M5)', () => {
  it('a drain event settles the parked write', async () => {
    const { writer, raw } = makeWriter()
    const pending = writer.data('chunk')
    raw.emit('drain')
    await expect(pending).resolves.toBeUndefined()
  })

  it('a client disconnect (close) settles the parked write instead of hanging it', async () => {
    const { writer, raw } = makeWriter()
    const pending = writer.data('chunk')
    raw.emit('close')
    await expect(pending).resolves.toBeUndefined()
  })

  it('a socket error settles the parked write too', async () => {
    const { writer, raw } = makeWriter()
    const pending = writer.event('error-test', { x: 1 })
    raw.emit('error', new Error('ECONNRESET'))
    await expect(pending).resolves.toBeUndefined()
  })

  it('the waiter leaves no duplicate listeners behind after settling', async () => {
    const { writer, raw } = makeWriter()
    const pending = writer.data('chunk')
    raw.emit('drain')
    await pending
    // The waiter's once() handlers come off after settle. 'close' legitimately
    // keeps one listener: the constructor's teardown hook, not the waiter's.
    expect(raw.listenerCount('drain')).toBe(0)
    expect(raw.listenerCount('close')).toBe(1)
    expect(raw.listenerCount('error')).toBe(0)
  })
})

describe('SseWriter stall watchdog (B-M1)', () => {
  function makeStallWriter(stallMs: number): { writer: SseWriter; raw: BackpressuredRaw; destroy: ReturnType<typeof vi.fn> } {
    const raw = new BackpressuredRaw()
    const destroy = vi.fn((): void => {
      raw.destroyed = true
      raw.emit('close')
    })
    ;(raw as unknown as { destroy: typeof destroy }).destroy = destroy
    const reply = { raw, hijack: () => undefined } as unknown as FastifyReply
    const writer = new SseWriter(reply, { heartbeatMs: 0, keepalive: () => ': ka\n\n', stallMs })
    writer.open()
    return { writer, raw, destroy }
  }

  it('a parked write that never drains is force-destroyed after the stall window', async () => {
    const { writer, destroy } = makeStallWriter(80)
    await writer.data('chunk') // parks → stall fires → destroy → raw 'close' settles
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(writer.isClosed()).toBe(false) // the watchdog destroys the socket, not the writer
  })

  it('a drain within the stall window does not destroy the socket', async () => {
    const { writer, raw, destroy } = makeStallWriter(200)
    const pending = writer.data('chunk')
    setTimeout(() => raw.emit('drain'), 20)
    await expect(pending).resolves.toBeUndefined()
    expect(destroy).not.toHaveBeenCalled()
    // The watchdog is one-shot per park: a settled waiter leaves no timer.
    expect(writer.isClosed()).toBe(false)
  })

  it('isClosed() tracks the writer lifecycle', async () => {
    const { writer, raw } = makeStallWriter(10_000)
    expect(writer.isClosed()).toBe(false)
    await writer.close()
    expect(writer.isClosed()).toBe(true)
    // close() ends the raw stream — no stall timer may outlive it.
    expect(raw.writableEnded).toBe(true)
  })

  it('stallWindowMs: heartbeat-coupled floor of 180s', () => {
    expect(stallWindowMs(0)).toBe(180_000)
    expect(stallWindowMs(1_000)).toBe(180_000)
    expect(stallWindowMs(60_000)).toBe(180_000)
    expect(stallWindowMs(120_000)).toBe(360_000)
  })
})