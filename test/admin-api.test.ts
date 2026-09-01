// Admin API (M3): session guard, CSRF header, CIDR allowlist, keys lifecycle
// (plaintext exactly once), pool routes against a real AccountPoolManager,
// the paste-URL auth-flow routes (auto/manual tolerated — port 51121 may be
// busy), and the QR route states. DoD ① partial + charter §10 security rows.
import { describe, it, expect } from 'vitest'
import { makeAdminServer, login, adminGet, adminSend } from './helpers.admin.ts'

describe('admin session + guards (charter §10)', () => {
  it('login sets an httpOnly SameSite=Lax cookie; wrong password → 401', async () => {
    const { built } = makeAdminServer()
    const { res, cookie } = await login(built)
    expect(res.statusCode).toBe(200)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const bad = await login(built, 'not-it')
    expect(bad.res.statusCode).toBe(401)
  })

  it('/admin/* without a session → 401; a valid cookie passes', async () => {
    const { built } = makeAdminServer()
    const denied = await adminGet(built, '/admin/pool', '')
    expect(denied.statusCode).toBe(401)
    const { cookie } = await login(built)
    const ok = await adminGet(built, '/admin/pool', cookie)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ok: true })
  })

  it('mutating routes without x-requested-with → 403 csrf', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    // Body must parse (the CSRF guard sits after body parsing), so send '{}'.
    const res = await built.app.inject({
      method: 'POST',
      url: '/admin/pool/auth/cancel',
      payload: {},
      headers: { cookie, 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toContain('x-requested-with')
  })

  it('adminAllowCidr denies out-of-range client IPs (403 before the session check)', async () => {
    const { built } = makeAdminServer({ adminAllowCidr: '10.9.9.0/24' })
    const blocked = await adminGet(built, '/admin/pool', '')
    expect(blocked.statusCode).toBe(403)
    expect((blocked.json() as { error: string }).error).toContain('allowlist')
  })

  it('logout revokes the session', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    await adminSend(built, 'POST', '/admin/logout', cookie)
    const after = await adminGet(built, '/admin/pool', cookie)
    expect(after.statusCode).toBe(401)
  })

  it('/admin/status carries count-only key info and today usage (no key material)', async () => {
    const { built, keys } = makeAdminServer()
    const created = keys.create({ name: 'x' })
    try {
      const { cookie } = await login(built)
      const status = await adminGet(built, '/admin/status', cookie)
      expect(status.statusCode).toBe(200)
      const body = status.json() as { keys: { count: number }; gateway: { permissionMode: string } }
      expect(body.keys.count).toBe(1)
      expect(body.gateway.permissionMode).toBe('plan')
      expect(JSON.stringify(status.json())).not.toContain(created.plaintext)
    } finally {
      void created
    }
  })
})

describe('keys lifecycle over the admin API (DoD ⑤)', () => {
  it('create returns plaintext exactly once; disable; delete', async () => {
    const { built, keys } = makeAdminServer()
    const { cookie } = await login(built)
    const created = await adminSend(built, 'POST', '/admin/keys', cookie, { name: 'ci', dailyTokenLimit: 100, rpmLimit: 10 })
    expect(created.statusCode).toBe(201)
    const body = created.json() as { key: { id: string; prefix: string }; plaintext: string }
    expect(body.plaintext).toMatch(/^sk-agy-/)
    expect(body.key.prefix).toBe(body.plaintext.slice(0, 8))

    // The list endpoint must not carry the plaintext, and creating a second
    // key must not echo the first one's plaintext (明文仅一次).
    const listed = await adminGet(built, '/admin/keys', cookie)
    expect(JSON.stringify(listed.json())).not.toContain(body.plaintext)
    await adminSend(built, 'POST', '/admin/keys', cookie, { name: 'two' })
    const listedAgain = await adminGet(built, '/admin/keys', cookie)
    expect(JSON.stringify(listedAgain.json())).not.toContain(body.plaintext)
    expect((listedAgain.json() as { keys: unknown[] }).keys).toHaveLength(2)

    const disabled = await adminSend(built, 'PATCH', `/admin/keys/${body.key.id}`, cookie, { disabled: true })
    expect((disabled.json() as { key: { disabledAt: number | null } }).key.disabledAt).not.toBeNull()

    const removed = await adminSend(built, 'DELETE', `/admin/keys/${body.key.id}`, cookie)
    expect(removed.statusCode).toBe(200)
    expect(keys.get(body.key.id)).toBeUndefined()
  })

  it('PATCH/DELETE on an unknown key id → 404', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const missing = await adminSend(built, 'PATCH', '/admin/keys/key_nope', cookie, { disabled: true })
    expect(missing.statusCode).toBe(404)
    const removed = await adminSend(built, 'DELETE', '/admin/keys/key_nope', cookie)
    expect(removed.statusCode).toBe(404)
  })
})

