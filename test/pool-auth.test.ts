// Ported from dsh-agy-link test/pool-auth.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect; account-count assertions
// updated — the gateway pool starts EMPTY, so begin() leaves zero committed
// accounts where upstream had its bootstrapped primary).
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { PoolAuthFlow } from '../src/host/pool-auth.ts'
import { QuotaService } from '../src/host/quota.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
  const pool = new AccountPoolManager(dir)
  const quota = new QuotaService(pool)
  return { dir, pool, quota }
}

describe('pool-auth', () => {
  it('PoolAuthFlow begin produces a PKCE authorize URL and auto mode', async () => {
    const { pool, quota } = fixture()
    const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
    const st = await flow.begin('测试账号')
    expect(st.ok).toBe(true)
    expect(st.phase).toBe('waiting')
    expect(st.mode).toBe('auto')
    expect(st.browserOpened).toBe(true)
    expect(st.url?.includes('accounts.google.com')).toBe(true)
    expect(st.url?.includes('code_challenge=')).toBe(true)
    expect(st.url?.includes('code_challenge_method=S256')).toBe(true)
    expect(st.url?.includes('redirect_uri=http%3A%2F%2Flocalhost%3A51121')).toBe(true)
    // openid must NOT be in the scope (hangs consent for this client)
    expect(st.url?.includes('openid')).toBe(false)
    // staging slot exists but no account committed yet (pool starts empty)
    expect(pool.getAccounts().length).toBe(0)
    await flow.cancel()
    expect(flow.status().phase).toBe('idle')
  })

  it('PoolAuthFlow cancel cleans the staging dir', async () => {
    const { dir, pool, quota } = fixture()
    const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => false })
    const st = await flow.begin()
    expect(st.ok).toBe(true)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).some((e) => e.startsWith('staging_'))).toBe(true)
    await flow.cancel()
    expect(readdirSync(dir).some((e) => e.startsWith('staging_'))).toBe(false)
  })

  it('PoolAuthFlow rejects bogus paste and wrong-state URLs', async () => {
    const { pool, quota } = fixture()
    const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
    const st = await flow.begin()
    expect(st.ok).toBe(true)

    const bogus = await flow.submitCode('not a code at all!!!')
    expect(bogus.ok).toBe(false)
    expect(bogus.phase).toBe('waiting') // still waiting, not failed

    const wrongState = await flow.submitCode('http://localhost:51121/oauth-callback?code=4/1AfValidLookingCode&state=WRONG')
    expect(wrongState.ok).toBe(false)
    expect(wrongState.phase).toBe('waiting')
    expect(wrongState.message ?? '').toMatch(/state/)

    await flow.cancel()
  })

  it('PoolAuthFlow fails cleanly when the exchange is rejected', async () => {
    const { dir, pool, quota } = fixture()
    const flow = new PoolAuthFlow(pool, quota, () => {}, { openBrowser: async () => true })
    const st = await flow.begin()
    expect(st.ok).toBe(true)
    // A real-looking but invalid code reaches the token endpoint and is
    // rejected; the flow must fail (not hang) and clean up staging.
    // NOTE: this test requires network; skip silently when offline.
    try {
      const res = await flow.submitCode('4/1AfDefinitelyInvalidCode123')
      expect(res.ok).toBe(false)
      expect(res.phase).toBe('failed')
      expect(res.message ?? '').toMatch(/交换失败|exchange/i)
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(dir).some((e) => e.startsWith('staging_'))).toBe(false)
    } catch (err) {
      if (String(err).includes('fetch failed')) return // offline: skip
      throw err
    }
  })
})
