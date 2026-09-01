// Ported from dsh-agy-link test/pool.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect; the bootstrapped
// acc_primary/systemHome cases are dropped — the gateway pool starts EMPTY
// and every account is an isolated slot; drain tests drive the pool through
// createAccountSlot instead of getAccounts()[0]).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFamilyOf, shouldPollAccount, getAccountHealth } from '../src/common/pool-types.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { parseResetDurationMs } from '../src/common/types.ts'

describe('pool: modelFamilyOf', () => {
  it('correctly categorizes models', () => {
    expect(modelFamilyOf('gemini-3.7-flash')).toBe('google')
    expect(modelFamilyOf('gemini-3.6-flash')).toBe('google')
    expect(modelFamilyOf('gemini-3.1-pro')).toBe('google')
    expect(modelFamilyOf('gemma-2-9b')).toBe('google')
    expect(modelFamilyOf('claude-sonnet-4-6')).toBe('anthropic')
    expect(modelFamilyOf('claude-3-7-sonnet')).toBe('anthropic')
    expect(modelFamilyOf('claude-opus-4-6-thinking')).toBe('anthropic')
    expect(modelFamilyOf('gpt-oss-120b-medium')).toBe('openai')
    expect(modelFamilyOf('openai/gpt-4o')).toBe('openai')
    expect(modelFamilyOf('custom-other-model')).toBe('unknown')
    expect(modelFamilyOf(undefined)).toBe('unknown')
  })
})

