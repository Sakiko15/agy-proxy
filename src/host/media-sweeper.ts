// Media TTL sweeper scheduling (M5): sweepDir() has existed (and been pinned
// by tests) since the M1 port, but nothing ever ran it — staged request
// images (sensitive client payloads) accumulated without bound on the
// volume. This wrapper gives the entry point a lifecycle handle: one sweep
// at boot (so a restart after TTL expiry cleans immediately) plus an
// unref'd interval that stop() clears at teardown. Lives in its own file —
// media.ts is a verbatim port and must stay diffable against upstream.

import { sweepDir } from './media.ts'

export interface MediaSweeper {
  /** Clears the interval; safe to call more than once. */
  stop(): void
}

const DEFAULT_SWEEP_INTERVAL_MS = 3_600_000

/** Runs sweepDir(dir, ttlMs) once now and then every max(intervalMs, 60s);
 *  ttlMs <= 0 disables sweeping entirely (returns an inert handle). */
export function startMediaSweeper(
  dir: string,
  ttlMs: number,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
  log?: (msg: string) => void,
): MediaSweeper {
  if (ttlMs <= 0) {
    log?.('media sweeper disabled (mediaTtlMs <= 0)')
    return { stop: () => {} }
  }
  const cadence = Math.max(60_000, intervalMs)
  const runOnce = (): void => {
    void sweepDir(dir, ttlMs)
      .then((removed) => {
        if (removed > 0) log?.(`media sweeper removed ${removed} expired staged file(s) from ${dir}`)
      })
      .catch(() => undefined) // sweepDir already swallows per-file errors; belt for future edits
  }
  runOnce()
  const timer = setInterval(runOnce, cadence)
  timer.unref()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}