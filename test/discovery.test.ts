// Discovery path end-to-end (MA5): makeCatalogDiscoverFn spawns `agy models`
// through the fake-agy upstream inside a pool account's isolated HOME; the
// env contract (HOME/GEMINI_CLI_HOME/USERPROFILE/proxy vars) is pinned via
// FAKE_AGY_ENV_FILE — the account HOMEs hold the only OAuth credentials, so
// a discovery spawn that misses them is the deployed-instance failure shape.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../src/common/types.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { AgyEngine } from '../src/host/engine.ts'
import { ModelCatalog, type CatalogEntry } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { makeCatalogDiscoverFn, pickDiscoveryAccount } from '../src/host/catalog-discovery.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

let lastBase: string | null = null
let lastWorkDir: string | null = null
const savedEnv: Record<string, string | undefined> = {}

function snapshotEnv(): void {
  for (const k of ['FAKE_AGY_MODELS', 'FAKE_AGY_ENV_FILE']) savedEnv[k] = process.env[k]
}
function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function makeFixture(): { base: string; envFile: string; pool: AccountPoolManager } {
  const base = mkdtempSync(join(tmpdir(), 'agy-discovery-'))
  lastBase = base
  const envFile = join(base, 'env.ndjson')
  process.env.FAKE_AGY_ENV_FILE = envFile
  const pool = new AccountPoolManager(join(base, 'accounts'))
  return { base, envFile, pool }
}

function recordedEnvLines(envFile: string): Array<Record<string, string>> {
  const text = readFileSync(envFile, 'utf8').trim()
  if (text === '') return []
  return text.split('\n').map((l) => JSON.parse(l) as Record<string, string>)
}

afterEach(() => {
  restoreEnv()
  if (lastWorkDir !== null) {
    try { rmSync(lastWorkDir, { recursive: true, force: true }) } catch { /* handles */ }
    lastWorkDir = null
  }
  if (lastBase !== null) {
    try { rmSync(lastBase, { recursive: true, force: true }) } catch { /* handles */ }
    lastBase = null
  }
})

function entry(models: readonly CatalogEntry[], id: string): CatalogEntry {
  const found = models.find((m) => m.id === id)
  expect(found, `catalog entry ${id}`).toBeDefined()
  return found as CatalogEntry
}

