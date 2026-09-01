// M5-3 admin surface: PATCH /admin/keys/:id {scopes} (model whitelist) and
// POST /admin/pool/accounts/:id/clear-auth (quarantine recovery). Guard chain
// behavior is inherited from the M3 admin suite; these pin the new fields.
import { describe, it, expect } from 'vitest'
import { makeAdminServer, login, adminGet, adminSend } from './helpers.admin.ts'

describe('PATCH /admin/keys/:id scopes', () => {
  it('sets, reads back, and clears the whitelist', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)

    const created = await adminSend(built, 'POST', '/admin/keys', cookie, { name: 'scoped-key' })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { key: { id: string } }).key.id

    const set = await adminSend(built, 'PATCH', '/admin/keys/' + id, cookie, {
      scopes: 'gemini-3.7-flash, claude-sonnet-4-6',
    })
    expect(set.statusCode).toBe(200)
    expect((set.json() as { key: { scopes: string } }).key.scopes).toBe('gemini-3.7-flash, claude-sonnet-4-6')

    const list = await adminGet(built, '/admin/keys', cookie)
    const keys = (list.json() as { keys: Array<{ id: string; scopes: string | null }> }).keys
    expect(keys.find((k) => k.id === id)?.scopes).toBe('gemini-3.7-flash, claude-sonnet-4-6')

    // '' clears to NULL (unrestricted), never an empty-string column.
    const clear = await adminSend(built, 'PATCH', '/admin/keys/' + id, cookie, { scopes: '' })
    expect(clear.statusCode).toBe(200)
    const list2 = await adminGet(built, '/admin/keys', cookie)
    const keys2 = (list2.json() as { keys: Array<{ id: string; scopes: string | null }> }).keys
    expect(keys2.find((k) => k.id === id)?.scopes).toBe(null)
  })

  it('leaves scopes untouched when the patch omits them; unknown id 404s', async () => {
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const created = await adminSend(built, 'POST', '/admin/keys', cookie, { name: 'keep' })
    const id = (created.json() as { key: { id: string } }).key.id
    await adminSend(built, 'PATCH', '/admin/keys/' + id, cookie, { scopes: 'gemini-3.7-flash' })
    const other = await adminSend(built, 'PATCH', '/admin/keys/' + id, cookie, { dailyTokenLimit: 50 })
    expect((other.json() as { key: { scopes: string } }).key.scopes).toBe('gemini-3.7-flash')

    const missing = await adminSend(built, 'PATCH', '/admin/keys/key_nope', cookie, { scopes: 'x' })
    expect(missing.statusCode).toBe(404)
  })
})

describe('POST /admin/pool/accounts/:id/clear-auth', () => {
  it('restores a quarantined account to the selectable pool', async () => {
    const { built, pool } = makeAdminServer()
    const { cookie } = await login(built)
    pool.createAccountSlot('clear-me')
    const id = pool.getAccounts()[0]!.id
    pool.markAuthRequired(id, 'VALIDATION_REQUIRED misfire')

    const quarantined = await adminGet(built, '/admin/pool', cookie)
    expect((quarantined.json() as { pool: { accounts: Array<{ id: string; authRequired: boolean }> } }).pool.accounts
      .find((a) => a.id === id)?.authRequired).toBe(true)
    expect(pool.selectAccount('google')).toBe(null)

    const clear = await adminSend(built, 'POST', '/admin/pool/accounts/' + id + '/clear-auth', cookie, {})
    expect(clear.statusCode).toBe(200)
    const account = pool.getAccount(id)
    expect(account?.authRequired ?? false).toBe(false) // the flag is deleted, not flipped
    expect(account?.authError).toBeUndefined()
    // The account can be selected again.
    expect(pool.selectAccount('google')?.id).toBe(id)
  })

  it('is a 200 no-op on a healthy account (idempotent) and 404s on an unknown id', async () => {
    const { built, pool } = makeAdminServer()
    const { cookie } = await login(built)
    const slot = pool.createAccountSlot('healthy')

    const healthy = await adminSend(built, 'POST', '/admin/pool/accounts/' + slot.id + '/clear-auth', cookie, {})
    expect(healthy.statusCode).toBe(200)
    expect(pool.getAccount(slot.id)?.authRequired ?? false).toBe(false)

    const missing = await adminSend(built, 'POST', '/admin/pool/accounts/nope/clear-auth', cookie, {})
    expect(missing.statusCode).toBe(404)
  })
})