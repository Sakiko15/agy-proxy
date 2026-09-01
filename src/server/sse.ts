// SSE writer for streaming responses (charter §4.3 + §7): writes through
// `reply.hijack()` onto the raw server response so no Fastify serialization
// buffers in between — parser line → mapper chunk → SSE frame, no aggregate.
// New code, not a port. Two obligations beyond frame formatting:
// - backpressure: `raw.write` returning false pauses the producer via
//   `once('drain')`, honoring Node stream semantics on slow clients;
// - heartbeat (charter §6): when nothing real has been sent for
//   cfg.sseHeartbeatMs, emit the caller's keepalive frame so reverse proxies
//   and Cloudflare keep the connection alive. The timer is torn down on
//   close() and on the raw stream's 'close' (client disconnect), never left
//   holding the event loop.
import type { FastifyReply } from 'fastify'
import type { ServerResponse } from 'node:http'

export class SseWriter {
  private readonly raw: ServerResponse
  private readonly heartbeatMs: number
  private readonly makeKeepalive: () => string
  private lastSendAt = 0
  private heartbeatTimer: NodeJS.Timeout | null = null
  private closed = false
  /** Resolves when the client stream ends or close() finishes. */
  readonly done: Promise<void>

  constructor(reply: FastifyReply, opts: { heartbeatMs: number; keepalive: () => string }) {
    this.raw = reply.raw
    this.heartbeatMs = opts.heartbeatMs
    this.makeKeepalive = opts.keepalive
    reply.hijack()
    let releaseDone: () => void = () => undefined
    this.done = new Promise<void>((resolve) => {
      releaseDone = resolve
    })
    const stop = (): void => {
      this.stopHeartbeat()
      releaseDone()
    }
    this.raw.on('close', stop)
  }

  /** Send the response head. Call once before any frames. */
  open(status = 200, headers: Record<string, string> = {}): void {
    if (this.closed) return
    this.raw.writeHead(status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // nginx: stream unbuffered
      ...headers,
    })
    // writeHead only stores the head — Node flushes it on the first body
    // write. A slow engine (thinking for a minute, or heartbeats disabled)
    // would leave the client with no status line at all, so push it out now.
    this.raw.flushHeaders()
    this.lastSendAt = Date.now()
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.tick(), this.heartbeatMs)
      this.heartbeatTimer.unref()
    }
  }

  /** Heartbeat tick: keepalive only if the stream went quiet past the interval. */
  private tick(): void {
    if (this.closed) return
    if (Date.now() - this.lastSendAt < this.heartbeatMs) return
    this.writeRaw(this.makeKeepalive())
    this.lastSendAt = Date.now()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Write one frame honoring backpressure; resolves when the socket accepts it. */
  private async writeRaw(frame: string): Promise<void> {
    if (this.closed || this.raw.destroyed || this.raw.writableEnded) return
    const ok = this.raw.write(frame)
    if (!ok) await new Promise<void>((resolve) => this.raw.once('drain', resolve))
  }

  /** `data: <json>\n\n` (OpenAI chunk / [DONE] sentinel). */
  async data(payload: unknown): Promise<void> {
    const body = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload)
    this.lastSendAt = Date.now()
    await this.writeRaw('data: ' + body + '\n\n')
  }

  /** `event: <name>\ndata: <json>\n\n` (Anthropic event style). With `id`,
   *  an `id: <seq>` line is prepended so EventSource tracks lastEventId for
   *  Last-Event-ID reconnects (admin event stream, M4). */
  async event(name: string, payload: unknown, id?: number): Promise<void> {
    this.lastSendAt = Date.now()
    const idLine = typeof id === 'number' ? 'id: ' + id + '\n' : ''
    await this.writeRaw('event: ' + name + '\n' + idLine + 'data: ' + JSON.stringify(payload) + '\n\n')
  }

  /** End the stream: [DONE] is the caller's job; this closes our side cleanly. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopHeartbeat()
    if (!this.raw.writableEnded) {
      this.raw.end()
    }
  }
}
