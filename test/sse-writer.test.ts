// Unit tests for SseWriter's backpressure waiter (M5'): a frame write that
// returns false parks the producer on a 'drain' event — but a client that
// disconnects mid-backpressure never drains, so the waiter must also settle
// on 'close'/'error' or the streaming loop hangs forever.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { FastifyReply } from 'fastify'
import { SseWriter } from '../src/server/sse.ts'

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