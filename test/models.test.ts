// /v1/models routes (MA1–MA3): dual-shape listing, header sniffing, single
// model lookup, and Anthropic-style pagination — through the real
// ModelCatalog (fallback defs; discovery is not exercised here).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import {
  MODEL_CREATED,
  MODELS_PAGE_DEFAULT,
  MODELS_PAGE_MAX,
  paginateModels,
  toAnthropicEntries,
  toOpenAiEntries,
} from '../src/server/models-routes.ts'

let lastWorkDir: string | null = null

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const workDir = mkdtempSync(join(tmpdir(), 'agy-models-'))
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(workDir, 'sessions.json')),
    bin: () => null,
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
  })
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  lastWorkDir = workDir
  return { built, catalog }
}

afterEach(() => {
  rmSync(lastWorkDir ?? '', { recursive: true, force: true })
})

const FIVE = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({ id, name: id.toUpperCase(), efforts: null }))

describe('MA1: OpenAI list shape', () => {
  it('returns {object:list, data:[{id,object:model,created,owned_by}]} with unique ids', async () => {
    const { built } = makeServer()
    const res = await built.app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { object: string; data: Array<Record<string, unknown>> }
    expect(body.object).toBe('list')
    const ids = body.data.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of body.data) {
      expect(m).toEqual({ id: m.id, object: 'model', created: MODEL_CREATED, owned_by: 'antigravity' })
    }
    // The default fallback catalog carries the gemini/claude/gpt-oss lines.
    expect(ids).toContain('gemini-3.7-flash')
    expect(ids).toContain('claude-sonnet-4-6')
    await built.app.close()
  })

  it('requires auth when configured (x-api-key or Bearer both accepted)', async () => {
    const { built } = makeServer({ apiKey: 'sekrit' })
    expect((await built.app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401)
    expect((await built.app.inject({ method: 'GET', url: '/v1/models', headers: { 'x-api-key': 'sekrit' } })).statusCode).toBe(200)
    expect((await built.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer sekrit' } })).statusCode).toBe(200)
    await built.app.close()
  })
})

describe('header sniffing + dedicated path (MA4 half)', () => {
  it('anthropic-version header switches /v1/models to the Anthropic shape', async () => {
    const { built } = makeServer()
    const res = await built.app.inject({ method: 'GET', url: '/v1/models', headers: { 'anthropic-version': '2023-06-01' } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: Array<{ type?: string }> }
    expect(body.data[0]?.type).toBe('model')
    expect(body.data[0]).toHaveProperty('display_name')
    expect(body.data[0]).toHaveProperty('created_at')
    await built.app.close()
  })

  it('/v1/anthropic/models is always the Anthropic shape', async () => {
    const { built } = makeServer()
    const plain = await built.app.inject({ method: 'GET', url: '/v1/anthropic/models' })
    expect(plain.statusCode).toBe(200)
    const body = plain.json() as { data: Array<{ type?: string }> }
    expect(body.data[0]?.type).toBe('model')
    await built.app.close()
  })
})

describe('single model lookup', () => {
  it('GET /v1/models/:id returns the OpenAI object; unknown → 404 model_not_found', async () => {
    const { built } = makeServer()
    const ok = await built.app.inject({ method: 'GET', url: '/v1/models/gemini-3.7-flash' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ id: 'gemini-3.7-flash', object: 'model', created: MODEL_CREATED, owned_by: 'antigravity' })
    const missing = await built.app.inject({ method: 'GET', url: '/v1/models/no-such-model' })
    expect(missing.statusCode).toBe(404)
    const body = missing.json() as { error: { type: string; code: string } }
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.code).toBe('model_not_found')
    await built.app.close()
  })
})

describe('MA2: Anthropic pagination', () => {
  it('paginateModels defaults to 20 and caps at 1000', () => {
    expect(MODELS_PAGE_DEFAULT).toBe(20)
    expect(MODELS_PAGE_MAX).toBe(1000)
    const page = paginateModels(FIVE, {})
    expect(page.data).toHaveLength(5)
    expect(page.first_id).toBe('m1')
    expect(page.last_id).toBe('m5')
    expect(page.has_more).toBe(false)
    const limited = paginateModels(FIVE, { limit: 2 })
    expect(limited.data.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(limited.has_more).toBe(true)
    const capped = paginateModels(FIVE, { limit: 5000 })
    expect(capped.data).toHaveLength(5)
  })

  it('after_id / before_id slice the stable order; unknown anchors give empty pages', () => {
    const after = paginateModels(FIVE, { after_id: 'm2', limit: 2 })
    expect(after.data.map((m) => m.id)).toEqual(['m3', 'm4'])
    expect(after.first_id).toBe('m3')
    expect(after.has_more).toBe(true)
    // before_id ends BEFORE the anchor; the page window starts at the list
    // head, so the first `limit` entries before 'm4' are m1..m2.
    const before = paginateModels(FIVE, { before_id: 'm4', limit: 2 })
    expect(before.data.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(paginateModels(FIVE, { after_id: 'nope' }).data).toEqual([])
    expect(paginateModels(FIVE, { before_id: 'nope' }).data).toEqual([])
    expect(paginateModels(FIVE, { after_id: 'm4' }).data.map((m) => m.id)).toEqual(['m5'])
    expect(paginateModels(FIVE, { after_id: 'm4' }).has_more).toBe(false)
  })

  it('rejects non-positive limits with 400', () => {
    expect(() => paginateModels(FIVE, { limit: 0 })).toThrow(/positive integer/)
    expect(() => paginateModels(FIVE, { limit: -3 })).toThrow(/positive integer/)
  })

  it('end-to-end: /v1/anthropic/models honors limit and after_id', async () => {
    const { built } = makeServer()
    const p1 = await built.app.inject({ method: 'GET', url: '/v1/anthropic/models?limit=2' })
    const b1 = p1.json() as { data: Array<{ id: string }>; first_id: string; has_more: boolean }
    expect(b1.data).toHaveLength(2)
    expect(b1.has_more).toBe(true)
    const p2 = await built.app.inject({ method: 'GET', url: `/v1/anthropic/models?limit=2&after_id=${b1.data[1]?.id}` })
    const b2 = p2.json() as { data: Array<{ id: string }>; first_id: string }
    expect(b2.data[0]?.id).not.toBe(b1.data[0]?.id)
    expect(b2.first_id).not.toBe(b1.first_id)
    await built.app.close()
  })
})

describe('MA3: effort folding holds on both shapes', () => {
  it('folded gemini entries appear once; entries derive from the shared catalog', async () => {
    const { built, catalog } = makeServer()
    const res = await built.app.inject({ method: 'GET', url: '/v1/models' })
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)
    // The fallback defs carry bare ids (no -low/-medium/-high slugs), so no
    // duplicates: each id appears exactly once on both shapes.
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(catalog.get().models.map((m) => m.id))
    const an = await built.app.inject({ method: 'GET', url: '/v1/anthropic/models' })
    const anIds = (an.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)
    expect(anIds).toEqual(ids)
    expect(toOpenAiEntries(catalog.get().models)).toHaveLength(ids.length)
    expect(toAnthropicEntries(catalog.get().models)).toHaveLength(ids.length)
    await built.app.close()
  })
})
