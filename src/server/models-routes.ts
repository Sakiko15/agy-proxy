// Dual-shape /v1/models routes (charter §4.1, MA1-MA3): the OpenAI shape is
// the default on /v1/models; an anthropic-version header (or the dedicated
// /v1/anthropic/models path) returns the Anthropic list shape with
// after_id/before_id pagination. GET /v1/models/:id serves the OpenAI
// single-model object. All shapes derive from the shared ModelCatalog, so
// MA3 folding (gemini -low/-medium/-high → one entry) holds on both sides.
// New code, not a port.
import type { AppInstance } from './app.ts'
import type { ModelCatalog, CatalogEntry } from '../host/models.ts'
import { anthropicError, httpError } from './errors.ts'

export interface ModelRouteDeps {
  getConfig: () => { enabled: boolean }
  catalog: ModelCatalog
  authHook: (request: unknown, reply: unknown) => Promise<void>
}

export interface OpenAiModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface AnthropicModelEntry {
  id: string
  type: 'model'
  display_name: string
  created_at: string
}

/**
 * Fixed epoch (2026-01-01 UTC): the catalog has no per-model creation time
 * and a stable value keeps golden diffs deterministic.
 */
export const MODEL_CREATED = 1_767_225_600

/** Anthropic list pagination limit: default 20, capped at 1000 (models-list docs). */
export const MODELS_PAGE_DEFAULT = 20
export const MODELS_PAGE_MAX = 1000

export function toOpenAiEntries(models: readonly CatalogEntry[]): OpenAiModelEntry[] {
  return models.map((m) => ({ id: m.id, object: 'model' as const, created: MODEL_CREATED, owned_by: 'antigravity' }))
}

export function toAnthropicEntries(models: readonly CatalogEntry[]): AnthropicModelEntry[] {
  return models.map((m) => ({
    id: m.id,
    type: 'model' as const,
    display_name: m.name !== '' ? m.name : m.id,
    created_at: new Date(MODEL_CREATED * 1000).toISOString(),
  }))
}

/**
 * MA2 pagination over the catalog's stable order. after_id starts AFTER the
 * entry with that id; before_id ends BEFORE it; an unknown anchor id yields
 * an empty page (ids are opaque cursors).
 */
export function paginateModels<T extends { id: string }>(
  entries: readonly T[],
  query: { limit?: unknown; after_id?: unknown; before_id?: unknown },
): { data: T[]; first_id: string | null; last_id: string | null; has_more: boolean } {
  let limit = MODELS_PAGE_DEFAULT
  if (query.limit !== undefined) {
    const n = typeof query.limit === 'string' ? Number(query.limit) : query.limit
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw httpError(400, 'limit must be a positive integer', 'invalid_request_error', 'invalid_request')
    }
    limit = Math.min(n, MODELS_PAGE_MAX)
  }
  let start = 0
  let end = entries.length
  if (typeof query.after_id === 'string' && query.after_id !== '') {
    const idx = entries.findIndex((e) => e.id === query.after_id)
    start = idx === -1 ? entries.length : idx + 1
  }
  if (typeof query.before_id === 'string' && query.before_id !== '') {
    const idx = entries.findIndex((e) => e.id === query.before_id)
    end = idx === -1 ? 0 : idx
  }
  const page = entries.slice(start, start === 0 ? Math.min(end, limit) : Math.min(end, start + limit))
  const consumed = start === 0 ? page.length : start + page.length
  const hasMore = page.length > 0 ? consumed < end || end > start + page.length : false
  return {
    data: page,
    first_id: page[0]?.id ?? null,
    last_id: page[page.length - 1]?.id ?? null,
    has_more: hasMore || consumed < entries.length,
  }
}

export function registerModelRoutes(
  app: AppInstance,
  deps: { getConfig: () => { enabled: boolean }; catalog: ModelCatalog; authHook: (request: never, reply: never) => Promise<void> },
): void {
  const guard = (reply: { code: (n: number) => { send: (b: unknown) => void } }): boolean => {
    if (!deps.getConfig().enabled) {
      reply.code(503).send(anthropicError('api_error', 'gateway is disabled by config (enabled=false)'))
      return false
    }
    return true
  }

  const entries = () => deps.catalog.get().models

  // GET /v1/models — OpenAI shape by default; anthropic-version header or the
  // /v1/anthropic/models path selects the Anthropic shape.
  app.get('/v1/models', { preHandler: deps.authHook as never }, async (request, reply) => {
    if (!guard(reply as never)) return
    const wantsAnthropic = (request.headers['anthropic-version'] ?? '') !== ''
    if (wantsAnthropic) {
      const page = paginateModels(toAnthropicEntries(entries()), request.query as Record<string, unknown>)
      return reply.code(200).send(page)
    }
    return reply.code(200).send({ object: 'list', data: toOpenAiEntries(entries()) })
  })

  // Dedicated Anthropic-shaped path (Anthropic SDK base_url = host root).
  app.get('/v1/anthropic/models', { preHandler: deps.authHook as never }, async (request, reply) => {
    if (!guard(reply as never)) return
    const page = paginateModels(toAnthropicEntries(entries()), request.query as Record<string, unknown>)
    return reply.code(200).send(page)
  })

  // GET /v1/models/:id — OpenAI single-model object (charter §4.1).
  app.get('/v1/models/:id', { preHandler: deps.authHook as never }, async (request, reply) => {
    if (!guard(reply as never)) return
    const { id } = request.params as { id: string }
    const entry = entries().find((m) => m.id === id)
    if (entry === undefined) {
      void reply.code(404).send(httpError(404, `model '${id}' was not found`, 'invalid_request_error', 'model_not_found').body)
      return
    }
    return reply.code(200).send({ id: entry.id, object: 'model', created: MODEL_CREATED, owned_by: 'antigravity' })
  })
}