describe('discovery end-to-end via fake-agy', () => {
  it('JSON mode: success turns the catalog discovered and folds the gemini pair', async () => {
    snapshotEnv()
    delete process.env.FAKE_AGY_MODELS
    const { envFile, pool } = makeFixture()
    const acc = pool.createAccountSlot('a')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    const after = await catalog.forceRefresh()
    expect(after.source).toBe('discovered')
    expect(entry(after.models, 'gemini-3-6-flash').efforts).toEqual(['high'])
    expect(entry(after.models, 'claude-sonnet-4-6').efforts).toBeNull()
    // The spawn rode the account HOME.
    const lines = recordedEnvLines(envFile)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.HOME).toBe(acc.dir)
    expect(lines[0]?.GEMINI_CLI_HOME).toBe(join(acc.dir, '.gemini'))
    if (process.platform === 'win32') expect(lines[0]?.USERPROFILE).toBe(acc.dir)
  })

  it('text mode: the two-column path parses the same way', async () => {
    snapshotEnv()
    process.env.FAKE_AGY_MODELS = 'text'
    const { pool } = makeFixture()
    pool.createAccountSlot('a')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    const after = await catalog.forceRefresh()
    expect(after.source).toBe('discovered')
    expect(entry(after.models, 'gemini-3-6-flash').efforts).toEqual(['high'])
    expect(entry(after.models, 'claude-sonnet-4-6').efforts).toBeNull()
  })

  it('spawn env: account proxy variables ride the spawn only when configured', async () => {
    snapshotEnv()
    delete process.env.FAKE_AGY_MODELS
    const { envFile, pool } = makeFixture()
    const acc = pool.createAccountSlot('a')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    await catalog.forceRefresh()
    expect(recordedEnvLines(envFile)[0]?.HTTPS_PROXY).toBeUndefined()
    expect(pool.setAccountProxy(acc.id, 'http://127.0.0.1:7890')).toBe(true)
    await catalog.forceRefresh()
    const second = recordedEnvLines(envFile)[1]
    expect(second?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(second?.ALL_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('spawn env sanitization: gateway AGY_PROXY_* secrets never reach the discovery spawn', async () => {
    snapshotEnv()
    delete process.env.FAKE_AGY_MODELS
    const { envFile, pool } = makeFixture()
    pool.createAccountSlot('a')
    const savedKey = process.env.AGY_PROXY_API_KEY
    const savedPwd = process.env.AGY_PROXY_ADMIN_PASSWORD
    process.env.AGY_PROXY_API_KEY = 'sk-agy-under-test'
    process.env.AGY_PROXY_ADMIN_PASSWORD = 'admin-pass-under-test'
    try {
      const cfg = defaultConfig()
      const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
      const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
      const after = await catalog.forceRefresh()
      expect(after.source).toBe('discovered')
    } finally {
      if (savedKey === undefined) delete process.env.AGY_PROXY_API_KEY
      else process.env.AGY_PROXY_API_KEY = savedKey
      if (savedPwd === undefined) delete process.env.AGY_PROXY_ADMIN_PASSWORD
      else process.env.AGY_PROXY_ADMIN_PASSWORD = savedPwd
    }
    const lines = recordedEnvLines(envFile)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.HOME).toBeDefined() // sanity: the record line exists
    expect(lines[0]?.AGY_PROXY_API_KEY).toBeUndefined()
    expect(lines[0]?.AGY_PROXY_ADMIN_PASSWORD).toBeUndefined()
  })

  it('rotation: two eligible accounts see alternating HOMEs across refreshes', async () => {
    snapshotEnv()
    delete process.env.FAKE_AGY_MODELS
    const { envFile, pool } = makeFixture()
    const a = pool.createAccountSlot('a')
    const b = pool.createAccountSlot('b')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    await catalog.forceRefresh()
    await catalog.forceRefresh()
    const lines = recordedEnvLines(envFile)
    expect(lines).toHaveLength(2)
    const homes = new Set(lines.map((l) => l.HOME))
    expect(homes.has(a.dir)).toBe(true)
    expect(homes.has(b.dir)).toBe(true)
    expect(homes.size).toBe(2)
  })

  it('zero accounts: the legacy signed-out spawn inherits the parent env', async () => {
    snapshotEnv()
    delete process.env.FAKE_AGY_MODELS
    const { envFile, pool } = makeFixture()
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    const after = await catalog.forceRefresh()
    expect(after.source).toBe('discovered')
    const line = recordedEnvLines(envFile)[0]
    expect(line?.GEMINI_CLI_HOME).toBeUndefined()
    expect(line?.HOME ?? undefined).toBe(process.env.HOME ?? undefined)
  })

  it('failure: non-zero exit keeps the fallback list and records lastError', async () => {
    snapshotEnv()
    process.env.FAKE_AGY_MODELS = 'fail'
    const { pool } = makeFixture()
    pool.createAccountSlot('a')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    const after = await catalog.forceRefresh()
    expect(after.source).toBe('fallback')
    expect(after.models.map((m) => m.id)).toEqual(cfg.fallbackModels.map((d) => d.id))
    expect(after.lastError).toContain('Please sign in')
  })

  it('turnover: fallback → discovered flips the served /v1/models list', async () => {
    snapshotEnv()
    process.env.FAKE_AGY_MODELS = 'fail'
    const { base, pool } = makeFixture()
    pool.createAccountSlot('a')
    const cfg = defaultConfig()
    const discover = makeCatalogDiscoverFn({ bin: () => process.execPath, binArgs: [fakeScript], pool, getConfig: () => cfg })
    const catalog = new ModelCatalog(discover, cfg.fallbackModels, cfg.modelsCacheTtlMs)
    const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
    const engine = new AgyEngine({
      getConfig: () => cfg,
      catalog,
      store: new SessionStore(join(base, 'sessions.json')),
      bin: () => null,
      acquire: () => sem.acquire(),
      runs: new RunRegistry(),
      retryDelay: async () => {},
    })
    const workDir = mkdtempSync(join(tmpdir(), 'agy-discovery-w-'))
    lastWorkDir = workDir
    process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
    const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
    try {
      const modelsUrl = built.app.inject({ method: 'GET', url: '/v1/models' })
      const failed = await catalog.forceRefresh()
      expect(failed.source).toBe('fallback')
      let body = (await modelsUrl).json() as { data: Array<{ id: string }> }
      expect(body.data.map((m) => m.id)).toContain('gemini-3.8-flash')

      delete process.env.FAKE_AGY_MODELS
      const recovered = await catalog.forceRefresh()
      expect(recovered.source).toBe('discovered')
      expect(recovered.lastError).toBeUndefined()
      const res = await built.app.inject({ method: 'GET', url: '/v1/models' })
      body = res.json() as { data: Array<{ id: string }> }
      const ids = body.data.map((m) => m.id)
      expect(ids).toContain('gemini-3-6-flash')
      expect(ids).toContain('claude-sonnet-4-6')
      expect(ids).not.toContain('gemini-3.8-flash')
      await built.app.close()
    } catch (err) {
      await built.app.close()
      throw err
    }
  })
})

describe('pickDiscoveryAccount', () => {
  it('skips disabled and auth-quarantined slots but not cooldowns', () => {
    const acc = (over: Partial<Parameters<typeof pickDiscoveryAccount>[0][number]>) => ({
      id: 'x',
      alias: 'x',
      dir: '/tmp/x',
      enabled: true,
      createdAt: 0,
      cooldowns: {},
      quotas: {},
      ...over,
    })
    const accounts = [
      acc({ id: 'disabled', enabled: false }),
      acc({ id: 'quarantined', authRequired: true }),
      acc({ id: 'cooled', cooldowns: { google: { cooldownUntil: Date.now() + 60_000, reason: '429', consecutiveFailures: 1 } } }),
      acc({ id: 'ok' }),
    ]
    expect(pickDiscoveryAccount(accounts, 0)?.id).toBe('cooled')
    expect(pickDiscoveryAccount(accounts, 1)?.id).toBe('ok')
    expect(pickDiscoveryAccount(accounts, 2)?.id).toBe('cooled')
    expect(pickDiscoveryAccount(accounts.filter((a) => a.enabled === false), 0)).toBeNull()
  })
})