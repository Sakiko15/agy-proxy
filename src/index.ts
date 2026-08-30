// agy-proxy entry point (M0 skeleton): config loading, agy binary probe,
// dormant-state startup. Service wiring (Fastify, engine, pool) lands in M1/M2.
import { resolveConfig, dataDir } from './common/config.ts'
import { resolveAgyBin, probeProcess, MIN_AGY_VERSION } from './host/runner.ts'
import { Err } from './common/types.ts'

export { resolveConfig, dataDir } from './common/config.ts'
export { Err } from './common/types.ts'

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

// CLI entry: `node dist/index.js` prints the startup report and exits 0.
// The HTTP server wiring replaces this in M1.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  startup()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    })
    .catch((e: unknown) => {
      console.error('startup failed:', e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}