describe('pool routes against a real AccountPoolManager', () => {
  it('status/pool/mode/reorder/enable/delete/clear-cooldown', async () => {
    const { built, pool } = makeAdminServer()
    const { cookie } = await login(built)

    const a = pool.createAccountSlot('alpha')
    const b = pool.createAccountSlot('beta')

    const status = await adminGet(built, '/admin/status', cookie)
    expect(status.statusCode).toBe(200)
    expect((status.json() as { pool: { accounts: unknown[] } }).pool.accounts).toHaveLength(2)

    const mode = await adminSend(built, 'POST', '/admin/pool/mode', cookie, { mode: 'round-robin' })
    expect(mode.statusCode).toBe(200)
    expect((mode.json() as { pool: { mode: string } }).pool.mode).toBe('round-robin')
    const badMode = await adminSend(built, 'POST', '/admin/pool/mode', cookie, { mode: 'bogus' })
    expect(badMode.statusCode).toBe(400)

    // reorder (swap priority; unknown ids are tolerated by the pool contract
    // — they are silently dropped, documented in the route comment)
    const reorder = await adminSend(built, 'POST', '/admin/pool/reorder', cookie, { ids: [b.id, a.id] })
    expect(reorder.statusCode).toBe(200)
    const tolerantReorder = await adminSend(built, 'POST', '/admin/pool/reorder', cookie, { ids: [b.id, 'acc_ghost'] })
    expect(tolerantReorder.statusCode).toBe(200)
    expect((tolerantReorder.json() as { pool: { accounts: unknown[] } }).pool.accounts).toHaveLength(2)

    // disable account A; the pool then hides it from rotation
    const patched = await adminSend(built, 'PATCH', `/admin/pool/accounts/${a.id}`, cookie, { enabled: false })
    expect(patched.statusCode).toBe(200)
    expect((patched.json() as { account: { enabled: boolean } }).account.enabled).toBe(false)

    // clear-cooldown on a clean account is a 200 no-op
    const cleared = await adminSend(built, 'POST', `/admin/pool/accounts/${a.id}/clear-cooldown`, cookie, {})
    expect(cleared.statusCode).toBe(200)

    const deleted = await adminSend(built, 'DELETE', `/admin/pool/accounts/${b.id}`, cookie)
    expect(deleted.statusCode).toBe(200)
    const missing = await adminSend(built, 'DELETE', `/admin/pool/accounts/${b.id}`, cookie)
    expect(missing.statusCode).toBe(404)

    const poolData = await adminGet(built, '/admin/pool', cookie)
    expect((poolData.json() as { pool: { accounts: unknown[] } }).pool.accounts).toHaveLength(1)
  })

  it('unknown account id on PATCH → 404', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const res = await adminSend(built, 'PATCH', '/admin/pool/accounts/acc_nope', cookie, { enabled: false })
    expect(res.statusCode).toBe(404)
  })
})

describe('paste-URL auth-flow routes (DoD ① headless leg)', () => {
  it('begin enters the waiting phase with an authorize URL (either auto or manual mode)', async () => {
    const { built, poolAuth } = makeAdminServer()
    const { cookie } = await login(built)
    const begin = await adminSend(built, 'POST', '/admin/pool/auth/begin', cookie, { alias: 'drill' })
    expect(begin.statusCode).toBe(200)
    const beginBody = begin.json() as { phase: string; url?: string; mode?: string }
    expect(beginBody.phase).toBe('waiting')
    expect(beginBody.url).toContain('accounts.google.com')
    // mode NOT asserted: loopback binding may legitimately degrade to manual.

    const status = await adminGet(built, '/admin/pool/auth/status', cookie)
    expect((status.json() as { phase: string }).phase).toBe('waiting')

    // QR: while waiting, the URL renders as a PNG (DoD ① display leg).
    const qr = await adminGet(built, '/admin/pool/auth/qr', cookie)
    expect(qr.statusCode).toBe(200)
    expect(String(qr.headers['content-type'])).toBe('image/png')

    await adminSend(built, 'POST', '/admin/pool/auth/cancel', cookie)
    const idle = await poolAuth.status()
    expect(idle.phase).toBe('idle')
    const qrIdle = await adminGet(built, '/admin/pool/auth/qr', cookie)
    expect(qrIdle.statusCode).toBe(404)
  })

  it('complete without a flow or empty code → 400', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const empty = await adminSend(built, 'POST', '/admin/pool/auth/complete', cookie, { code: ' ' })
    expect(empty.statusCode).toBe(400)
    // No active flow: submitCode returns ok:false (phase idle), which the
    // route surfaces as 400 since the phase is not done.
    const noFlow = await adminSend(built, 'POST', '/admin/pool/auth/complete', cookie, { code: 'https://localhost:51121/oauth-callback?code=x' })
    expect(noFlow.statusCode).toBe(400)
  })
})