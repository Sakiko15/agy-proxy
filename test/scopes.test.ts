// Per-key model whitelist enforcement (M5): EngineDeps.getScopes resolves a
// key id to its allowed model ids; the engine rejects Err.MODEL_NOT_ALLOWED
// (403, both protocol tables) for any model it would actually SERVE — the
// check runs after fallback resolution. Root (keyId null) and an absent
// callback bypass.
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyEngine, type EngineCall, type EngineDeps, type EngineMessage } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { KeyStore, parseKeyScopes } from '../src/server/key-store.ts'
import { openDb } from '../src/server/db.ts'
import { errorStatus, anthropicStatusFor } from '../src/server/errors.ts'
import { Err, defaultConfig, type GatewayConfig } from '../src/common/types.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

function makeEngine(opts: {
  getScopes?: EngineDeps['getScopes']
  cfgOverrides?: Partial<GatewayConfig>
  pool?: AccountPoolManager
}): { engine: AgyEngine; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-scopes-'))
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(dir, 'convs')
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 5_000, ...opts.cfgOverrides }
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog: new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000),
    store: new SessionStore(join(dir, 'sessions.json')),
    ...(opts.pool !== undefined ? { pool: opts.pool } : {}),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => Promise.resolve(() => {}),
    runs: new RunRegistry(),
    retryDelay: async () => {},
    ...(opts.getScopes !== undefined ? { getScopes: opts.getScopes } : {}),
  })
  return { engine, dir }
}

function msg(role: 'user' | 'assistant', text: string): EngineMessage {
  return { role, text }
}

async function firstError(call: EngineCall, engine: AgyEngine): Promise<Error | undefined> {
  try {
    for await (const _ of engine.stream(call)) {
      // drain
    }
    return undefined
  } catch (err) {
    return err as Error
  }
}

