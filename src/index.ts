// agy-proxy entry point: config loading, agy binary probe, server wiring.
// The engine layer (src/host) is ported from dsh-agy-link; the server layer
// (src/server) is new — Fastify service skeleton + OpenAI non-streaming
// route (charter §3/§4). M1 deliberately wires NO account pool, quota
// polling, or media sweep: the gateway starts empty (no pool = single
// logged-in system account) and images arrive in M2.
import { join } from 'node:path'
import { resolveConfig, dataDir, stateDir } from './common/config.ts'
import { resolveAgyBin, probeProcess, MIN_AGY_VERSION } from './host/runner.ts'
import { AgyEngine } from './host/engine.ts'
import { ModelCatalog } from './host/models.ts'
import { SessionStore } from './host/sessions.ts'
import { RunRegistry } from './host/recording.ts'
import { redactLine } from './host/diagnostics.ts'
import { buildLogger } from './server/logger.ts'
import { buildServer } from './server/app.ts'
import { GatewaySemaphore } from './server/semaphore.ts'
import { installShutdown } from './server/shutdown.ts'

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
  if (getConfig().apiKey === '') {
    log.warn('AGY_PROXY_API_KEY is not set — /v1/* endpoints are UNAUTHENTICATED; set a key before exposing this gateway')
  }

  const bin = await resolveAgyBin(getConfig().agyBin)
  if (bin === null) {
    // Unreachable after startup() unless the binary vanished in between.
    log.error('agy binary vanished between probe and wiring')
    process.exit(1)
  }
  const catalog = new ModelCatalog(
    async (signal) => {
      const probe = await probeProcess(bin, ['models'], 30_000, signal)
      if (!probe.ok) throw new Error(probe.error ?? 'agy models failed')
      return { stdout: 'version ' + (probe.version ?? '') + '\n', stderr: '' }
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
    bin: () => resolveAgyBin(getConfig().agyBin),
    acquire: () => sem.acquire(),
    runs,
    log: (m) => log.warn({ src: 'engine' }, redactLine(m)),
    onRun: (i) => log.info({ ...i }, 'agy run finished'),
  })

  const built = buildServer({ getConfig, engine, log })
  void catalog.refreshIfNeeded().catch(() => undefined)
  await built.app.listen({ port: getConfig().port, host: getConfig().host })
  log.info({ port: getConfig().port, host: getConfig().host }, 'agy-proxy listening')
  installShutdown(built, { log })
}

// Entry detection: direct `node dist/index.js` / `tsx src/index.ts` runs the
// server; imports (tests, programmatic use) stay inert.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e: unknown) => {
    console.error('startup failed:', e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
