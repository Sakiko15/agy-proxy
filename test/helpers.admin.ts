// Shared admin-suite harness (M4 extraction of the admin-api.test.ts setup):
// real subsystems on temp dirs; only the engine (no spawn) and the password
// verify are faked. Routes are exercised through built.app.inject().
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import { AdminEventBus } from '../src/server/events.ts'
import { openDb } from '../src/server/db.ts'
import { KeyStore } from '../src/server/key-store.ts'
import { UsageLedger } from '../src/server/usage-ledger.ts'
import { AdminSessionStore } from '../src/server/admin-session.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const dbs: string[] = []
const workDirs: string[] = []

afterEach(() => {
  for (const dir of dbs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* sqlite handles */ } }
  for (const dir of workDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* handles */ } }
  delete process.env.AGY_PROXY_CONVERSATIONS_DIR
})

export function makeAdminServer(cfgOverrides: Partial<GatewayConfig> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, adminPassword: 'drill-admin', ...cfgOverrides }
  const dir = mkdtempSync(join(tmpdir(), 'agy-admin-'))
  dbs.push(dir)
  const workDir = mkdtempSync(join(tmpdir(), 'agy-admin-w-'))
  workDirs.push(workDir)
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const db = openDb(join(dir, 't.db'))
  const keys = new KeyStore(db)
  const ledger = new UsageLedger(db, { flushIntervalMs: 50 })
  const sessions = new AdminSessionStore(db, { ttlMs: 60_000 })
  const pool = new AccountPoolManager(join(dir, 'accounts'))
  const events = new AdminEventBus({ getPool: () => pool.getPoolData(), debounceMs: 30 })
  pool.onChange(() => events.schedulePoolChange())
  const quota = new QuotaService(pool)
  const poolAuth = new PoolAuthFlow(pool, quota, () => {})
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(workDir, 'sessions.json')),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    retryDelay: async () => {}, // M5: failing runs retry once - keep tests fast (timing pinned in engine-retry.test)
  })
  const log = buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' })
  const built = buildServer({
    getConfig: () => cfg,
    engine,
    catalog,
    log,
    keys,
    ledger,
    admin: {
      getConfig: () => cfg,
      log,
      pool,
      quota,
      poolAuth,
      keys,
      ledger,
      sessions,
      catalog,
      events,
      verifyPassword: async (pw: string) => pw === 'drill-admin',
    },
  })
  return { built, keys, ledger, db, pool, poolAuth, events }
}

export type ServerRef = ReturnType<typeof makeAdminServer>['built']

export async function login(built: ServerRef, password = 'drill-admin') {
  const res = await built.app.inject({
    method: 'POST',
    url: '/admin/login',
    payload: { password },
    headers: { 'x-requested-with': 'test', 'content-type': 'application/json' },
  })
  const raw = res.headers['set-cookie']
  return { res, cookie: Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '') }
}

export function adminGet(built: ServerRef, url: string, cookie: string) {
  return built.app.inject({ method: 'GET', url, headers: { cookie } })
}

export function adminSend(
  built: ServerRef,
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
) {
  return built.app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      cookie,
      'x-requested-with': 'test',
    },
  })
}