describe('scopes enforcement (engine pre-spawn check on the served model)', () => {
  it('MAPPED: MODEL_NOT_ALLOWED is a 403 permission_error on both protocol tables', () => {
    expect(errorStatus(Err.MODEL_NOT_ALLOWED)).toEqual({ statusCode: 403, type: 'permission_error' })
    expect(anthropicStatusFor(Err.MODEL_NOT_ALLOWED, 'msg')).toEqual({ statusCode: 403, type: 'permission_error' })
  })

  it('no callback = feature off; a served turn completes', async () => {
    const { engine } = makeEngine({})
    process.env.FAKE_AGY_MODE = 'ok'
    let finished = false
    for await (const _ of engine.stream({ model: 'gemini-3.7-flash', messages: [msg('user', 'hi')] })) {
      void _
    }
    finished = true
    expect(finished).toBe(true)
    delete process.env.FAKE_AGY_MODE
  })

  it('a whitelisted key for a non-served model is rejected with MODEL_NOT_ALLOWED', async () => {
    const { engine } = makeEngine({ getScopes: (keyId) => (keyId === 'key_1' ? ['claude-sonnet-4-6'] : null) })
    const err = await firstError(
      { model: 'gemini-3.7-flash', messages: [msg('user', 'hi')], meta: { keyId: 'key_1' } },
      engine,
    )
    expect(err).toMatchObject({ code: Err.MODEL_NOT_ALLOWED })
    expect((err as { message?: string }).message).toContain('gemini-3.7-flash')
  })

  it('a key whose whitelist covers the served model passes; root key bypasses', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { engine } = makeEngine({
      getScopes: (keyId) => (keyId === null ? null : ['gemini-3.7-flash', 'gemini-3.6-flash']),
    })
    for await (const _ of engine.stream({ model: 'gemini-3.7-flash', messages: [msg('user', 'hi')], meta: { keyId: 'key_2' } })) {
      void _
    }
    // Root key (keyId null) bypasses even a restrictive callback for others:
    // the callback here would NOT have allowed gemini for a non-null id.
    const root = makeEngine({
      getScopes: (keyId) => (keyId === null ? null : ['claude-sonnet-4-6']),
    }).engine
    for await (const _ of root.stream({ model: 'gemini-3.7-flash', messages: [msg('user', 'hi')], meta: { keyId: null } })) {
      void _
    }
    delete process.env.FAKE_AGY_MODE
  })

  it('the fallback switch is covered: scopes constrain the SERVED model', async () => {
    // One google-family account; the request asks for a claude model whose
    // family is cooled down (a hard 429 on 'anthropic') → autoFallbackModel
    // redirects the request to a gemini slug, and the scopes check must then
    // judge the REDIRECTED model.
    const pool = new AccountPoolManager(join(mkdtempSync(join(tmpdir(), 'agy-scopes-pool-')), 'accounts'))
    process.env.FAKE_AGY_MODE = 'ok'
    const a = pool.createAccountSlot('fb')
    pool.recordFailure(a.id, 'anthropic', '429 RESOURCE_EXHAUSTED: quota exceeded Resets in 21m25s')
    const { engine } = makeEngine({
      pool,
      getScopes: (keyId) => (keyId === 'key_fb' ? ['claude-sonnet-4-6'] : null),
      cfgOverrides: { autoFallbackModel: true },
    })
    const err = await firstError(
      { model: 'claude-sonnet-4-6', messages: [msg('user', 'hi')], meta: { keyId: 'key_fb' } },
      engine,
    )
    expect(err).toMatchObject({ code: Err.MODEL_NOT_ALLOWED })
    expect((err as { message?: string }).message).toContain('gemini-3.5-flash')

    // The inverse: whitelisting the fallback slug serves the redirected call.
    const { engine: engine2 } = makeEngine({
      pool,
      getScopes: (keyId) => (keyId === 'key_fb' ? ['gemini-3.5-flash'] : null),
      cfgOverrides: { autoFallbackModel: true },
    })
    for await (const _ of engine2.stream({ model: 'claude-sonnet-4-6', messages: [msg('user', 'hi')], meta: { keyId: 'key_fb' } })) {
      void _
    }
    delete process.env.FAKE_AGY_MODE
  })
})

describe('parseKeyScopes + KeyStore.update({scopes})', () => {
  it('parses newline/comma/semicolon separated ids, trims, and treats empty as unrestricted', () => {
    expect(parseKeyScopes('gemini-3.7-flash,claude-sonnet-4-6\ngpt-oss-120b; gemini-3.5-flash')).toEqual([
      'gemini-3.7-flash',
      'claude-sonnet-4-6',
      'gpt-oss-120b',
      'gemini-3.5-flash',
    ])
    expect(parseKeyScopes('  gemini-3.7-flash  ')).toEqual(['gemini-3.7-flash'])
    expect(parseKeyScopes('')).toBe(null) // '' clears → unrestricted
    expect(parseKeyScopes('  ,,;\n')).toBe(null)
    expect(parseKeyScopes(null)).toBe(null)
    expect(parseKeyScopes(undefined)).toBe(null)
  })

  it('KeyStore.update patches and clears scopes without touching the other fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-scopes-ks-'))
    const db = openDb(join(dir, 'k.db'))
    const store = new KeyStore(db)
    const created = store.create({ name: 'scopes-key', dailyTokenLimit: 100 })
    const rec = store.update(created.id, { scopes: 'gemini-3.7-flash, gpt-oss-120b' })
    expect(rec?.scopes).toBe('gemini-3.7-flash, gpt-oss-120b')
    expect(rec?.dailyTokenLimit).toBe(100)
    // '' clears to NULL at rest; the hash column and prefix never move.
    const cleared = store.update(created.id, { scopes: '' })
    expect(cleared?.scopes).toBe(null)
    expect(created.plaintext.startsWith('sk-agy-')).toBe(true)
    expect(store.get(created.id)?.prefix).toBe(created.prefix)
    db.close()
  })
})