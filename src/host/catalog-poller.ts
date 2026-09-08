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
      // refreshIfNeeded never throws and dedupes in-flight refreshes, so
      // overlap with the boot call or a manual forceRefresh is safe.
      await deps.catalog.refreshIfNeeded()
      const catalog = deps.catalog.get()
      if (catalog.source === 'discovered') {
        // A failed re-validation keeps serving the previous list (SWR) and
        // must not trigger backoff — the TTL keeps the cadence.
        if (failures > 0 || lastReported !== undefined) {
          deps.log?.info('model discovery recovered — catalog serves the discovered list')
        }
        failures = 0
        lastReported = undefined
        schedule(CATALOG_POLL_INTERVAL_MS)
        return
      }
      if (catalog.lastError === undefined) {
        // Initial fallback catalog whose first refresh has not settled yet.
        schedule(CATALOG_POLL_INTERVAL_MS)
        return
      }
      failures += 1
      if (catalog.lastError !== lastReported) {
        deps.log?.warn(`model discovery failing (consecutive ${failures}): ${catalog.lastError}`)
        lastReported = catalog.lastError
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