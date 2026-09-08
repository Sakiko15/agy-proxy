// Model-discovery spawn plumbing (MA5): the ModelCatalog needs `agy models`
// stdout, and that command is only signed in inside a pool account's isolated
// HOME (the account HOMEs hold the only OAuth tokens — the same reason run
// spawns inject isolatedHomeEnv). This module picks the account and composes
// the spawn env exactly like the engine's per-run envFor, then reproduces the
// outcome handling the inline discovery callback in index.ts used to own.
// New code, not a port; the ModelCatalog contract it feeds is (models.ts).
// Distinct from src/host/discovery.ts, which is the conversation-id fallback.
import type { DiscoverFn } from './models.ts'
import type { AccountPoolManager } from './pool.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { GatewayConfig } from '../common/types.ts'
import { isolatedHomeEnv, proxyEnv, sanitizeChildEnv, startAgyProcess } from './runner.ts'

/**
 * Picks the account whose isolated HOME hosts the next `agy models` spawn.
 * MA5 eligibility is deliberately narrower than selection-time health: a
 * family cooldown is quota bookkeeping and `agy models` consumes no quota,
 * so only disabled and auth-quarantined (dead token) slots are skipped.
 * Cursor rotation rather than first-enabled spreads the per-HOME spawn
 * exposure across accounts and stops one dead-token HOME from wedging
 * discovery forever — the next cycle tries the next HOME.
 */
export function pickDiscoveryAccount(
  accounts: readonly ManagedAccount[],
  cursor: number,
): ManagedAccount | null {
  const eligible = accounts.filter((a) => a.enabled && !a.authRequired && typeof a.dir === 'string' && a.dir !== '')
  if (eligible.length === 0) return null
  return eligible[cursor % eligible.length] as ManagedAccount
}

// 4-key telemetry-off block, kept in lockstep with the engine's envFor
// (engine.ts envFor) by comment, not by import — run semantics stay frozen.
const TELEMETRY_OFF: Record<string, string> = {
  DO_NOT_TRACK: '1',
  DISABLE_TELEMETRY: '1',
  GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
  ANTIGRAVITY_DISABLE_TELEMETRY: '1',
}

export interface CatalogDiscoverDeps {
  /** Resolved per attempt through the shared bin cache (reinstalls picked up). */
  bin: () => string | null
  /** Prefix args before `models` — tests pass the fake-agy script path. */
  binArgs?: readonly string[]
  pool: AccountPoolManager
  getConfig: () => GatewayConfig
}

/**
 * Builds the DiscoverFn the ModelCatalog consumes. No eligible account →
 * spawns with the inherited process.env (legacy signed-out behavior for
 * zero-account deployments; the failure lands in catalog.lastError instead
 * of being invisible). With an account, HOME + proxy ride the account so
 * `agy models` sees the same credentials a real run would.
 */
export function makeCatalogDiscoverFn(deps: CatalogDiscoverDeps): DiscoverFn {
  let cursor = 0
  return async (signal) => {
    const bin = deps.bin()
    if (bin === null) throw new Error('agy binary not available for model discovery')
    const acc = pickDiscoveryAccount(deps.pool.getAccounts(), cursor)
    cursor += 1
    const cfg = deps.getConfig()
    const env: NodeJS.ProcessEnv = sanitizeChildEnv({
      ...process.env,
      ...(cfg.disableTelemetry ? TELEMETRY_OFF : {}),
      ...(acc !== null && acc.dir !== '' ? isolatedHomeEnv(acc.dir) : {}),
      ...(acc?.proxyUrl ? proxyEnv(acc.proxyUrl) : {}),
    })
    const run = startAgyProcess({
      bin,
      args: [...(deps.binArgs ?? []), 'models'],
      timeoutMs: 30_000,
      signal,
      env,
    })
    const out = await run.outcome
    if (out.code !== 0) {
      throw new Error(
        out.stderrTail.trim() !== '' ? out.stderrTail.trim() : `agy models exited with code ${out.code}`,
      )
    }
    return { stdout: out.stdout, stderr: out.stderrTail }
  }
}