// Catalog refresh poller (MA5): realizes the charter §7 stale-while-revalidate
// promise — the ModelCatalog TTL only gates re-discovery when something calls
// refreshIfNeeded, so a fixed-cadence poller drives it. Cadence is a constant,
// not config: the effective refresh rate is already tunable end-to-end through
// the runtime-overrides modelsCacheTtlMs key, and the failing path is capped
// by the backoff ceiling below. New code, not a port.
import type { ModelCatalog } from './models.ts'

export const CATALOG_POLL_INTERVAL_MS = 60_000
export const CATALOG_BACKOFF_MAX_MS = 10 * 60_000

export interface CatalogPollerLog {
  warn(message: string): void
  info(message: string): void
  debug(message: string): void
}

export interface CatalogPollerDeps {
  catalog: ModelCatalog
  /** False while no eligible account exists — the tick is skipped entirely,
   *  spawning nothing (a 30s-timeout signed-out spawn every interval would
   *  otherwise repeat forever on zero-account deployments). */
  canDiscover: () => boolean
  log?: CatalogPollerLog
}

export function startCatalogPoller(deps: CatalogPollerDeps): { stop(): void } {
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let failures = 0
  let lastReported: string | undefined

  const schedule = (ms: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, ms)
    timer.unref()
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      if (!deps.canDiscover()) {
        // No eligible account: nothing to discover with, and the signed-out
        // spawn would just burn a 30s timeout — hold at the base cadence.
        failures = 0
        lastReported = undefined
        schedule(CATALOG_POLL_INTERVAL_MS)
        return
      }
      // refreshIfNeeded never throws and dedupes in-flight refreshes through
      // the `refreshing` latch — forceRefresh routes through that latch too
      // (code-review #10), so overlap with the boot call or a manual refresh
      // serializes instead of stacking concurrent `agy models` spawns.
      // B4/S7: branch on the reported outcome instead of sniffing
      // catalog.source — a failed re-validation of a discovered catalog
      // spreads the old 'discovered' source over the stale timestamp, so
      // the source check used to read every failure as a recovery and kept
      // `failures` pinned at 0 (the §7 backoff promise never engaged after
      // the first successful discovery). SWR is untouched: the stale list
      // keeps serving while the poller backs off.
      const outcome = await deps.catalog.refreshIfNeeded()
      if (outcome !== 'failed') {
        // 'ok' = discovery succeeded; 'fresh' = the TTL gate skipped the
        // attempt (only reachable after a success, incl. an out-of-band
        // forceRefresh) — both are healthy states.
        if (failures > 0 || lastReported !== undefined) {
          deps.log?.info('model discovery recovered — catalog serves the discovered list')
        }
        failures = 0
        lastReported = undefined
        schedule(CATALOG_POLL_INTERVAL_MS)
        return
      }
      failures += 1
      const message = deps.catalog.get().lastError ?? 'model discovery failed'
      if (message !== lastReported) {
        deps.log?.warn(`model discovery failing (consecutive ${failures}): ${message}`)
        lastReported = message
      } else {
        deps.log?.debug(`model discovery still failing (consecutive ${failures})`)
      }
      schedule(Math.min(CATALOG_POLL_INTERVAL_MS * 2 ** failures, CATALOG_BACKOFF_MAX_MS))
    } catch {
      // refreshIfNeeded never rejects, but never let the chain die.
      schedule(CATALOG_POLL_INTERVAL_MS)
    }
  }

  schedule(CATALOG_POLL_INTERVAL_MS)

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}