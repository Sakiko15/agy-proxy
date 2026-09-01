// Static WebUI hosting (M4): @fastify/static per-file routes + SPA fallback
// in the not-found handler. The regression fence pins the M2/M3 contract —
// /v1/nope, /admin/nope and /healthz must be identical with and without a
// registered web root.
import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { makeAdminServer } from './helpers.admin.ts'

const fixture = resolve(import.meta.dirname, 'fixtures', 'web-dist')

const ENV_KEYS = ['AGY_PROXY_WEB_DIST'] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('no built frontend (JSON-only mode, M3 behavior)', () => {
  it('AGY_PROXY_WEB_DIST=none opts out; / falls through to the protocol 404 shape', async () => {
    process.env.AGY_PROXY_WEB_DIST = 'none'
    const { built } = makeAdminServer()
    const res = await built.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
    expect((res.json() as { error: { code: string } }).error.code).toBe('not_found')

    const healthz = await built.app.inject({ method: 'GET', url: '/healthz' })
    expect(healthz.statusCode).toBe(200)
  })
})

describe('with a registered web root', () => {
  it('/ serves index.html (text/html, no-store)', async () => {
    process.env.AGY_PROXY_WEB_DIST = fixture
    const { built } = makeAdminServer()
    const res = await built.app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-cache') // index refetches; assets carry the hashes
    expect(res.body).toContain('static fixture index')
  })

  it('hashed assets are served with immutable caching', async () => {
    process.env.AGY_PROXY_WEB_DIST = fixture
    const { built } = makeAdminServer()
    const res = await built.app.inject({ method: 'GET', url: '/assets/app-4f2b9c.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.body).toContain('fixture asset')
  })

  it('dot-free GET paths fall back to index.html (client routing)', async () => {
    process.env.AGY_PROXY_WEB_DIST = fixture
    const { built } = makeAdminServer()
    for (const url of ['/login', '/accounts', '/keys', '/usage', '/settings']) {
      const res = await built.app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(200)
      expect(res.headers['content-type'], url).toContain('text/html')
    }
  })

  it('dotted unknown paths do NOT serve the SPA (protocol 404)', async () => {
    process.env.AGY_PROXY_WEB_DIST = fixture
    const { built } = makeAdminServer()
    const res = await built.app.inject({ method: 'GET', url: '/missing-file.js' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('API 404/200 contract is byte-identical with a WebUI root present', async () => {
    process.env.AGY_PROXY_WEB_DIST = fixture
    const withWeb = makeAdminServer()
    delete process.env.AGY_PROXY_WEB_DIST
    const withoutWeb = makeAdminServer()

    for (const path of ['/healthz', '/v1/nope', '/admin/nope']) {
      const a = await withWeb.built.app.inject({ method: 'GET', url: path })
      const b = await withoutWeb.built.app.inject({ method: 'GET', url: path })
      expect(a.statusCode, path).toBe(b.statusCode)
      expect(a.body, path).toBe(b.body)
    }
    expect((await withWeb.built.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })
})