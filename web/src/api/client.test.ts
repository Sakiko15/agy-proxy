// API client contract: query building + the mandatory CSRF header.
import { describe, it, expect, afterEach } from 'vitest'
import { buildQuery, apiSend, apiGet, api, ApiError } from './client.ts'

const FETCHED: { url: string; init: RequestInit }[] = []
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  FETCHED.length = 0
})

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    FETCHED.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('buildQuery', () => {
  it('omits empty values, encodes specials, keeps insertion order', () => {
    expect(buildQuery({ a: 1, b: undefined, c: 'x y', d: '', e: 'k&v' })).toBe('?a=1&c=x%20y&e=k%26v')
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ a: '', b: undefined })).toBe('')
  })
})

describe('apiSend', () => {
  it('always carries x-requested-with + credentials on mutations', async () => {
    mockFetch(200, { ok: true })
    await apiSend('PUT', '/admin/settings', { timeoutMs: 1 })
    const call = FETCHED[0]!
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-requested-with']).toBe('agy-proxy-webui')
    expect(headers['content-type']).toBe('application/json')
    expect(call.init.credentials).toBe('include')
    expect(call.init.body).toBe('{"timeoutMs":1}')
  })

  it('apiGet does NOT send the CSRF header (GET is not a mutation)', async () => {
    mockFetch(200, { ok: true, keys: [] })
    await apiGet('/admin/keys')
    const headers = FETCHED[0]!.init.headers as Record<string, string> | undefined
    expect(headers?.['x-requested-with']).toBeUndefined()
    expect(headers?.['content-type']).toBeUndefined()
  })

  it('non-JSON error bodies surface as ApiError with status', async () => {
    globalThis.fetch = (async (): Promise<Response> => new Response('<html>Bad Gateway</html>', { status: 502 })) as typeof fetch
    const err = await apiSend('POST', '/admin/login', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(502)
  })

  it('401 responses produce ApiError with the server message', async () => {
    mockFetch(401, { ok: false, error: 'unauthorized — POST /admin/login first' })
    const err = await apiGet('/admin/keys').catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(401)
    expect((err as ApiError).message).toContain('unauthorized')
  })

  it('patchKey carries the scopes patch verbatim — string sets, null clears (M5)', async () => {
    mockFetch(200, { ok: true })
    await api.patchKey('key_1', { scopes: 'gemini-3.7-flash, claude-sonnet-4-6' })
    expect(FETCHED[0]!.init.body).toBe('{"scopes":"gemini-3.7-flash, claude-sonnet-4-6"}')
    await api.patchKey('key_1', { scopes: null })
    expect(FETCHED[1]!.init.body).toBe('{"scopes":null}')
    // partial patches ride alongside other fields
    await api.patchKey('key_1', { dailyTokenLimit: 5, scopes: '' })
    expect(FETCHED[2]!.init.body).toBe('{"dailyTokenLimit":5,"scopes":""}')
  })

  it('poolMode posts the scheduling mode verbatim for both values', async () => {
    mockFetch(200, { ok: true })
    await api.poolMode('round-robin')
    expect(FETCHED[0]!.url).toBe('/admin/pool/mode')
    expect(FETCHED[0]!.init.method).toBe('POST')
    expect((FETCHED[0]!.init.headers as Record<string, string>)['x-requested-with']).toBe('agy-proxy-webui')
    expect(FETCHED[0]!.init.body).toBe('{"mode":"round-robin"}')
    await api.poolMode('sequential')
    expect(FETCHED[1]!.init.body).toBe('{"mode":"sequential"}')
  })

  it('catalogRefresh POSTs the catalog route with CSRF + empty body', async () => {
    mockFetch(200, { ok: true, catalog: { source: 'discovered', count: 3, discoveredAt: 1, lastError: null } })
    const out = await api.catalogRefresh()
    expect(out.catalog.source).toBe('discovered')
    expect(FETCHED[0]!.url).toBe('/admin/catalog/refresh')
    expect(FETCHED[0]!.init.method).toBe('POST')
    expect((FETCHED[0]!.init.headers as Record<string, string>)['x-requested-with']).toBe('agy-proxy-webui')
    expect(FETCHED[0]!.init.body).toBe('{}')
  })

  it('revealKeySecret GETs without CSRF; rotateKey POSTs the rotate route with CSRF + empty body', async () => {
    mockFetch(200, { ok: true, plaintext: 'sk-agy-x' })
    await api.revealKeySecret('key_1')
    expect(FETCHED[0]!.url).toBe('/admin/keys/key_1/secret')
    expect(FETCHED[0]!.init.method).toBeUndefined() // apiGet leaves GET implicit
    expect((FETCHED[0]!.init.headers as Record<string, string> | undefined)?.['x-requested-with']).toBeUndefined()

    mockFetch(200, { ok: true, key: { id: 'key_1' }, plaintext: 'sk-agy-y' })
    await api.rotateKey('key_1')
    expect(FETCHED[1]!.url).toBe('/admin/keys/key_1/rotate')
    expect(FETCHED[1]!.init.method).toBe('POST')
    expect((FETCHED[1]!.init.headers as Record<string, string>)['x-requested-with']).toBe('agy-proxy-webui')
    expect(FETCHED[1]!.init.body).toBe('{}')
  })
})