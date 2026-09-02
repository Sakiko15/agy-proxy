// Shutdown lifecycle (batch 2): a live /admin/events SSE client must not hang
// app.close() (B-H1 — preClose ends the hijacked streams before close), the
// grace expiry must abort in-flight work AND destroy raw sockets (B-H1 force
// path), and a second signal during shutdown must force-exit instead of being
// swallowed (B-L2). Real-listen for the H1 leg; fakes for the unit paths.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createShutdown, InFlightTracker } from '../src/server/shutdown.ts'
import { makeAdminServer, login } from './helpers.admin.ts'
import { buildLogger } from '../src/server/logger.ts'

const log = buildLogger({ AGY_PROXY_LOG_LEVEL: 'error' })

const runners = Array<{ built: ReturnType<typeof makeAdminServer>['built'] }>()

afterEach(async () => {
  while (runners.length > 0) {
    const r = runners.pop()!
    // Force-reap whatever the test left connected: closeAllConnections first so
    // a still-hijacked stream cannot hang this teardown either.
    try {
      r.built.app.server?.closeAllConnections()
    } catch {
      // already closed
    }
    await r.built.app.close().catch(() => undefined)
  }
})

describe('shutdown while SSE clients are online (B-H1)', () => {
  it('a live /admin/events client does not block the shutdown sequence', async () => {
    const { built, events } = makeAdminServer({ sseHeartbeatMs: 0 })
    runners.push({ built })
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = built.app.server?.address()
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no listen port')
    const base = `http://127.0.0.1:${addr.port}`
    const { cookie } = await login(built)

    const res = await fetch(`${base}/admin/events`, {
      headers: { cookie },
      signal: AbortSignal.timeout(8000),
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    // Wait for the first frame: the client is truly parked on the hijacked
    // reply before the shutdown sequence starts.
    const first = await reader.read()
    expect(first.done).toBe(false)
    void reader.cancel().catch(() => undefined)

    const exits: number[] = []
    const shutdown = createShutdown(
      { app: built.app, inFlight: built.inFlight, server: built.app.server },
      { log, graceMs: 10_000, preClose: () => events.closeAll(), exit: (code) => exits.push(code) },
    )
    const t0 = Date.now()
    await shutdown('SIGTERM')
    expect(Date.now() - t0).toBeLessThan(5000)
    // The sequence completed cleanly: code 0, no forced exit.
    expect(exits).toEqual([0])

    // The client stream must have been ended by the preClose, not left parked.
    const tail = await Promise.race([reader.read(), new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000))])
    expect(tail).not.toBe('timeout')
    runners.pop()
  })

  it('grace expiry aborts in-flight work and destroys raw connections (force path)', async () => {
    const closeAllConnections = vi.fn()
    const built = {
      app: { close: () => new Promise<void>(() => {}) }, // a close that never resolves
      inFlight: new InFlightTracker(),
      server: { closeAllConnections },
    }
    const shutdown = createShutdown(built, { log, graceMs: 150, exit: () => undefined })
    void shutdown('SIGTERM')
    await vi.waitFor(() => expect(closeAllConnections).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })
})

describe('second shutdown signal (B-L2)', () => {
  it('a second signal during shutdown force-exits instead of being ignored', async () => {
    const built = {
      app: { close: () => new Promise<void>(() => {}) }, // close hangs — shutdown in progress
      inFlight: new InFlightTracker(),
    }
    const exits: number[] = []
    const shutdown = createShutdown(built, { log, graceMs: 30_000, exit: (code) => exits.push(code) })
    void shutdown('SIGTERM')
    await shutdown('SIGINT') // second signal while the first is still closing
    expect(exits).toEqual([1])
  })
})