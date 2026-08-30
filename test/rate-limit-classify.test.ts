// Ported from dsh-agy-link test/rate-limit-classify.test.ts @ 46984db
// (converted: node:test/assert → vitest describe/it/expect).
import { describe, it, expect } from 'vitest'
import { looksLikeRateLimit, looksLikeHardRateLimit } from '../src/common/types.ts'

// Captured verbatim from a real incident: a cortex tool / permission error
// that the old loose classifier (bare `429` / bare `rate limit`) sometimes saw
// alongside quota-ish words in stdout, misclassifying the whole run as a
// rate limit and freezing a healthy account with a ghost cooldown.
const REAL_TOOL_ERROR =
  'declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) /Users/zqy/Developer/academic-agent/frontend/src/components/landing/LandingNavbar.tsx is not a valid artifact path; artifacts must be in /Users/zqy/.dsh/agy-accounts/acc_1787217298501_cul90/.gemini/antigravity-cli/brain/f94449b8-3395-4b85-bdc1-cba6deeeee94/'

describe('rate-limit classification', () => {
  it('looksLikeHardRateLimit matches real server-issued quota signatures', () => {
    expect(looksLikeHardRateLimit('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 21m25s.')).toBe(true)
    expect(looksLikeHardRateLimit('Rate limit or quota reached')).toBe(true)
    expect(looksLikeHardRateLimit('retry: attempt 2 failed (429: Too Many Requests)')).toBe(true)
    expect(looksLikeHardRateLimit('You exceeded your quota. Try again after 2026-08-25T09:00:00Z.')).toBe(true)
  })

  it('looksLikeHardRateLimit rejects incidental substrings and unrelated errors', () => {
    // Real incident text (tool/permission failure): must NOT be a rate limit.
    expect(looksLikeHardRateLimit(REAL_TOOL_ERROR)).toBe(false)
    // UUID/hash fragments that happen to contain 429.
    expect(looksLikeHardRateLimit('conversation f94449b8-3395-4b85-bdc1-cba6deeeee94 not found')).toBe(false)
    // Model prose merely mentioning limits.
    expect(looksLikeHardRateLimit('the API docs say rate limits may apply during peak hours')).toBe(false)
    expect(looksLikeHardRateLimit(undefined)).toBe(false)
    expect(looksLikeHardRateLimit('')).toBe(false)
  })

  it('soft looksLikeRateLimit keeps capacity signals out of the hard set', () => {
    // Overload / high traffic: soft yes (message shaping), hard no (no cooldown).
    expect(looksLikeRateLimit('model overloaded')).toBe(true)
    expect(looksLikeHardRateLimit('model overloaded')).toBe(false)
    expect(looksLikeRateLimit('server experiencing high traffic, retry later')).toBe(true)
    expect(looksLikeHardRateLimit('server experiencing high traffic, retry later')).toBe(false)
    // Soft still includes everything hard.
    expect(looksLikeRateLimit('RESOURCE_EXHAUSTED (code 429)')).toBe(true)
    // And stays silent on the incident text.
    expect(looksLikeRateLimit(REAL_TOOL_ERROR)).toBe(false)
  })
})
