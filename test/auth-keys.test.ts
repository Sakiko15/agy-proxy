// Auth hook v2 (M3): managed keys + bootstrap root key. MA4 matrix on both
// protocol bodies (401 missing/unknown texts unchanged, 403 disabled, 429 RPM
// + Retry-After, 429 daily tokens with quota type + reset time named), and
// MA5's budget source (usage ledger) feeding daily-token rejection PRE-ENGINE
// (a rejected request never reaches the engine). count_tokens carries the
// same auth hook and sits under /v1/messages → its error bodies are the
// ANTHROPIC shape (isAnthropicPath matches the path prefix), so the OpenAI
// body shape comes from /v1/chat/completions below.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import { openDb, checkpointAndClose } from '../src/server/db.ts'
import { KeyStore } from '../src/server/key-store.ts'
import { UsageLedger } from '../src/server/usage-ledger.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const dbs: string[] = []
let lastDb: { db: ReturnType<typeof openDb>; keys: KeyStore; ledger: UsageLedger } | null = null

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, withStore = true, wireOnRun = false) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const dir = mkdtempSync(join(tmpdir(), 'agy-auth-'))
  dbs.push(dir)
  const db = openDb(join(dir, 't.db'))
  const keys = new KeyStore(db)
  const ledger = new UsageLedger(db, { flushIntervalMs: 50 })
  lastDb = { db, keys, ledger }
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(dir, 'sessions.json')),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    retryDelay: async () => {}, // M5: failing runs retry once - keep tests fast (timing pinned in engine-retry.test)
    // index.ts's production settle-hook wiring, ledger legs only (S-H1
    // regression coverage needs rows actually booked by real requests).
    ...(wireOnRun ? {
      onRun: (i: Parameters<NonNullable<EngineDeps['onRun']>>[0]) => {
        if (!i.final) return
        const meta = (i.meta ?? {}) as { reqId?: unknown; keyId?: unknown; protocol?: unknown }
        ledger.record({
          requestId: typeof meta.reqId === 'string' ? meta.reqId : '',
          keyId: typeof meta.keyId === 'string' ? meta.keyId : null,
          accountId: i.accountId ?? null,
          model: i.providerModel,
          family: i.family ?? 'unknown',
          protocol: meta.protocol === 'anthropic' ? 'anthropic' : 'openai',
          promptTokens: i.usage?.inputTokens ?? 0,
          completionTokens: i.usage?.outputTokens ?? 0,
          status: i.code,
        })
      },
    } : {}),
    ...({} as Partial<EngineDeps>),
  })
  const built = buildServer({
    getConfig: () => cfg,
    engine,
    catalog,
    log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }),
    ...(withStore ? { keys, ledger } : {}),
  })
  return { built, keys, ledger, db }
}

/** count_tokens shares the /v1/messages path prefix → ANTHROPIC body errors. */
function countTokens(built: { app: ReturnType<typeof buildServer>['app'] }, headers: Record<string, string> = {}) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/messages/count_tokens',
    payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hello world' }] },
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** chat.completions errors come in the OpenAI body shape. */
function chat(built: { app: ReturnType<typeof buildServer>['app'] }, headers: Record<string, string> = {}) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hello world' }] },
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  for (const dir of dbs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ledger timer / WAL handles */ }
  }
  lastDb = null
})

describe('MA4 matrix: bootstrap root key unchanged', () => {
  it('root key passes with a store present; missing/invalid texts identical', async () => {
    const { built } = makeServer({ apiKey: 'sekrit' })
    const ok = await countTokens(built, { authorization: 'Bearer sekrit' })
    expect(ok.statusCode).toBe(200)
    const missing = await countTokens(built)
    expect(missing.statusCode).toBe(401)
    // count_tokens is an Anthropic path → Anthropic 401 body.
    expect(missing.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error', message: 'Missing API key. Pass it as `Authorization: Bearer <key>` or `x-api-key: <key>`.' },
    })
    const wrong = await countTokens(built, { authorization: 'Bearer nope' })
    expect(wrong.statusCode).toBe(401)
    // OpenAI surface keeps the code form.
    const wrongChat = await chat(built, { authorization: 'Bearer nope' })
    expect(wrongChat.statusCode).toBe(401)
    expect((wrongChat.json() as { error: { code: string } }).error.code).toBe('invalid_api_key')
  })
})