describe('pool: AccountPoolManager', () => {
  it('manages isolated account slots (pool starts empty in the gateway)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-test-'))
    const pool = new AccountPoolManager(dir)

    // No primary bootstrap: a headless gateway has no system-HOME login.
    expect(pool.getAccounts().length).toBe(0)

    // Create new account slot
    const acc2 = pool.createAccountSlot('Account B')
    expect(pool.getAccounts().length).toBe(1)
    expect(acc2.alias).toBe('Account B')
    expect(existsSync(acc2.dir)).toBe(true)
    expect(existsSync(join(dir, 'pool.json'))).toBe(true)

    // Set proxy override
    pool.setAccountProxy(acc2.id, 'http://127.0.0.1:7890')
    expect(pool.getAccount(acc2.id)?.proxyUrl).toBe('http://127.0.0.1:7890')

    // Persistence across manager instances
    const pool2 = new AccountPoolManager(dir)
    expect(pool2.getAccounts().length).toBe(1)

    // Delete account
    pool2.deleteAccount(acc2.id)
    expect(pool2.getAccounts().length).toBe(0)
    expect(existsSync(acc2.dir)).toBe(false)
  })

  it('Sequential Drain: family-scoped rate limit fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-drain-'))
    const pool = new AccountPoolManager(dir)
    const accA = pool.createAccountSlot('Account A')
    const accB = pool.createAccountSlot('Account B')
    const accC = pool.createAccountSlot('Account C')

    // Both Gemini and Claude initially pick Account A
    expect(pool.selectAccount('anthropic')?.id).toBe(accA.id)
    expect(pool.selectAccount('google')?.id).toBe(accA.id)

    // Account A hits 429 on Claude
    pool.recordFailure(accA.id, 'anthropic', '429 Rate Limit')

    // Claude requests fail over to Account B!
    expect(pool.selectAccount('anthropic')?.id).toBe(accB.id)

    // Gemini requests still use Account A (family isolation!)
    expect(pool.selectAccount('google')?.id).toBe(accA.id)

    // Account B hits 429 on Claude with a future reset time
    const futureReset = new Date(Date.now() + 300_000).toISOString()
    pool.recordFailure(accB.id, 'anthropic', '429 Rate Limit', futureReset)

    // Claude requests fail over to Account C!
    expect(pool.selectAccount('anthropic')?.id).toBe(accC.id)

    // Account C hits 429 on Claude
    pool.recordFailure(accC.id, 'anthropic', '429 Rate Limit')

    // All accounts are in cooldown for Claude
    expect(pool.selectAccount('anthropic')).toBeNull()
    const countdown = pool.getEarliestResetCountdown('anthropic')
    expect(typeof countdown === 'number' && countdown > 0).toBe(true)

    // Clearing cooldown on Account A restores it
    pool.clearCooldown(accA.id, 'anthropic')
    expect(pool.selectAccount('anthropic')?.id).toBe(accA.id)
  })

  it('Sticky Sequential Drain: stays on current active account until it runs out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-sticky-'))
    const pool = new AccountPoolManager(dir)
    const accA = pool.createAccountSlot('Account A')
    const accB = pool.createAccountSlot('Account B')
    const accC = pool.createAccountSlot('Account C')

    // 1. Initial request picks Account A
    expect(pool.selectAccount('google')?.id).toBe(accA.id)

    // 2. Account A runs out of quota (hits 429) -> failover to Account B
    pool.recordFailure(accA.id, 'google', '429 Rate Limit')
    expect(pool.selectAccount('google')?.id).toBe(accB.id)

    // 3. User continues chatting with Account B
    expect(pool.selectAccount('google')?.id).toBe(accB.id)

    // 4. Now Account A recovers its quota / cooldown expires!
    pool.clearCooldown(accA.id, 'google')

    // 5. CRITICAL: Account B is still healthy and in-use, so it MUST stay on Account B!
    expect(pool.selectAccount('google')?.id).toBe(accB.id)

    // 6. Only when Account B runs out of quota does it move to Account C
    pool.recordFailure(accB.id, 'google', '429 Rate Limit')
    expect(pool.selectAccount('google')?.id).toBe(accC.id)

    // 7. When Account C also runs out, and A is recovered, it wraps back to Account A
    pool.recordFailure(accC.id, 'google', '429 Rate Limit')
    expect(pool.selectAccount('google')?.id).toBe(accA.id)
  })

  it('Corrupt pool.json recovers gracefully (empty pool, no primary)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-corrupt-'))
    writeFileSync(join(dir, 'pool.json'), '{ broken json', 'utf8')
    const pool = new AccountPoolManager(dir)
    expect(pool.getAccounts().length).toBe(0)
  })

  it('parseResetDurationMs parses various rate limit durations', () => {
    // Compact durations
    expect(parseResetDurationMs('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.')).toBe(1285000)
    expect(parseResetDurationMs('Rate limited. Resets in 2h26m6s.')).toBe(8766000)
    expect(parseResetDurationMs('Resets in 3m30s')).toBe(210000)
    expect(parseResetDurationMs('resets in 45s')).toBe(45000)
    expect(parseResetDurationMs('Resets in 1h')).toBe(3600000)

    // Word-based durations
    expect(parseResetDurationMs('Resets in 15 minutes')).toBe(900000)
    expect(parseResetDurationMs('retry after 30 seconds')).toBe(30000)
    expect(parseResetDurationMs('resets in 2 hours')).toBe(7200000)

    // Invalid / empty
    expect(parseResetDurationMs(undefined)).toBeUndefined()
    expect(parseResetDurationMs('')).toBeUndefined()
    expect(parseResetDurationMs('regular error message without reset info')).toBeUndefined()
  })

  it('recordFailure parses reset duration from error text and sets safety buffer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-reset-'))
    const pool = new AccountPoolManager(dir)
    const accA = pool.createAccountSlot('Account A')

    // Record failure with reset text
    const errText = 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 21m25s.'
    const t0 = Date.now()
    pool.recordFailure(accA.id, 'google', errText)

    const cd = pool.getAccount(accA.id)?.cooldowns.google
    expect(cd).toBeTruthy()
    // Expected cooldown = now + 1285s + 10s buffer
    const expectedMin = t0 + 1295 * 1000 - 500
    const expectedMax = t0 + 1295 * 1000 + 5000
    expect(cd!.cooldownUntil >= expectedMin && cd!.cooldownUntil <= expectedMax).toBe(true)
  })

  it('resetAccountIdentity clears identity-bound state on external re-login', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-identity-reset-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('switched')

    // Simulate the old account going down hard before the user re-logged in:
    pool.recordFailure(acc.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 2h26m6s.')
    pool.markAuthRequired(acc.id, 'invalid_grant')
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0, updatedAt: Date.now() } }, 'old.account@gmail.com')
    const flagged = pool.getAccount(acc.id)!
    expect(flagged.email).toBe('old.account@gmail.com')
    expect(flagged.authRequired).toBe(true)
    expect(flagged.cooldowns.google).toBeTruthy()
    expect(flagged.quotas.google).toBeTruthy()
    expect(shouldPollAccount(flagged)).toBe(false)

    // External re-login detected from logs → full identity reset.
    pool.resetAccountIdentity(acc.id, 'new.account@gmail.com')
    const fresh = pool.getAccount(acc.id)!
    expect(fresh.email).toBe('new.account@gmail.com')
    expect(fresh.authRequired).toBeUndefined()
    expect(fresh.authError).toBeUndefined()
    expect(fresh.cooldowns).toEqual({})
    expect(fresh.quotas).toEqual({})
    // Slot config survives the switch.
    expect(fresh.id).toBe(acc.id)
    expect(fresh.enabled).toBe(true)
    // And the slot is pollable/selectable again immediately.
    expect(shouldPollAccount(fresh)).toBe(true)
    const picked = pool.selectAccount('google')
    expect(picked?.id).toBe(acc.id)
  })

  it('markAuthRequired quarantines broken accounts from selectAccount', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-auth-'))
    const pool = new AccountPoolManager(dir)
    const accA = pool.createAccountSlot('Account A')
    const accB = pool.createAccountSlot('Account B')

    expect(pool.selectAccount('google')?.id).toBe(accA.id)

    // Mark A as auth required (token revoked/invalid_grant)
    pool.markAuthRequired(accA.id, 'invalid_grant: Token expired')
    const accAUpdated = pool.getAccount(accA.id)!
    expect(accAUpdated.authRequired).toBe(true)

    const healthA = getAccountHealth(accAUpdated, 'google')
    expect(healthA.status).toBe('auth_required')

    // Pool automatically bypasses account A and selects account B
    expect(pool.selectAccount('google')?.id).toBe(accB.id)

    // When A is re-authenticated or cleared, it recovers
    pool.clearAuthRequired(accA.id)
    expect(pool.getAccount(accA.id)?.authRequired).toBeUndefined()
  })

  it('onChange fires once per mutation and unsubscribe stops the stream', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-onchange-'))
    const pool = new AccountPoolManager(dir)
    const seen: string[] = []
    const unsubscribe = pool.onChange(() => { seen.push('change') })
    try {
      pool.createAccountSlot('alpha')
      expect(seen).toEqual(['change']) // one callback per mutating call
      pool.deleteAccount(pool.getAccounts()[0]!.id)
      expect(seen).toEqual(['change', 'change'])

      unsubscribe()
      pool.createAccountSlot('beta')
      expect(seen).toEqual(['change', 'change']) // no further notifies

      // Reads and no-op lookups (unknown account) never notify.
      const noopCount = seen.length
      pool.getAccount('does-not-exist')
      pool.getPoolData()
      expect(seen.length).toBe(noopCount)
    } finally {
      unsubscribe()
    }
  })

  it('hot-path pool writes are debounced; flush() and the timer land them (S-M8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-debounce-'))
    const pool = new AccountPoolManager(dir)
    const file = join(dir, 'pool.json')
    // createAccountSlot persists synchronously (critical path) — the file exists.
    const acc = pool.createAccountSlot('deb')
    const before = readFileSync(file, 'utf8')

    // Per-request hot paths coalesce: no synchronous rewrite inside the window.
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.42, updatedAt: Date.now() } }, 'debounced@gmail.com')
    pool.recordFailure(acc.id, 'google', '429 RESOURCE_EXHAUSTED: quota exceeded')
    pool.recordSuccess(acc.id, 'google')
    expect(readFileSync(file, 'utf8')).toBe(before)

    // flush() writes the coalesced state (shutdown path).
    pool.flush()
    const flushed = JSON.parse(readFileSync(file, 'utf8')) as { accounts: { id: string; quotas: Record<string, { remainingFraction: number }>; lastUsedAt: number }[] }
    const row = flushed.accounts.find((a) => a.id === acc.id)
    expect(row?.quotas.google?.remainingFraction).toBe(0.42)
    expect(row?.lastUsedAt).toBeTruthy()

    // And a later hot mutation lands via the unref'd timer on its own.
    const afterFlush = readFileSync(file, 'utf8')
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.99, updatedAt: Date.now() } })
    expect(readFileSync(file, 'utf8')).toBe(afterFlush)
    await new Promise((r) => setTimeout(r, 700))
    const timed = JSON.parse(readFileSync(file, 'utf8')) as { accounts: { id: string; quotas: Record<string, { remainingFraction: number }> }[] }
    expect(timed.accounts.find((a) => a.id === acc.id)?.quotas.google?.remainingFraction).toBe(0.99)
    // Settle any still-pending timer before the temp dir is removed.
    pool.flush()
  }, 10_000)

  it('sweepOldLogs sweeps log files older than retention days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-pool-logs-'))
    const pool = new AccountPoolManager(dir)
    const accB = pool.createAccountSlot('Account B')

    const logDir = join(accB.dir, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(logDir, { recursive: true })

    const oldLog = join(logDir, 'cli-old.log')
    const freshLog = join(logDir, 'cli-fresh.log')
    writeFileSync(oldLog, 'old log data', 'utf8')
    writeFileSync(freshLog, 'fresh log data', 'utf8')

    // Set old log mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(oldLog, tenDaysAgo, tenDaysAgo)

    const swept = pool.sweepOldLogs(7)
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(freshLog)).toBe(true)
  })
})
