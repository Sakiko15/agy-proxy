// Admin catalog surface (MA5): /admin/status catalog detail (source/count/
// discoveredAt/lastError) and the guarded POST /admin/catalog/refresh —
// forceRefresh never rejects, so the endpoint answers 200 with the resulting
// state even when discovery fails.
import { describe, it, expect } from 'vitest'
import { defaultConfig } from '../src/common/types.ts'
import type { DiscoverFn } from '../src/host/models.ts'
import { makeAdminServer, login, adminGet, adminSend, type ServerRef } from './helpers.admin.ts'

const cfg = defaultConfig()

function okDiscover(ids: string[]): DiscoverFn {
  return async () => ({ stdout: JSON.stringify(ids.map((id) => ({ id, display_name: id }))), stderr: '' })
}
function failDiscover(): DiscoverFn {
  return async () => {
    throw new Error('Please sign in')
  }
}

async function loggedInServer(discover?: DiscoverFn): Promise<{ built: ServerRef; cookie: string }> {
  const s = makeAdminServer({}, { discover })
  const { res, cookie } = await login(s.built)
  expect(res.statusCode).toBe(200)
  return { built: s.built, cookie }
}

describe('GET /admin/status catalog detail', () => {
  it('reports the untouched fallback catalog with null lastError', async () => {
    const { built, cookie } = await loggedInServer()
    const res = await adminGet(built, '/admin/status', cookie)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { catalog: { source: string; count: number; discoveredAt: number; lastError: string | null } }
    expect(body.catalog.source).toBe('fallback')
    expect(body.catalog.count).toBe(cfg.fallbackModels.length)
    expect(body.catalog.discoveredAt).toBe(0)
    expect(body.catalog.lastError).toBeNull()
  })
})

describe('POST /admin/catalog/refresh', () => {
  it('succeeding discovery: 200 with the discovered state; status reflects it', async () => {
    const { built, cookie } = await loggedInServer(okDiscover(['m1', 'm2', 'm3']))
    const res = await adminSend(built, 'POST', '/admin/catalog/refresh', cookie, {})
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; catalog: { source: string; count: number; discoveredAt: number; lastError: string | null } }
    expect(body.ok).toBe(true)
    expect(body.catalog.source).toBe('discovered')
    expect(body.catalog.count).toBe(3)
    expect(body.catalog.discoveredAt).toBeGreaterThan(0)
    expect(body.catalog.lastError).toBeNull()
    const status = await adminGet(built, '/admin/status', cookie)
    expect((status.json() as { catalog: { source: string; count: number } }).catalog).toMatchObject({ source: 'discovered', count: 3 })
  })

  it('failing discovery: still 200, fallback state, lastError populated', async () => {
    const { built, cookie } = await loggedInServer(failDiscover())
    const res = await adminSend(built, 'POST', '/admin/catalog/refresh', cookie, {})
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; catalog: { source: string; lastError: string | null } }
    expect(body.ok).toBe(true)
    expect(body.catalog.source).toBe('fallback')
    expect(body.catalog.lastError).toContain('Please sign in')
  })

  it('guard chain: no session → 401; session without the CSRF header → 403', async () => {
    const { built, cookie } = await loggedInServer()
    expect((await built.app.inject({ method: 'POST', url: '/admin/catalog/refresh' })).statusCode).toBe(401)
    const csrfless = await built.app.inject({
      method: 'POST',
      url: '/admin/catalog/refresh',
      headers: { cookie },
    })
    expect(csrfless.statusCode).toBe(403)
    const ok = await adminSend(built, 'POST', '/admin/catalog/refresh', cookie, {})
    expect(ok.statusCode).toBe(200)
  })
})