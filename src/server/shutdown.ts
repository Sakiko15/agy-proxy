// Graceful shutdown (charter §6): SIGTERM/SIGINT → stop accepting → grace
// window → abort in-flight requests (the engine cascades the abort into the
// agy process-group kill) → app.close() → exit. New code, not a port. The
// 25s grace sits below the documented docker stop_grace_period of 30s.
import type { Logger } from 'pino'

/** Minimal structural shape installShutdown needs — accepts any Fastify
 *  instance regardless of its type-parameter binding (the concrete
 *  AppInstance from app.ts and test-built apps both satisfy it). */
export interface ShutdownTarget {
  app: { close(): Promise<void> }
  inFlight: InFlightTracker
}

export class InFlightTracker {
  private readonly controllers = new Set<AbortController>()

  add(c: AbortController): void {
    this.controllers.add(c)
  }

  remove(c: AbortController): void {
    this.controllers.delete(c)
  }

  abortAll(reason: string): number {
    const n = this.controllers.size
    for (const c of this.controllers) {
      try {
        c.abort(new Error(reason))
      } catch {
        // already aborted
      }
    }
    return n
  }

  get size(): number {
    return this.controllers.size
  }
}

export function installShutdown(
  built: ShutdownTarget,
  opts: { log: Logger; graceMs?: number },
): void {
  const graceMs = opts.graceMs ?? 25_000
  const shutdown = (signal: string): void => {
    opts.log.info({ signal }, 'shutting down')
    const timer = setTimeout(() => {
      const n = built.inFlight.abortAll('server shutting down')
      opts.log.warn({ aborted: n }, 'grace window elapsed — aborted in-flight agy runs')
    }, graceMs)
    timer.unref()
    built.app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        opts.log.error({ err: err instanceof Error ? err.message : String(err) }, 'error during shutdown')
        process.exit(1)
      })
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}
