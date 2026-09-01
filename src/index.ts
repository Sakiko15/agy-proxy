// agy-proxy entry point: config loading, agy binary probe, server wiring.
// The engine layer (src/host) is ported from dsh-agy-link; the server layer
// (src/server) is new — Fastify service skeleton + OpenAI non-streaming
// route (charter §3/§4). M3 wires the full stack: SQLite (keys/ledger/admin
// sessions), the account pool + quota poller + paste-URL login flow, and a
// ledger-writing settle hook — the ported-but-dormant upstream subsystems.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveConfig, dataDir, stateDir } from './common/config.ts'
import { resolveAgyBin, probeProcess, startAgyProcess, MIN_AGY_VERSION } from './host/runner.ts'
import { AgyEngine } from './host/engine.ts'
import { ModelCatalog } from './host/models.ts'
import { SessionStore } from './host/sessions.ts'
import { RunRegistry } from './host/recording.ts'
import { AccountPoolManager } from './host/pool.ts'
import { QuotaService } from './host/quota.ts'
import { PoolAuthFlow } from './host/pool-auth.ts'
import { defaultMediaDir } from './host/media.ts'
import { startMediaSweeper } from './host/media-sweeper.ts'
import { redactLine } from './host/diagnostics.ts'
import { buildLogger } from './server/logger.ts'
import { buildServer } from './server/app.ts'
import { GatewaySemaphore } from './server/semaphore.ts'
import { installShutdown } from './server/shutdown.ts'
import { AdminEventBus } from './server/events.ts'
import { openDb } from './server/db.ts'
import { KeyStore } from './server/key-store.ts'
import { UsageLedger } from './server/usage-ledger.ts'
import { AdminSessionStore, ensureAdminPassword, verifyAdminPassword } from './server/admin-session.ts'

export { resolveConfig, dataDir } from './common/config.ts'

export interface StartupReport {
  ok: boolean
  /** Set when the gateway cannot serve: reason is surfaced on the admin UI. */
  dormantReason?: string
  agyBin?: string
  agyVersion?: string
  dataDir: string
}

