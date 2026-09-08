// agy-proxy entry point: config loading, agy binary probe, server wiring.
// The engine layer (src/host) is ported from dsh-agy-link; the server layer
// (src/server) is new — Fastify service skeleton + OpenAI non-streaming
// route (charter §3/§4). M3 wires the full stack: SQLite (keys/ledger/admin
// sessions), the account pool + quota poller + paste-URL login flow, and a
// ledger-writing settle hook — the ported-but-dormant upstream subsystems.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveConfig, dataDir, stateDir } from './common/config.ts'
import { resolveAgyBin, probeProcess, MIN_AGY_VERSION, createBinCache, sanitizeChildEnv } from './host/runner.ts'
import { AgyEngine } from './host/engine.ts'
import { ModelCatalog } from './host/models.ts'
import { SessionStore } from './host/sessions.ts'
import { RunRegistry } from './host/recording.ts'
import { AccountPoolManager } from './host/pool.ts'
import { QuotaService } from './host/quota.ts'
import { PoolAuthFlow } from './host/pool-auth.ts'
import { defaultMediaDir } from './host/media.ts'
import { startMediaSweeper } from './host/media-sweeper.ts'
import { makeCatalogDiscoverFn, pickDiscoveryAccount } from './host/catalog-discovery.ts'
import { startCatalogPoller } from './host/catalog-poller.ts'
import { redactLine } from './host/diagnostics.ts'
import { buildLogger } from './server/logger.ts'
import { buildServer } from './server/app.ts'
import { poolWithQuotaErrors } from './server/admin-api.ts'
import { GatewaySemaphore } from './server/semaphore.ts'
import { installShutdown } from './server/shutdown.ts'
import { AdminEventBus } from './server/events.ts'
import { openDb } from './server/db.ts'
import { KeyStore, loadOrCreateMasterKey } from './server/key-store.ts'
import { UsageLedger } from './server/usage-ledger.ts'
import { AdminSessionStore, ensureAdminPassword, verifyAdminPassword } from './server/admin-session.ts'

export { resolveConfig, dataDir } from './common/config.ts'

export interface StartupReport {
  ok: boolean
  /** B4/S3: why startup did not reach ready. 'disabled' (enabled=false) is
   *  the one kind that still boots: the gateway listens and serves the
   *  runtime-disabled 503s on /v1/* plus /healthz + /admin + the WebUI, so
   *  an operator can flip enabled back on without a crashlooping container.
   *  Every binary failure kind exits 1 — without agy there is nothing to
   *  serve, and the fast failure is what makes a misconfigured deploy loud. */
  kind: 'ready' | 'disabled' | 'binary-missing' | 'binary-probe-failed' | 'binary-too-old'
  /** Set when the gateway cannot serve: reason is surfaced on the admin UI. */
  dormantReason?: string
  agyBin?: string
  agyVersion?: string
  dataDir: string
}

