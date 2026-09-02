// Graceful shutdown (charter §6): SIGTERM/SIGINT → stop accepting → grace
// window → abort in-flight requests (the engine cascades the abort into the
// agy process-group kill) → app.close() → exit. New code, not a port. The
// 25s grace sits below the documented docker stop_grace_period of 30s.
// Batch 2: the sequence is an exported awaitable (createShutdown) so tests
// can drive it without process.exit; a preClose hook runs BEFORE app.close()
// (ending hijacked /admin/events streams that Fastify's close cannot reap —
// with one such client online, app.close() used to hang past the grace
// window and docker's SIGKILL skipped the ledger flush + WAL checkpoint);
// and a second signal force-exits instead of being swallowed.
import type { Logger } from 'pino'

/** Minimal structural shape the shutdown sequence needs — accepts any Fastify
 *  instance regardless of its type-parameter binding (the concrete
 *  AppInstance from app.ts and test-built apps both satisfy it). */
export interface ShutdownTarget {
  app: { close(): Promise<void> }
  inFlight: InFlightTracker
  /** The raw http.Server — grace expiry calls closeAllConnections() to reap
   *  sockets app.close() cannot settle (hijacked writes parked in
   *  backpressure). Optional: unit fakes without a server skip it. */
  server?: { closeAllConnections(): void }
}

export interface ShutdownOptions {
  log: Logger
  graceMs?: number
  teardown?: () => Promise<void>
  /** Runs before app.close(). index.ts passes bus.closeAll() — the admin SSE
   *  streams hold connections open, and they must end before (not after) the
   * close that waits on them. */
  preClose?: () => void
  /** Exit seam (tests capture instead of killing the process). */
  exit?: (code: number) => void
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

/** One shutdown run, from signal to exit code. preClose fires first (ends
 *  hijacked SSE), then app.close() waits for the drain; if the grace window
 *  elapses first, in-flight agy runs are aborted and every raw socket is
 *  destroyed — the raw 'close' settle path releases parked SSE writers, which
 *  is what lets app.close() actually finish. */
export async function runShutdownSequence(
  built: ShutdownTarget,
  opts: ShutdownOptions,
  signal: string,
): Promise<number> {
  const graceMs = opts.graceMs ?? 25_000
  opts.log.info({ signal }, 'shutting down')
  if (opts.preClose !== undefined) {
    try {
      opts.preClose()
    } catch (err: unknown) {
      opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'shutdown preClose error')
    }
  }
  const timer = setTimeout(() => {
    const n = built.inFlight.abortAll('server shutting down')
    built.server?.closeAllConnections()
    opts.log.warn({ aborted: n }, 'grace window elapsed — aborted in-flight agy runs')
  }, graceMs)
  timer.unref()
  try {
    await built.app.close()
    // M3 teardown (charter §6): stop the pollers, cancel any OAuth flow,
    // then flush the usage ledger + WAL checkpoint before exit — rows
    // written during the drain window must land.
    if (opts.teardown !== undefined) {
      try {
        await opts.teardown()
      } catch (err: unknown) {
        opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'shutdown teardown error')
      }
    }
    return 0
  } catch (err: unknown) {
    opts.log.error({ err: err instanceof Error ? err.message : String(err) }, 'error during shutdown')
    await (opts.teardown !== undefined ? opts.teardown() : Promise.resolve()).catch(() => undefined)
    return 1
  }
}

/** Reentry-latched shutdown trigger: the first call runs the sequence and
 *  feeds the resulting code to the exit seam; a call while one is already
 *  running means the operator (or docker) pressed again — log and force-exit
 *  immediately instead of waiting on a close that may never resolve. */
export function createShutdown(
  built: ShutdownTarget,
  opts: ShutdownOptions,
): (signal: string) => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  let running = false
  return async (signal: string): Promise<void> => {
    if (running) {
      opts.log.warn({ signal }, 'second shutdown signal — forcing exit')
      exit(1)
      return
    }
    running = true
    exit(await runShutdownSequence(built, opts, signal))
  }
}

export function installShutdown(built: ShutdownTarget, opts: ShutdownOptions): void {
  const shutdown = createShutdown(built, opts)
  // `on`, not `once`: the reentry latch in createShutdown turns a second
  // signal into a forced exit (B-L2) — with `once` a double Ctrl-C was simply
  // dropped, leaving an unkillable shutdown to wait for docker's SIGKILL.
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}