// Pool-on-gateway drills (M3 DoD ③/④): real AgyEngine + real
// AccountPoolManager + fake-agy. a) hard rate limit on account A cools it
// down and the NEXT request auto-switches to account B (429 fail + switch —
// upstream semantics, user-approved); b) an all-cooling pool → 429 POOL_
// EXHAUSTED + retry-after + reset countdown; c) VALIDATION_REQUIRED → 403
// with the validation_url in the message and the account quarantined.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const dbs: string[] = []
const workDirs: string[] = []

afterEach(() => {
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_AGY_FAIL_HOME
  delete process.env.FAKE_AGY_ARGS_FILE
  delete process.env.FAKE_AGY_EXIT_CODE
  for (const dir of dbs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* handles */ } }
  for (const dir of workDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* fake-agy child */ } }
})

function makePoolServer(engineOverrides: Partial<Pick<EngineDeps, 'onRun'>> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000 }
  const dir = mkdtempSync(join(tmpdir(), 'agy-poolg-'))
  dbs.push(dir)
  const pool = new AccountPoolManager(join(dir, 'accounts'))
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const onRunCalls: Array<Parameters<NonNullable<EngineDeps['onRun']>>[0]> = []
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(dir, 'sessions.json')),
    pool,
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    onRun: (i) => { onRunCalls.push(i) },
    ...engineOverrides,
  })
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  return { built, pool, onRunCalls }
}

function chat(built: ReturnType<typeof makePoolServer>['built']) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] },
    headers: { 'content-type': 'application/json' },
  })
}

describe('DoD ③: hard rate limit → cooldown + next-request auto-switch', () => {
  it('request 1 fails + cools account A; request 2 succeeds on account B', async () => {
    const { built, pool, onRunCalls } = makePoolServer()
    const a = pool.createAccountSlot('alpha')
    const b = pool.createAccountSlot('beta')
    if (pool.getAccounts()[0]?.id === a.id) pool.reorderAccounts([a.id, b.id])
    else pool.reorderAccounts([b.id, a.id])
    const first = pool.getAccounts()[0]!
    const second = pool.getAccounts()[1]!

    // Only the FIRST account hard-fails (its isolated HOME matches).
    process.env.FAKE_AGY_FAIL_HOME = first.dir
    const res1 = await chat(built)
    expect(res1.statusCode).toBe(502) // hard rate limit classifies AGY_ERROR family
    // The hard signature cooled the account down.
    const cooled = pool.getAccount(first.id)
    expect(cooled?.cooldowns.google).toBeDefined()
    expect(cooled?.cooldowns.google?.reason ?? '').toContain('Resets in')
    expect(onRunCalls[0]?.accountId).toBe(first.id)
    expect(onRunCalls[0]?.ok).toBe(false)

    // Next request (distinct prompt — the 3s duplicate debounce lives per
    // sessionKey and would otherwise 429 the identical second ask) drains to
    // account B and succeeds.
    const res2 = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'please answer differently' }] },
      headers: { 'content-type': 'application/json' },
    })
    expect(res2.statusCode).toBe(200)
    // onRun fires at PROCESS EXIT, which lags the 200 response (the span cut
    // on a tool step ends the client stream early) — wait for the settle.
    await vi.waitFor(() => {
      expect(onRunCalls.some((c) => c.accountId === second.id && c.ok)).toBe(true)
    }, { timeout: 5_000, interval: 25 })
  })

  it('an exhausted pool answers 429 rate_limit_error + retry-after + reset countdown', async () => {
    const { built, pool } = makePoolServer()
    const a = pool.createAccountSlot('alpha')
    const b = pool.createAccountSlot('beta')
    // Both accounts enter cooldown via a hard rate-limit failure (as if the
    // upstream had served 429s for the whole family).
    pool.recordFailure(a.id, 'google', '429 RESOURCE_EXHAUSTED: quota exceeded Resets in 21m25s')
    pool.recordFailure(b.id, 'google', '429 RESOURCE_EXHAUSTED: quota exceeded Resets in 21m25s')

    process.env.FAKE_AGY_MODE = 'ok' // would succeed if any account were left
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    const body = res.json() as { error: { message: string; type: string; code: string } }
    expect(body.error.code).toBe('POOL_EXHAUSTED')
    expect(body.error.type).toBe('rate_limit_error')
    expect(body.error.message).toContain('earliest reset in')
  })
})

describe('DoD ④: upstream 403 VALIDATION_REQUIRED', () => {
  it('403 with the validation_url in the message; account quarantined', async () => {
    const { built, pool, onRunCalls } = makePoolServer()
    const a = pool.createAccountSlot('alpha')
    pool.reorderAccounts([a.id])

    process.env.FAKE_AGY_MODE = 'validation'
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    const body = res.json() as { error: { message: string; code: string } }
    expect(body.error.code).toBe('VALIDATION_REQUIRED')
    expect(body.error.message).toContain('VALIDATION_REQUIRED')
    expect(body.error.message).toContain('https://accounts.google.com/')

    const account = pool.getAccount(a.id)
    expect(account?.authRequired).toBe(true)
    expect(account?.authError ?? '').toContain('VALIDATION_REQUIRED')

    // The quarantined account no longer rotates: the next request exhausts.
    const next = await chat(built)
    expect(next.statusCode).toBe(429)
    expect(onRunCalls.some((c) => c.accountId === a.id)).toBe(true)
  })
})