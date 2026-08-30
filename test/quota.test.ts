// Ported from dsh-agy-link test/quota.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect). Dropped: the
// Keychain-over-disk-for-primary test (the gateway never creates
// systemHome accounts) and the client brand-icons test (client/ is not
// ported). Kept: token normalization/round-trip, OAuth helpers, identity
// detection, poll gating, fallback-merge semantics and the force/bg
// refresh identity rules via QuotaService subclasses.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService, detectEmailFromAgyLogs, mergeFallbackFamilyQuota, normalizeStoredToken } from '../src/host/quota.ts'
import { shouldPollAccount, type FamilyQuotaInfo } from '../src/common/pool-types.ts'
import { writeAgyTokenFile, parsePastedCode, generatePkce } from '../src/host/oauth.ts'

describe('quota: tokens', () => {
  it('QuotaService parses stored tokens and saves token refresh updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('quota-test')

    const tokenDir = join(acc.dir, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(
      join(tokenDir, 'antigravity-oauth-token'),
      JSON.stringify({
        access_token: 'fake_access_token_123',
        refresh_token: 'fake_refresh_token_456',
        expiry: Date.now() + 3600_000,
      }),
      'utf8',
    )

    const quota = new QuotaService(pool)
    const stored = quota.getStoredToken(acc)
    expect(stored?.accessToken).toBe('fake_access_token_123')
    expect(stored?.refreshToken).toBe('fake_refresh_token_456')

    const validToken = await quota.getValidAccessToken(acc)
    expect(validToken).toBe('fake_access_token_123')
  })

  it('normalizeStoredToken reads agy 1.1.16 nested shape with ISO expiry', () => {
    // Real on-disk format: {"token": {...}, "auth_method": "consumer"} with
    // expiry as a local ISO-8601 string. The old flat read returned the
    // nested object as the access token ("Bearer [object Object]").
    const nested = normalizeStoredToken({
      token: {
        access_token: 'ya29.nested',
        token_type: 'Bearer',
        refresh_token: '1//nested-refresh',
        expiry: '2026-08-20T16:44:43.782922+08:00',
      },
      auth_method: 'consumer',
    })
    expect(nested?.accessToken).toBe('ya29.nested')
    expect(nested?.refreshToken).toBe('1//nested-refresh')
    expect(nested?.expiryMs).toBe(Date.parse('2026-08-20T16:44:43.782922+08:00'))

    // A bare-object "token" must never be mistaken for the token string.
    expect(normalizeStoredToken({ token: { nope: 1 } })).toBeNull()
    expect(normalizeStoredToken({})).toBeNull()

    // Epoch seconds and millis both parse.
    const secs = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000 })
    expect(secs?.expiryMs).toBe(1_800_000_000_000)
    const millis = normalizeStoredToken({ access_token: 'a', expiry: 1_800_000_000_000 })
    expect(millis?.expiryMs).toBe(1_800_000_000_000)
  })

  it('normalizeStoredToken parses go-keyring-base64 JSON payloads from Keychain', () => {
    const payload = {
      token: {
        access_token: 'ya29.keychain_access',
        token_type: 'Bearer',
        refresh_token: '1//keychain_refresh',
        expiry: '2026-08-21T15:34:29.273+08:00',
      },
      auth_method: 'consumer',
    }
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
    const rawKeychainString = `go-keyring-base64:${b64}`
    expect(rawKeychainString.startsWith('go-keyring-base64:')).toBe(true)
    const decoded = JSON.parse(Buffer.from(rawKeychainString.slice('go-keyring-base64:'.length), 'base64').toString('utf8'))
    const token = normalizeStoredToken(decoded)
    expect(token?.accessToken).toBe('ya29.keychain_access')
    expect(token?.refreshToken).toBe('1//keychain_refresh')
    expect(token?.expiryMs).toBe(Date.parse('2026-08-21T15:34:29.273+08:00'))
  })

  it('writeAgyTokenFile emits the agy on-disk format and round-trips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-oauth-write-'))
    const home = join(dir, 'home')
    const file = writeAgyTokenFile(home, {
      access_token: 'ya29.fresh',
      refresh_token: '1//fresh-refresh',
      expiryMs: Date.parse('2026-08-21T00:00:00Z'),
    })
    expect(file.endsWith(join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'))).toBe(true)

    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('roundtrip')
    // Point the account at the HOME we just wrote.
    acc.dir = home
    const quota = new QuotaService(pool)
    const stored = quota.getStoredToken(acc)
    expect(stored?.accessToken).toBe('ya29.fresh')
    expect(stored?.refreshToken).toBe('1//fresh-refresh')
    expect(stored?.expiryMs).toBe(Date.parse('2026-08-21T00:00:00Z'))
  })

  it('getStoredToken never reads the shared Keychain for isolated pool accounts', () => {
    // The Keychain is ONE shared slot owned by a desktop login; isolated
    // account slots must only ever see their own directory's token file.
    const dir = mkdtempSync(join(tmpdir(), 'agy-quota-iso-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('isolated')
    const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(
      join(tokenDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'ya29.isolated_own', expiry: Date.now() + 3600_000 }),
      'utf8',
    )
    let keychainReads = 0
    class IsoService extends QuotaService {
      override readSystemKeychainToken() {
        keychainReads++
        return null
      }
    }
    const svc = new IsoService(pool)
    expect(svc.getStoredToken(acc)?.accessToken).toBe('ya29.isolated_own')
    expect(keychainReads).toBe(0)
  })
})