export async function startup(): Promise<StartupReport> {
  const cfg = resolveConfig()
  const report: StartupReport = { ok: false, kind: 'ready', dataDir: dataDir() }

  if (!cfg.enabled) {
    report.kind = 'disabled'
    report.dormantReason = 'disabled by config (enabled=false)'
    return report
  }

  const bin = await resolveAgyBin(cfg.agyBin)
  if (!bin) {
    report.kind = 'binary-missing'
    report.dormantReason =
      'agy binary not found — install the official CLI (https://antigravity.google/cli) or set AGY_PROXY_BIN'
    return report
  }
  report.agyBin = bin

  const probe = await probeProcess(bin, ['--version'])
  if (!probe.ok) {
    report.kind = 'binary-probe-failed'
    report.dormantReason = `agy --version failed: ${probe.error ?? 'unknown error'}`
    return report
  }
  report.agyVersion = probe.version
  if (probe.version && compareVersions(probe.version, MIN_AGY_VERSION) < 0) {
    report.kind = 'binary-too-old'
    report.dormantReason = `agy ${probe.version} is too old (minimum ${MIN_AGY_VERSION}) — upgrade the official CLI`
    return report
  }

  report.ok = true
  return report
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0)
  const pb = b.split('.').map((x) => Number(x) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** NDJSON process-metrics ticker for the soak harness (M5): `{"debug":"metrics",
 *  rss, handles, uptime}` on stdout every `intervalMs`; intervalMs <= 0 or NaN
 *  keeps it off. The handle count uses the same read the doctor report uses. */
export function startDebugMetrics(intervalMs: number): { stop: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { stop: () => {} }
  const emit = (): void => {
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? -1
    process.stdout.write(
      JSON.stringify({ debug: 'metrics', rss: process.memoryUsage().rss, handles, uptime: Math.round(process.uptime()) }) + '\n',
    )
  }
  emit()
  const timer = setInterval(emit, Math.max(250, intervalMs))
  timer.unref()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}

async function main(): Promise<void> {
  const log = buildLogger()
  const report = await startup()
  if (report.kind !== 'ready' && report.kind !== 'disabled') {
    log.error({ ...report }, report.dormantReason ?? 'startup failed')
    process.exit(1)
  }
  // B4/S3 (user-approved failure-path change): enabled=false now DEGRADES to
  // a listening gateway instead of exit 1. /v1/* answers the existing
  // runtime-disabled 503 shape (runtime.enabled=false), /healthz and the
  // admin/WebUI stay up, and flipping enabled back on takes effect live —
  // no supervisor fighting a crashlooping container. Binary failures still
  // exit 1: without agy there is nothing to serve.
  if (report.kind === 'disabled') {
    log.warn({ reason: report.dormantReason }, 'gateway disabled — listening in 503 mode; /healthz + /admin + WebUI stay up')
  }
  log.info({ agyBin: report.agyBin, agyVersion: report.agyVersion, dataDir: report.dataDir }, 'agy probe ok')

  const getConfig = () => resolveConfig()

  // Code-review #5/#12: startup() short-circuits before any binary work when
  // disabled, so a live-enable through runtime-overrides would otherwise skip
  // the MIN_AGY_VERSION gate entirely and every upstream poller would stay
  // disarmed forever (they were cleared at boot). Probe the binary here —
  // with a sanitized env per the A-M1 spawn-site rule; the gateway's own
  // AGY_PROXY_* variables must never reach an agy child — warn without
  // exiting on failure, and gate the pollers on the outcome.
  let disabledBin: string | null = null
  let binaryHealthy = report.kind === 'ready'
  if (report.kind === 'disabled') {
    disabledBin = await resolveAgyBin(getConfig().agyBin)
    if (disabledBin === null) {
      log.warn('disabled boot: agy binary not found — background pollers stay off until the official CLI is installed')
    } else {
      const probe = await probeProcess(disabledBin, ['--version'], 30_000, undefined, sanitizeChildEnv(process.env))
      if (!probe.ok) {
        log.warn(`disabled boot: agy --version failed (${probe.error ?? 'unknown error'}) — background pollers stay off`)
      } else if (probe.version && compareVersions(probe.version, MIN_AGY_VERSION) < 0) {
        log.warn(`disabled boot: agy ${probe.version} is too old (minimum ${MIN_AGY_VERSION}) — background pollers stay off until the CLI is upgraded`)
      } else {
        binaryHealthy = true
      }
    }
  }

  // ---- SQLite storage (keys / usage ledger / admin sessions) ----
  const dbPath = getConfig().dbPath !== '' ? getConfig().dbPath : join(dataDir(), 'agy-proxy.db')
  const db = openDb(dbPath)
  // Volume-local sidecar master key (keys-enc.key): enables the reversible
  // secret storage behind the WebUI copy/regenerate affordances.
  const keys = new KeyStore(db, loadOrCreateMasterKey(dataDir()))
  const ledger = new UsageLedger(db, { flushIntervalMs: 1_000, log: (m) => log.warn(m) })
  // S1c: process-level net. The engine's guarded regions (S1a/S1b) close the
  // known escape hatches; this converts any residual stray throw/rejection
  // from an unobservable hard-crash into an observable one: log verbatim,
  // land the ledger buffer once (flush()'s synchronous insertBatch completes
  // before exit — WAL+FULL keeps rows durable), then exit 1. The in-process
  // state after an uncaught exception is untrustworthy for a credential-
  // holding gateway, so we exit rather than keep serving; docker
  // restart: unless-stopped turns that into a clean recovery.
  const crashToExit = (source: string, err: unknown): void => {
    log.error({ err: err instanceof Error ? (err.stack ?? err.message) : String(err) }, `${source} — flushing usage ledger and exiting`)
    try {
      void ledger.flush().catch(() => undefined)
    } catch {
      // a poisoned ledger must not break the exit path
    }
    process.exit(1)
  }
  process.on('uncaughtException', (err) => crashToExit('uncaughtException', err))
  process.on('unhandledRejection', (reason) => crashToExit('unhandledRejection', reason))
  const sessions = new AdminSessionStore(db, { ttlMs: getConfig().adminSessionTtlMs })
  await ensureAdminPassword(db, getConfig, log)

  const keyCount = keys.count()
  if (getConfig().apiKey === '' && keyCount === 0) {
    log.warn('no API keys configured — /v1/* endpoints are UNAUTHENTICATED; set AGY_PROXY_API_KEY or create keys via /admin')
  } else if (keyCount === 0) {
    log.info('auth = bootstrap env key only (no managed keys yet — create via /admin/keys)')
  }

  // ---- account pool + quota + login flow (ported upstream subsystems) ----
  // B4/S4: the pool's corrupt-file quarantine and throttled persist warnings
  // ride the log seam instead of vanishing into console silence.
  const pool = new AccountPoolManager(undefined, (m) => log.warn({ src: 'pool' }, redactLine(m)))
  const quota = new QuotaService(pool)
  const poolAuth = new PoolAuthFlow(pool, quota, (m) => log.warn({ src: 'pool-auth' }, redactLine(m)))
  pool.sweepStaleStaging()
  pool.sweepOldLogs(getConfig().logRetentionDays)
  // B4/S8: the usage retention prune also runs once at boot (the hourly
  // housekeeper below owns it afterwards); 0 = keep every row forever.
  if (getConfig().usageRetentionDays > 0) ledger.pruneOlderThan(getConfig().usageRetentionDays)

  // ---- admin event bus (M4): /admin/events SSE. Run events share the
  // ledger row's fields (both fed from the onRun hook below); pool snapshots
  // are debounced off the pool mutation hook. ----
  const bus = new AdminEventBus({
    // F12: SSE pool snapshots carry each account's last quota-refresh error
    // (same merge as GET /admin/pool) so the cards never disagree between
    // the snapshot and the REST path.
    getPool: () => poolWithQuotaErrors(quota, pool.getPoolData()),
  })
  pool.onChange(() => bus.schedulePoolChange())

  // Code-review #2: in ready mode this re-resolution is the vanish guard; in
  // disabled mode the probe block above already resolved (or warned about)
  // the binary, and a missing one must keep degrading — never exit.
  const bin = report.kind === 'ready' ? await resolveAgyBin(getConfig().agyBin) : disabledBin
  if (bin === null && report.kind === 'ready') {
    // Unreachable after startup() unless the binary vanished in between.
    log.error('agy binary vanished between probe and wiring')
    process.exit(1)
  }
  // A-M1: the per-spawn bin resolution used to rescan every PATH dir
  // synchronously on each request; the cache memoizes it and the engine's
  // invalidateBin drops it after any failed attempt (retry finds a
  // (re)installed binary — same seam semantics, one scan per healthy run).
  const binCache = createBinCache(() => resolveAgyBin(getConfig().agyBin))
  const catalog = new ModelCatalog(
    // MA5: discovery spawns `agy models` inside a signed-in pool account's
    // isolated HOME — the account HOMEs hold the only OAuth credentials, and
    // the previous inline callback ran signed-out under the container HOME,
    // so discovery failed and the gateway stayed on the fallback list forever.
    // Zero-account deployments keep the legacy signed-out spawn; its failure
    // now lands in catalog.lastError (dashboard-visible) instead of silence.
    makeCatalogDiscoverFn({ bin: () => binCache.resolve(), pool, getConfig }),
    getConfig().fallbackModels,
    getConfig().modelsCacheTtlMs,
  )
  const store = new SessionStore(join(stateDir(), 'sessions.json'), (m) =>
    log.warn({ src: 'sessions' }, redactLine(m)),
  )
  // B4/S6: capacity as a supplier — maxConcurrent is runtime-writable, and a
  // number captured here would go stale after a hot admin resize.
  const runs = new RunRegistry(() => Math.max(8, getConfig().maxConcurrent + 2))
  const sem = new GatewaySemaphore(
    () => getConfig().maxConcurrent,
    () => getConfig().maxQueueDepth,
  )
  const engine = new AgyEngine({
    getConfig,
    catalog,
    store,
    pool,
    bin: () => binCache.resolve(),
    invalidateBin: binCache.invalidate,
    // B3/P4: the call's AbortSignal rides into acquire — parked waiters are
    // rejected on disconnect instead of pinning a queue position.
    acquire: (signal) => sem.acquire(signal),
    runs,
    // Per-key model whitelist (M5): resolved per call from the keys table.
    // Root key (null) and unknown ids stay unrestricted — the root key is a
    // charter red line. B3/P9: served from the key-store's parsed-scope
    // cache instead of a row fetch + parse per request.
    getScopes: (keyId) => (keyId === null ? null : keys.scopesOf(keyId)),
    log: (m) => log.warn({ src: 'engine' }, redactLine(m)),
    onRun: (i) => {
      // Enriched settle hook (one per actual agy spawn attempt — continuations
      // do not re-fire). Per-attempt: the pino log; the ledger row + SSE event
      // are final-gated: the ledger's INSERT OR IGNORE is first-wins, so a
      // retried attempt's successful usage must be the row that books.
      log.info(
        { ok: i.ok, code: i.code, attempt: i.attempt, final: i.final, durationMs: i.durationMs, model: i.model, accountId: i.accountId },
        i.ok ? 'agy run finished' : 'agy run failed',
      )
      if (!i.final) return
      const meta = (i.meta ?? {}) as { reqId?: unknown; keyId?: unknown; protocol?: unknown }
      const reqId = typeof meta.reqId === 'string' ? meta.reqId : randomUUID()
      const keyId = typeof meta.keyId === 'string' ? meta.keyId : null
      const protocol = meta.protocol === 'anthropic' ? ('anthropic' as const) : ('openai' as const)
      ledger.record({
        requestId: reqId,
        keyId,
        accountId: i.accountId ?? null,
        model: i.providerModel,
        family: i.family ?? 'unknown',
        protocol,
        promptTokens: i.usage?.inputTokens ?? 0,
        completionTokens: i.usage?.outputTokens ?? 0,
        ...(i.usage?.reasoningTokens !== undefined ? { reasoningTokens: i.usage.reasoningTokens } : {}),
        ...(i.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: i.usage.cacheReadTokens } : {}),
        status: i.code,
        durationMs: i.durationMs,
        // terminal failure text for the audit column (schema v2, truncated at
        // 500 by the ledger)
        ...(i.failureMessage !== undefined && i.failureMessage !== '' ? { errorText: i.failureMessage } : {}),
      })
      // The SSE event mirrors the ledger row (same source hook) so the
      // dashboard can never disagree with the audited accounting.
      bus.publishRun({
        ok: i.ok,
        status: i.code,
        durationMs: i.durationMs,
        model: i.providerModel,
        ...(i.family !== undefined ? { family: i.family } : {}),
        ...(i.conversationId !== undefined ? { conversationId: i.conversationId } : {}),
        accountId: i.accountId ?? null,
        keyId,
        protocol,
        reqId,
        usage:
          i.usage !== null
            ? {
                promptTokens: i.usage.inputTokens,
                completionTokens: i.usage.outputTokens,
                ...(i.usage.reasoningTokens !== undefined ? { reasoningTokens: i.usage.reasoningTokens } : {}),
                ...(i.usage.cacheReadTokens !== undefined ? { cacheReadTokens: i.usage.cacheReadTokens } : {}),
              }
            : null,
      })
    },
  })

  const built = buildServer({
    getConfig,
    engine,
    catalog,
    log,
    keys,
    ledger,
    admin: {
      getConfig,
      log,
      pool,
      quota,
      poolAuth,
      keys,
      ledger,
      sessions,
      catalog,
      events: bus,
      verifyPassword: (pw) => verifyAdminPassword(db, pw),
    },
  })
  // Code-review #5: the pollers ride binaryHealthy, not `ready`. A disabled
  // boot with a healthy binary keeps quota + catalog refreshed in the
  // background, so flipping enabled back on (runtime-overrides) is live
  // immediately; a disabled boot with a broken/missing binary keeps its warn
  // and stays quiet — there is nothing to discover or refresh, and each
  // upstream spawn would just burn a timeout.
  const pollersArmed = binaryHealthy
  if (pollersArmed) void catalog.refreshIfNeeded().catch(() => undefined)
  await built.app.listen({ port: getConfig().port, host: getConfig().host })
  log.info({ port: getConfig().port, host: getConfig().host }, 'agy-proxy listening')

  // Quota poller (upstream dsh-agy-link pattern): a boot refresh shortly
  // after listen, then the configured interval (clamped >= 60s in config).
  const bootRefresh = setTimeout(() => {
    void quota.refreshAllQuotas().catch(() => undefined)
  }, 5_000)
  bootRefresh.unref()
  const poller = setInterval(() => {
    void quota.refreshAllQuotas().catch(() => undefined)
  }, Math.max(60_000, getConfig().quotaPollIntervalMs))
  poller.unref()
  if (!pollersArmed) {
    clearTimeout(bootRefresh)
    clearInterval(poller)
  }

  // Media sweeper (M5): staged request images live on the volume until the
  // TTL prunes them — the same dir resolution the engine's stager uses.
  const mediaSweeper = startMediaSweeper(
    getConfig().mediaDir !== '' ? getConfig().mediaDir : defaultMediaDir(stateDir()),
    getConfig().mediaTtlMs,
    3_600_000,
    (m) => log.info({ src: 'media-sweeper' }, redactLine(m)),
  )

  // Catalog refresh poller (MA5): drives the ModelCatalog TTL — stale-while-
  // revalidate only happens if something calls refreshIfNeeded, which used to
  // be the boot call alone (TTL was dead code; charter §7 unrealized). The
  // tick is skipped entirely while no eligible account exists, so zero-account
  // deployments spawn nothing here; lastError text is upstream stderr, so the
  // free-form log site redacts like every other one.
  const catalogPoller = startCatalogPoller({
    catalog,
    canDiscover: () => pickDiscoveryAccount(pool.getAccounts(), 0) !== null,
    log: {
      warn: (m) => log.warn({ src: 'catalog' }, redactLine(m)),
      info: (m) => log.info({ src: 'catalog' }, redactLine(m)),
      debug: (m) => log.debug({ src: 'catalog' }, redactLine(m)),
    },
  })
  if (!pollersArmed) catalogPoller.stop() // no healthy binary — no upstream spawns

  // Soak observability (M5): raw process metrics for the harness — one NDJSON
  // line per tick on stdout, deliberately NOT through pino (the harness
  // greps for the `"debug":"metrics"` marker). Off by default.
  const metricsTimer = startDebugMetrics(getConfig().debugMetricsMs)

  // B4/S8: one hourly housekeeping timer. Pool log sweeps used to run only
  // at boot; usage retention (default 0 = keep forever) prunes when an
  // operator opts in. unref'd so it never holds the process; cleared in
  // teardown.
  const housekeeper = setInterval(() => {
    pool.sweepOldLogs(getConfig().logRetentionDays)
    const days = getConfig().usageRetentionDays
    if (days > 0) {
      const pruned = ledger.pruneOlderThan(days)
      if (pruned > 0) log.info({ pruned }, 'usage retention prune ran')
    }
  }, 3_600_000)
  housekeeper.unref()

  installShutdown(
    { app: built.app, inFlight: built.inFlight, server: built.app.server },
    {
      log,
      graceMs: getConfig().shutdownGraceMs, // S2: ops-tunable drain window (default 25s < compose 40s)
      // B-H1: end the hijacked /admin/events streams BEFORE app.close() — a
      // live admin SSE client parks its connection past Fastify's close and
      // used to hang the whole sequence until docker's SIGKILL skipped the
      // ledger flush + WAL checkpoint. Idempotent (the teardown call below is
      // a no-op when preClose already ran).
      // S2: flush() has no await before its insertBatch, so this synchronous
      // call lands the 1s-buffered rows before app.close() even starts — a
      // close that hangs past grace (docker SIGKILL) can no longer lose them.
      preClose: () => {
        bus.closeAll()
        void ledger.flush()
      },
      teardown: async () => {
        clearTimeout(bootRefresh)
        clearInterval(poller)
        clearInterval(housekeeper) // B4/S8
        catalogPoller.stop()
        metricsTimer.stop()
        mediaSweeper.stop()
        bus.closeAll() // ends hijacked /admin/events streams — app.close() does not
        pool.flush() // write out a pending debounced hot-path persist (S-M8)
        store.flush() // land the sessions store's debounced persist (B2/P5)
        keys.flushTouch() // land debounced last_used_at refreshes (B-M2)
        await poolAuth.cancel().catch(() => undefined)
        await ledger.close().catch(() => undefined) // flush → WAL checkpoint → close
      },
    },
  )
}

// Entry detection: direct `node dist/index.js` / `tsx src/index.ts` runs the
// server; imports (tests, programmatic use) stay inert.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e: unknown) => {
    console.error('startup failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
