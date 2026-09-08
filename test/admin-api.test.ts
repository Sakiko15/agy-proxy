// Admin API (M3): session guard, CSRF header, CIDR allowlist, keys lifecycle
// (plaintext exactly once), pool routes against a real AccountPoolManager,
// the paste-URL auth-flow routes (auto/manual tolerated — port 51121 may be
// busy), and the QR route states. DoD ① partial + charter §10 security rows.
import { describe, it, expect } from 'vitest'
import { makeAdminServer, login, adminGet, adminSend } from './helpers.admin.ts'
import { parseCookieHeader } from '../src/server/admin-session.ts'
import { generateApiKey, hashKey } from '../src/server/key-store.ts'

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

  it('per-IP login failure backoff: the 6th attempt 429s without password work (S-M5)', async () => {
    const { built } = makeAdminServer()
    for (let i = 0; i < 5; i++) {
      const r = await login(built, 'wrong-' + i)
      expect(r.res.statusCode).toBe(401)
    }
    // Past the 5-failure window the gate answers 429 pre-verify — for a wrong
    // password AND for the correct one (the lockout is IP-scoped).
    const blocked = await login(built, 'wrong-5')
    expect(blocked.res.statusCode).toBe(429)
    expect(String(blocked.res.headers['retry-after'])).toMatch(/^\d+$/)
    expect((blocked.res.json() as { error: string }).error).toContain('too many failed logins')
    const correct = await login(built)
    expect(correct.res.statusCode).toBe(429)
  }, 20_000)

  it('a successful login resets the IP failure record (S-M5)', async () => {
    const { built } = makeAdminServer()
    for (let i = 0; i < 4; i++) await login(built, 'nope')
    const good = await login(built)
    expect(good.res.statusCode).toBe(200)
    // Fresh window: five more failures stay 401, never 429.
    for (let i = 0; i < 5; i++) {
      const r = await login(built, 'nope-again')
      expect(r.res.statusCode).toBe(401)
    }
  }, 20_000)

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

  it('a malformed cookie header answers 401, not 500 (L3)', async () => {
    // decodeURIComponent('%E0%A4%A') throws URIError — pre-fix the guard
    // crashed and the request surfaced as a 500 instead of a clean denial.
    const { built } = makeAdminServer()
    const res = await built.app.inject({
      method: 'GET',
      url: '/admin/pool',
      headers: { cookie: 'agy_admin_session=%E0%A4%A' },
    })
    expect(res.statusCode).toBe(401)
    // Unit contract: undecodable values are dropped, valid ones decode.
    expect(parseCookieHeader('agy_admin_session=%E0%A4%A')).toEqual({})
    expect(parseCookieHeader('a=1; b=%2Fx')).toEqual({ a: '1', b: '/x' })
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
    // M5 red-line fix: prefix derives from the secret part (the create
    // response body legitimately carries the plaintext, but the echoed key
    // record must not carry the constant marker as its prefix).
    expect(body.key.prefix).toBe(body.plaintext.slice(7, 15))
    expect(body.key.prefix).not.toContain('sk-agy-')

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

describe('key secret reveal + rotate (schema v3 reversible storage)', () => {
  it('reveal returns the plaintext of a freshly created key; unauthenticated → 401', async () => {
    const { built, keys } = makeAdminServer()
    const created = keys.create({ name: 'rev' })
    // No cookie → the guard chain denies before anything is decrypted.
    const denied = await adminGet(built, `/admin/keys/${created.id}/secret`, '')
    expect(denied.statusCode).toBe(401)
    const { cookie } = await login(built)
    const res = await adminGet(built, `/admin/keys/${created.id}/secret`, cookie)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, plaintext: created.plaintext })
  })

  it('a legacy row (secret_enc NULL) answers plaintext null without erroring', async () => {
    const { built, db } = makeAdminServer()
    // Hand-built pre-v3 row — the plaintext was never stored server-side.
    const { plaintext } = generateApiKey()
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('key_legacy', 'pre-v3', ?, 'Qq11Ww22', 1)`).run(hashKey(plaintext))
    const { cookie } = await login(built)
    const res = await adminGet(built, '/admin/keys/key_legacy/secret', cookie)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, plaintext: null })
  })

  it('reveal/rotate on an unknown key id → 404', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    expect((await adminGet(built, '/admin/keys/key_nope/secret', cookie)).statusCode).toBe(404)
    expect((await adminSend(built, 'POST', '/admin/keys/key_nope/rotate', cookie, {})).statusCode).toBe(404)
  })

  it('rotate issues a new plaintext once, kills the old one, and re-arms reveal', async () => {
    const { built, keys } = makeAdminServer()
    const created = keys.create({ name: 'rot', dailyTokenLimit: 100 })
    const { cookie } = await login(built)
    const res = await adminSend(built, 'POST', `/admin/keys/${created.id}/rotate`, cookie, {})
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; key: { id: string; prefix: string }; plaintext: string }
    expect(body.ok).toBe(true)
    expect(body.plaintext).toMatch(/^sk-agy-/)
    expect(body.plaintext).not.toBe(created.plaintext)
    expect(body.key.prefix).not.toBe(created.prefix)
    // The auth material swapped atomically: old → unknown, new → ok.
    expect(keys.verify(created.plaintext).verdict).toBe('unknown')
    expect(keys.verify(body.plaintext).verdict).toBe('ok')
    // Reveal now hands out the NEW value (reversible storage re-armed).
    const revealed = await adminGet(built, `/admin/keys/${created.id}/secret`, cookie)
    expect(revealed.json()).toEqual({ ok: true, plaintext: body.plaintext })
  })

  it('rotate is a mutation: missing x-requested-with → 403 csrf', async () => {
    const { built, keys } = makeAdminServer()
    const created = keys.create({ name: 'csrf' })
    const { cookie } = await login(built)
    const res = await built.app.inject({
      method: 'POST',
      url: `/admin/keys/${created.id}/rotate`,
      payload: {},
      headers: { cookie, 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toContain('x-requested-with')
  })
})

describe('usage route account attribution (read-time pool enrichment)', () => {
  interface UsageBody {
    ok: boolean
    total: number
    rows: Array<{ requestId: string; accountId: string | null; accountAlias: string | null; accountEmail: string | null }>
  }

  it('resolves accountAlias from the pool; orphan and null ids stay honest', async () => {
    const { built, pool, ledger } = makeAdminServer()
    const alpha = pool.createAccountSlot('alpha')
    // Three rows: served by a live pool account, by a deleted-then-removed id
    // (orphan), and by no account at all (root key / pool-less run).
    ledger.record({ requestId: 'u-live', keyId: null, accountId: alpha.id, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'OK' })
    ledger.record({ requestId: 'u-ghost', keyId: null, accountId: 'acc_ghost', model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'OK' })
    ledger.record({ requestId: 'u-none', keyId: null, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'OK' })
    await ledger.flush()

    const { cookie } = await login(built)
    const res = await adminGet(built, '/admin/usage', cookie)
    expect(res.statusCode).toBe(200)
    const body = res.json() as UsageBody
    expect(body.ok).toBe(true)
    expect(body.total).toBe(3)
    const byId = new Map(body.rows.map((r) => [r.requestId, r]))
    expect(byId.get('u-live')).toMatchObject({ accountId: alpha.id, accountAlias: 'alpha', accountEmail: null })
    // Orphan: enrichment null, raw id preserved (honest attribution).
    expect(byId.get('u-ghost')).toMatchObject({ accountId: 'acc_ghost', accountAlias: null, accountEmail: null })
    expect(byId.get('u-none')).toMatchObject({ accountId: null, accountAlias: null, accountEmail: null })
  })

  it('the accountId query filter narrows to exactly the matching rows', async () => {
    const { built, pool, ledger } = makeAdminServer()
    const alpha = pool.createAccountSlot('alpha')
    const beta = pool.createAccountSlot('beta')
    for (const [id, account] of [['f-alpha', alpha.id], ['f-beta', beta.id], ['f-none', null]] as const) {
      ledger.record({ requestId: id, keyId: null, accountId: account, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'OK' })
    }
    await ledger.flush()
    const { cookie } = await login(built)
    const filtered = await adminGet(built, `/admin/usage?accountId=${encodeURIComponent(alpha.id)}`, cookie)
    expect(filtered.statusCode).toBe(200)
    const body = filtered.json() as UsageBody
    expect(body.total).toBe(1)
    expect(body.rows.map((r) => r.requestId)).toEqual(['f-alpha'])
    expect(body.rows[0]?.accountAlias).toBe('alpha')
    // Unfiltered total stays 3 — the filter genuinely narrows the query.
    const all = await adminGet(built, '/admin/usage', cookie)
    expect((all.json() as UsageBody).total).toBe(3)
  })

  it('protocol/status query filters reach the ledger (dashboard success-rate shape, audit M1)', async () => {
    const { built, ledger } = makeAdminServer()
    ledger.record({ requestId: 'g-ok-oa', keyId: null, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'OK' })
    ledger.record({ requestId: 'g-ok-an', keyId: null, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'anthropic', promptTokens: 1, completionTokens: 1, status: 'OK' })
    ledger.record({ requestId: 'g-fail', keyId: null, accountId: null, model: 'gemini-3.7-flash', family: 'google', protocol: 'openai', promptTokens: 1, completionTokens: 1, status: 'TIMEOUT' })
    await ledger.flush()
    const { cookie } = await login(built)

    const okOnly = await adminGet(built, '/admin/usage?status=OK', cookie)
    expect((okOnly.json() as UsageBody).total).toBe(2)
    const anthropicOnly = await adminGet(built, '/admin/usage?protocol=anthropic', cookie)
    expect((anthropicOnly.json() as UsageBody).total).toBe(1)
    expect(((anthropicOnly.json() as UsageBody).rows[0]?.requestId)).toBe('g-ok-an')

    // An unknown protocol value must not match anything nor throw — it is
    // dropped like an unparseable number, and the query stays unfiltered.
    const bogus = await adminGet(built, '/admin/usage?protocol=grpc', cookie)
    expect(bogus.statusCode).toBe(200)
    expect((bogus.json() as UsageBody).total).toBe(3)
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

  it('GET /admin/pool carries the per-account quota lastError channel (audit F12)', async () => {
    const { built, pool, quota } = makeAdminServer()
    const { cookie } = await login(built)
    const acc = pool.createAccountSlot('f12')
    // note/clearQuotaError are private; reach them via the same test-only
    // cast used for persistRefreshedToken (quota.test.ts, audit M3).
    type ErrChannel = { noteQuotaError: (id: string, msg: string) => void; clearQuotaError: (id: string) => void }
    const channel = quota as unknown as ErrChannel
    channel.noteQuotaError.call(quota, acc.id, 'quota summary endpoint returned 503')

    const withErr = await adminGet(built, '/admin/pool', cookie)
    const account = (withErr.json() as { pool: { accounts: Array<{ id: string; quotaError?: string; quotaErrorAt?: number }> } })
      .pool.accounts.find((a) => a.id === acc.id)
    expect(account?.quotaError).toBe('quota summary endpoint returned 503')
    expect(account?.quotaErrorAt).toBeGreaterThan(0)

    // Cleared on the next successful refresh → the fields disappear again.
    channel.clearQuotaError.call(quota, acc.id)
    const cleared = await adminGet(built, '/admin/pool', cookie)
    const after = (cleared.json() as { pool: { accounts: Array<{ id: string; quotaError?: string }> } })
      .pool.accounts.find((a) => a.id === acc.id)
    expect(after?.quotaError).toBeUndefined()
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