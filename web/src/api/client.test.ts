// API client contract: query building + the mandatory CSRF header.
import { describe, it, expect, afterEach } from 'vitest'
import { buildQuery, apiSend, apiGet, ApiError } from './client.ts'

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
})