describe('MA4 matrix: managed keys', () => {
  it('valid managed key passes; unknown → 401 (same text); disabled → 403 both bodies', async () => {
    const { built, keys } = makeServer({ apiKey: 'root-key' })
    const created = keys.create({ name: 'ci' })

    const ok = await countTokens(built, { authorization: `Bearer ${created.plaintext}` })
    expect(ok.statusCode).toBe(200)

    const unknown = await countTokens(built, { authorization: 'Bearer sk-agy-unknown-unknown-unknown-00' })
    expect(unknown.statusCode).toBe(401)
    expect((unknown.json() as { error: { message: string } }).error.message).toBe('Invalid API key provided.')

    keys.update(created.id, { disabled: true })
    const disabled = await countTokens(built, { authorization: `Bearer ${created.plaintext}` })
    expect(disabled.statusCode).toBe(403)
    expect(disabled.json()).toMatchObject({ type: 'error', error: { type: 'permission_error' } })
    expect(String((disabled.json() as { error: { message: string } }).error.message)).toContain(created.prefix)

    // OpenAI body shape for the same verdict.
    const oaiDisabled = await chat(built, { 'x-api-key': created.plaintext })
    expect(oaiDisabled.statusCode).toBe(403)
    expect(oaiDisabled.json()).toMatchObject({ error: { type: 'permission_error', code: 'key_disabled' } })
  })

  it('root key still passes when managed keys exist', async () => {
    const { built, keys } = makeServer({ apiKey: 'root-key' })
    keys.create()
    const ok = await countTokens(built, { 'x-api-key': 'root-key' })
    expect(ok.statusCode).toBe(200)
  })
})

describe('MA4/MA5: per-key rate limits (429 + Retry-After)', () => {
  it('rpm=1 → second request 429 with retry-after header naming the RPM limit', async () => {
    const { built, keys } = makeServer({})
    const created = keys.create({ name: 'rpm', rpmLimit: 1 })
    const first = await countTokens(built, { authorization: `Bearer ${created.plaintext}` })
    expect(first.statusCode).toBe(200)
    const second = await countTokens(built, { authorization: `Bearer ${created.plaintext}` })
    expect(second.statusCode).toBe(429)
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    const body = second.json() as { type: string; error: { message: string; type: string } }
    expect(body.type).toBe('error') // count_tokens → Anthropic body
    expect(body.error.type).toBe('rate_limit_error')
    expect(body.error.message).toContain('rpm=1')
  })

  it('chat surface formats the same RPM rejection in the OpenAI body', async () => {
    const { built, keys } = makeServer({})
    const created = keys.create({ name: 'rpm-oai', rpmLimit: 1 })
    await chat(built, { authorization: `Bearer ${created.plaintext}` })
    const second = await chat(built, { authorization: `Bearer ${created.plaintext}` })
    expect(second.statusCode).toBe(429)
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    const body = second.json() as { error: { message: string; type: string; code: string } }
    expect(body.error.message).toContain('rpm=1')
    expect(body.error.code).toBe('rate_limit_exceeded')
  })

  it('dailyTokenLimit rejects pre-engine with the quota type and reset time in the message', async () => {
    const { built, keys, ledger, db } = makeServer({})
    const created = keys.create({ name: 'budget', dailyTokenLimit: 10 })
    ledger.record({ requestId: 'seed-1', keyId: created.id, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 6, completionTokens: 5, status: 'OK' })
    await ledger.flush()
    const res = await countTokens(built, { authorization: `Bearer ${created.plaintext}` })
    expect(res.statusCode).toBe(429)
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    const body = res.json() as { error: { message: string } }
    expect(body.error.message).toContain('daily_token_limit')
    expect(body.error.message).toContain('11 of 10')
    // ledger.close() flushes + checkpoints + closes — nothing further to do.
    await ledger.close().catch(() => undefined)
  })

  it('a different key is unaffected by the first key\'s budget', async () => {
    const { built, keys, ledger } = makeServer({})
    const limited = keys.create({ name: 'limited', dailyTokenLimit: 5 })
    const other = keys.create({ name: 'other' })
    ledger.record({ requestId: 'seed-1', keyId: limited.id, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 100, completionTokens: 0, status: 'OK' })
    await ledger.flush()
    const rejected = await countTokens(built, { authorization: `Bearer ${limited.plaintext}` })
    expect(rejected.statusCode).toBe(429)
    const passes = await countTokens(built, { authorization: `Bearer ${other.plaintext}` })
    expect(passes.statusCode).toBe(200)
  })
})

describe('S-H1 regression: the ledger keys on the server request id', () => {
  it('replaying one client x-request-id books a row per request; the client id never becomes the DB key', async () => {
    // Pre-fix, withCallMeta adopted the client header as the ledger request
    // id: this loop booked exactly ONE row (INSERT OR IGNORE swallowed every
    // replay), so a caller could zero its day budget by replaying one id.
    const { built, ledger, db } = makeServer({ apiKey: 'root-key' }, true, true)
    const headers = { authorization: 'Bearer root-key', 'x-request-id': 'replay-me' }
    const a = await chat(built, headers)
    const b = await chat(built, headers)
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    // Settlement books the row after the response ends (documented onRun
    // timing), so poll instead of assuming it has landed by the first flush.
    await vi.waitFor(async () => {
      await ledger.flush()
      const rows = db.prepare('SELECT request_id FROM usage').all() as Array<{ request_id: string }>
      expect(rows.length).toBe(2)
      for (const row of rows) expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(rows.some((row) => row.request_id === 'replay-me')).toBe(false)
    })
    await ledger.close().catch(() => undefined)
  })
})