describe('quota: oauth helpers', () => {
  it('parsePastedCode accepts bare codes and full redirect URLs', () => {
    expect(parsePastedCode('4/1AfJohXyZ')).toEqual({ code: '4/1AfJohXyZ' })
    expect(
      parsePastedCode('http://localhost:51121/oauth-callback?code=4/1AfCde&state=xyz123'),
    ).toEqual({ code: '4/1AfCde', state: 'xyz123' })
    expect(parsePastedCode('http://localhost:51121/oauth-callback?state=xyz')).toBeNull()
    expect(parsePastedCode('short')).toBeNull()
    expect(parsePastedCode('')).toBeNull()
  })

  it('generatePkce produces a valid S256 pair', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true)
    expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true)
    expect(verifier).not.toBe(challenge)
  })
})

describe('quota: aggregation and refresh', () => {
  it('Quota aggregation extracts bottleneck model fraction and earliest reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-quota-agg-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('agg')

    pool.updateAccountQuotas(
      acc.id,
      {
        google: {
          remainingFraction: 0.85,
          resetTime: '2026-08-20T16:00:00Z',
          weeklyFraction: 0.95,
          weeklyResetTime: '2026-08-27T08:00:00Z',
          models: [
            { modelId: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', remainingFraction: 0.85, resetTime: '2026-08-20T16:00:00Z' },
            { modelId: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)', remainingFraction: 0.9, resetTime: '2026-08-20T16:00:00Z' },
          ],
        },
        anthropic: {
          remainingFraction: 0.4,
          resetTime: '2026-08-20T18:30:00Z',
          weeklyFraction: 0.8,
          weeklyResetTime: '2026-08-27T12:00:00Z',
          models: [
            { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', remainingFraction: 0.4, resetTime: '2026-08-20T18:30:00Z' },
          ],
        },
        openai: {
          remainingFraction: 1.0,
          weeklyFraction: 1.0,
        },
      },
      'test@gmail.com',
    )

    const updated = pool.getAccount(acc.id)!
    expect(updated.email).toBe('test@gmail.com')
    expect(updated.quotas.google?.remainingFraction).toBe(0.85)
    expect(updated.quotas.google?.weeklyFraction).toBe(0.95)
    expect(updated.quotas.google?.weeklyResetTime).toBe('2026-08-27T08:00:00Z')
    expect(updated.quotas.google?.models?.length).toBe(2)
    expect(updated.quotas.anthropic?.remainingFraction).toBe(0.4)
    expect(updated.quotas.anthropic?.weeklyFraction).toBe(0.8)
    expect(updated.quotas.anthropic?.models?.length).toBe(1)
    expect(updated.quotas.openai?.remainingFraction).toBe(1.0)
    expect(updated.quotas.openai?.weeklyFraction).toBe(1.0)
  })

  it('manual force refresh re-anchors slot identity from the token, not the label', async () => {
    // Real incident: the stored token belonged to elegantmanco@gmail.com but
    // the slot still said q986465568@gmail.com (log scraping returned the
    // stale label), so 刷新/同步 fetched elegantmanco's quota and displayed
    // it as the slot's values. Manual refresh must trust the TOKEN (via
    // userinfo) over both the stored label and log detection.
    const dir = mkdtempSync(join(tmpdir(), 'agy-quota-force-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('force-sync')
    // Slot currently labeled with the OLD account.
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5, weeklyFraction: 0.5 } }, 'q986465568@gmail.com')

    // Token on disk is valid, so no refresh-token flow kicks in.
    const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(
      join(tokenDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'ya29.tok_of_elegantmanco', expiry: Date.now() + 3600_000 }),
      'utf8',
    )

    let userinfoCalls = 0
    class ForceSyncService extends QuotaService {
      override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
        userinfoCalls++
        return { email: 'elegantmanco@gmail.com' }
      }
      override async fetchQuotaSummary() {
        return {
          groups: [
            {
              displayName: 'Gemini Models',
              description: 'Models within this group: Gemini Flash, Gemini Pro',
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-08-27T12:00:00Z' },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-08-29T12:00:00Z' },
              ],
            },
          ],
        } as never
      }
      override async fetchAvailableModels() {
        return { models: {} } as never
      }
    }

    const svc = new ForceSyncService(pool)
    await svc.refreshAccountQuota(pool.getAccount(acc.id)!, true)

    expect(userinfoCalls).toBeGreaterThanOrEqual(1)
    const healed = pool.getAccount(acc.id)!
    expect(healed.email).toBe('elegantmanco@gmail.com')
    expect(healed.quotas.google?.remainingFraction).toBe(0.7)
    expect(healed.quotas.google?.weeklyFraction).toBe(0.42)
  })

  it('background refresh keeps the zero-network identity path (no userinfo when email known)', async () => {
    // 0.4.15 risk posture: background polls never call userinfo just to detect
    // account switching — only manual force refreshes pay that network cost.
    const dir = mkdtempSync(join(tmpdir(), 'agy-quota-bg-'))
    const pool = new AccountPoolManager(dir)
    const acc = pool.createAccountSlot('bg-poll')
    pool.updateAccountQuotas(acc.id, { google: { remainingFraction: 0.5 } }, 'stable@gmail.com')

    const tokenDir = join(acc.dir!, '.gemini', 'antigravity-cli')
    mkdirSync(tokenDir, { recursive: true })
    writeFileSync(
      join(tokenDir, 'antigravity-oauth-token'),
      JSON.stringify({ access_token: 'ya29.stable', expiry: Date.now() + 3600_000 }),
      'utf8',
    )

    let userinfoCalls = 0
    class BgService extends QuotaService {
      override async fetchUserInfo(): Promise<{ email?: string; name?: string } | null> {
        userinfoCalls++
        return null
      }
      override async fetchQuotaSummary() {
        return { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-08-27T12:00:00Z' }] }] } as never
      }
      override async fetchAvailableModels() {
        return { models: {} } as never
      }
    }

    const svc = new BgService(pool)
    const out = await svc.refreshAccountQuota(pool.getAccount(acc.id)!, false)
    expect(userinfoCalls).toBe(0)
    expect(out?.google?.remainingFraction).toBe(0.9)
    expect(pool.getAccount(acc.id)!.email).toBe('stable@gmail.com')
  })

  it('detectEmailFromAgyLogs returns the latest email in a log file, not the first', () => {
    // Logs are append-ordered: an old login can appear ABOVE a newer one.
    // First-match returned the OLD account; the last match is the current one.
    const dir = mkdtempSync(join(tmpdir(), 'agy-log-last-'))
    const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'cli-20260827_100000.log'),
      'OAuth: authenticated successfully as old.account@google.com\n' +
        '...hours pass...\n' +
        'OAuth: authenticated successfully as new.account@google.com\n',
      'utf8',
    )
    expect(detectEmailFromAgyLogs(dir)).toBe('new.account@google.com')
  })

  it('detectEmailFromAgyLogs extracts user email from agy log files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-log-test-'))
    const logDir = join(dir, '.gemini', 'antigravity-cli', 'log')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, 'cli-20260820_120000.log'),
      'ERROR: logging before google.Init: OAuth: authenticated successfully as dev.user@google.com\n',
      'utf8',
    )
    const email = detectEmailFromAgyLogs(dir)
    expect(email).toBe('dev.user@google.com')
  })

  it('shouldPollAccount skips restricted accounts in background polling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-poll-gate-'))
    const pool = new AccountPoolManager(dir)
    const healthy = pool.createAccountSlot('healthy')
    const cooling = pool.createAccountSlot('cooling')
    const quarantined = pool.createAccountSlot('quarantined')
    const disabled = pool.createAccountSlot('disabled')

    // healthy: pollable as-is
    expect(shouldPollAccount(pool.getAccount(healthy.id)!)).toBe(true)

    // cooling: 429 cooldown active -> skipped until it expires
    pool.recordFailure(cooling.id, 'google', 'RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 21m25s.')
    expect(shouldPollAccount(pool.getAccount(cooling.id)!)).toBe(false)

    // quarantined: invalid_grant -> skipped until re-auth
    pool.markAuthRequired(quarantined.id, 'invalid_grant')
    expect(shouldPollAccount(pool.getAccount(quarantined.id)!)).toBe(false)

    // disabled: skipped
    const dis = pool.getAccount(disabled.id)!
    dis.enabled = false
    expect(shouldPollAccount(dis)).toBe(false)

    // expired cooldown becomes pollable again
    const cd = pool.getAccount(cooling.id)!.cooldowns.google!
    cd.cooldownUntil = Date.now() - 1
    expect(shouldPollAccount(pool.getAccount(cooling.id)!)).toBe(true)
  })

  it('mergeFallbackFamilyQuota keeps last-known-good data over partial fallback', () => {
    // Real incident shape: complete entry (5h + weekly) existed, then the
    // summary endpoint blipped and per-model fallback arrived carrying a
    // single window (fraction 1, weekly-window reset a week out, no weekly).
    const good: FamilyQuotaInfo = {
      remainingFraction: 0.84,
      resetTime: '2026-08-25T14:01:28Z',
      weeklyFraction: 0.47,
      weeklyResetTime: '2026-08-27T08:13:04Z',
      updatedAt: 1_000,
    }
    const partial = {
      remainingFraction: 1,
      resetTime: '2026-09-01T09:53:06Z',
      updatedAt: 2_000,
    }
    // Complete previous data wins — never clobbered by the partial shape.
    expect(mergeFallbackFamilyQuota(good, partial)).toBe(good)
    expect(mergeFallbackFamilyQuota(good, partial).weeklyFraction).toBe(0.47)
    // No previous data (first-ever refresh) → fallback fills in.
    expect(mergeFallbackFamilyQuota(undefined, partial)).toBe(partial)
    // Degenerate previous entry without a fraction → fallback fills in.
    expect(mergeFallbackFamilyQuota({ weeklyFraction: 0.5 }, partial)).toBe(partial)
  })
})