export async function startup(): Promise<StartupReport> {
  const cfg = resolveConfig()
  const report: StartupReport = { ok: false, dataDir: dataDir() }

  if (!cfg.enabled) {
    report.dormantReason = 'disabled by config (enabled=false)'
    return report
  }

  const bin = await resolveAgyBin(cfg.agyBin)
  if (!bin) {
    report.dormantReason =
      'agy binary not found — install the official CLI (https://antigravity.google/cli) or set AGY_PROXY_BIN'
    return report
  }
  report.agyBin = bin

  const probe = await probeProcess(bin, ['--version'])
  if (!probe.ok) {
    report.dormantReason = `agy --version failed: ${probe.error ?? 'unknown error'}`
    return report
  }
  report.agyVersion = probe.version
  if (probe.version && compareVersions(probe.version, MIN_AGY_VERSION) < 0) {
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

async function main(): Promise<void> {
  const log = buildLogger()
  const report = await startup()
  if (!report.ok) {
    log.error({ ...report }, report.dormantReason ?? 'startup failed')
    process.exit(1)
  }
  log.info({ agyBin: report.agyBin, agyVersion: report.agyVersion, dataDir: report.dataDir }, 'agy probe ok')

  const getConfig = () => resolveConfig()

  // ---- SQLite storage (keys / usage ledger / admin sessions) ----
  const dbPath = getConfig().dbPath !== '' ? getConfig().dbPath : join(dataDir(), 'agy-proxy.db')
  const db = openDb(dbPath)
  const keys = new KeyStore(db)
  const ledger = new UsageLedger(db, { flushIntervalMs: 1_000, log: (m) => log.warn(m) })
  const sessions = new AdminSessionStore(db, { ttlMs: getConfig().adminSessionTtlMs })
  await ensureAdminPassword(db, getConfig, log)

  const keyCount = keys.count()
  if (getConfig().apiKey === '' && keyCount === 0) {
    log.warn('no API keys configured — /v1/* endpoints are UNAUTHENTICATED; set AGY_PROXY_API_KEY or create keys via /admin')
  } else if (keyCount === 0) {
    log.info('auth = bootstrap env key only (no managed keys yet — create via /admin/keys)')
  }

  // ---- account pool + quota + login flow (ported upstream subsystems) ----
  const pool = new AccountPoolManager()
  const quota = new QuotaService(pool)
  const poolAuth = new PoolAuthFlow(pool, quota, (m) => log.warn({ src: 'pool-auth' }, redactLine(m)))
  pool.sweepStaleStaging()
  pool.sweepOldLogs(getConfig().logRetentionDays)

  // ---- admin event bus (M4): /admin/events SSE. Run events share the
  // ledger row's fields (both fed from the onRun hook below); pool snapshots
  // are debounced off the pool mutation hook. ----
  const bus = new AdminEventBus({ getPool: () => pool.getPoolData() })
  pool.onChange(() => bus.schedulePoolChange())

  const bin = await resolveAgyBin(getConfig().agyBin)
  if (bin === null) {
    // Unreachable after startup() unless the binary vanished in between.
    log.error('agy binary vanished between probe and wiring')
    process.exit(1)
  }
  const catalog = new ModelCatalog(
    async (signal) => {
      // probeProcess only exposes the parsed --version string; discovery
      // needs the raw `agy models` stdout for parseModelsOutput.
      const run = startAgyProcess({ bin, args: ['models'], timeoutMs: 30_000, signal })
      const out = await run.outcome
      if (out.code !== 0) throw new Error(out.stderrTail.trim() !== '' ? out.stderrTail.trim() : `agy models exited with code ${out.code}`)
      return { stdout: out.stdout, stderr: out.stderrTail }
    },
    getConfig().fallbackModels,
    getConfig().modelsCacheTtlMs,
  )
  const store = new SessionStore(join(stateDir(), 'sessions.json'))
  const runs = new RunRegistry()
  const sem = new GatewaySemaphore(
    () => getConfig().maxConcurrent,
    () => getConfig().maxQueueDepth,
  )
  const engine = new AgyEngine({
    getConfig,
    catalog,
    store,
    pool,
    bin: () => resolveAgyBin(getConfig().agyBin),
    acquire: () => sem.acquire(),
    runs,
    log: (m) => log.warn({ src: 'engine' }, redactLine(m)),
    onRun: (i) => {
      // Enriched settle hook (one per actual agy spawn — continuations do not
      // re-fire): the ledger row is the request-id-idempotent accounting.
      log.info(
        { ok: i.ok, code: i.code, durationMs: i.durationMs, model: i.model, accountId: i.accountId },
        i.ok ? 'agy run finished' : 'agy run failed',
      )
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
  void catalog.refreshIfNeeded().catch(() => undefined)
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

  // Media sweeper (M5): staged request images live on the volume until the
  // TTL prunes them — the same dir resolution the engine's stager uses.
  const mediaSweeper = startMediaSweeper(
    getConfig().mediaDir !== '' ? getConfig().mediaDir : defaultMediaDir(stateDir()),
    getConfig().mediaTtlMs,
    3_600_000,
    (m) => log.info({ src: 'media-sweeper' }, redactLine(m)),
  )

  installShutdown(built, {
    log,
    teardown: async () => {
      clearTimeout(bootRefresh)
      clearInterval(poller)
      mediaSweeper.stop()
      bus.closeAll() // ends hijacked /admin/events streams — app.close() does not
      await poolAuth.cancel().catch(() => undefined)
      await ledger.close().catch(() => undefined) // flush → WAL checkpoint → close
    },
  })
}

// Entry detection: direct `node dist/index.js` / `tsx src/index.ts` runs the
// server; imports (tests, programmatic use) stay inert.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e: unknown) => {
    console.error('startup failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
