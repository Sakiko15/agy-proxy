// API-key auth for /v1/* (charter §5 key-store row; types.ts promised this
// M3 replacement "behind the same middleware"). Two key sources share the
// hook:
//   • the bootstrap root key from AGY_PROXY_API_KEY (environment-only — never
//     in the runtime-overrides file; its value never reaches a log line) —
//     unlimited and not rate-limited, keeping M1/M2 tests and dev flows
//     byte-identical, and compared via sha256 + timingSafeEqual (both digests
//     exactly 32 bytes: no throw path, no length leak);
//   • managed keys from the KeyStore (sha256 hex hash at rest; verify() is an
//     indexed equality lookup on a high-entropy digest — the LiteLLM pattern
//     the charter prescribes).
// Verdict matrix (MA4): missing/unknown → 401 (texts unchanged), disabled →
// 403 permission_error, RPM over-limit → 429 + Retry-After, daily-token
// over-limit → 429 + Retry-After with the quota type and reset time named
// (MA5). Budget checks run here, PRE-ENGINE: a rejected request never
// spawns agy. Header extraction via apiKeyFrom prefers x-api-key (Anthropic
// client convention) over Bearer.
import { createHash, timingSafeEqual } from 'node:crypto'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { GatewayConfig } from '../common/types.ts'
import { anthropicError, authErrorFor, httpError, isAnthropicPath, quotaRejectFor } from './errors.ts'
import type { KeyStore } from './key-store.ts'
import type { UsageLedger } from './usage-ledger.ts'

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const m = header.match(/^Bearer\s+(\S+)$/i)
  return m?.[1] ?? null
}

/**
 * Extract the API key from either auth header style. `x-api-key` is the
 * Anthropic client convention (MA4); Authorization: Bearer is OpenAI's.
 * Both are honored on every /v1 route.
 */
export function apiKeyFrom(headers: { authorization?: string | undefined; 'x-api-key'?: string | string[] | undefined }): string | null {
  const xKey = headers['x-api-key']
  if (typeof xKey === 'string' && xKey.trim() !== '') return xKey.trim()
  if (Array.isArray(xKey)) {
    const first = xKey.find((v) => typeof v === 'string' && v.trim() !== '')
    if (first !== undefined) return first.trim()
  }
  return bearerToken(headers.authorization)
}

export function keyMatches(expected: string, provided: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export interface AuthenticatedKey {
  id: string | null
  name: string
}

interface RequestWithKey {
  agyKey?: AuthenticatedKey
}

/** The auth hook's per-request key annotation (app.ts reads it into call.meta). */
export function requestKey(request: FastifyRequest): AuthenticatedKey | undefined {
  return (request as unknown as RequestWithKey).agyKey
}

export interface AuthDeps {
  getConfig: () => GatewayConfig
  /** Managed-key store; absent → env-key-only behavior identical to M2. */
  keys?: KeyStore
  /** Daily-token budget source for managed keys. */
  ledger?: UsageLedger
}

/** Send a GatewayHttpError (or an equivalent shape) from inside the hook. */
async function sendError(reply: FastifyReply, err: { statusCode: number; body: unknown; headers?: Record<string, string> }): Promise<void> {
  await reply.code(err.statusCode).headers(err.headers ?? {}).send(err.body)
}

export function buildAuthHook(deps: AuthDeps): preHandlerHookHandler {
  return async (request, reply) => {
    const cfg = deps.getConfig()
    // Auth-disabled posture FIRST (M2 parity): no env key and no managed keys
    // in the store → /v1/* is open (the boot warning covers the posture).
    if (cfg.apiKey === '' && (deps.keys === undefined || deps.keys.count() === 0)) {
      ;(request as unknown as RequestWithKey).agyKey = { id: null, name: 'anon' }
      return
    }
    const provided = apiKeyFrom(request.headers)
    if (provided === null) {
      await reply
        .code(401)
        .send(
          authErrorFor(
            request.url,
            'Missing API key. Pass it as `Authorization: Bearer <key>` or `x-api-key: <key>`.',
          ).body,
        )
      return
    }

    // 1) Bootstrap root key (timing-safe compare). Unlimited, no rate limits.
    if (cfg.apiKey !== '' && keyMatches(cfg.apiKey, provided)) {
      ;(request as unknown as RequestWithKey).agyKey = { id: null, name: 'root' }
      return
    }

    // 2) Managed keys. Without a store, fall back to the legacy single-key
    //    behavior (M2 parity for every existing caller that passes no store).
    if (deps.keys === undefined) {
      if (cfg.apiKey === '') return // auth disabled
      if (keyMatches(cfg.apiKey, provided)) return
      await reply.code(401).send(authErrorFor(request.url, 'Invalid API key provided.').body)
      return
    }

    const verdict = deps.keys.verify(provided)
    if (verdict.verdict === 'unknown') {
      await reply.code(401).send(authErrorFor(request.url, 'Invalid API key provided.').body)
      return
    }
    if (verdict.verdict === 'disabled') {
      const message = `API key '${verdict.key.prefix}…' is disabled.`
      await reply
        .code(403)
        .send(
          isAnthropicPath(request.url)
            ? anthropicError('permission_error', message)
            : httpError(403, message, 'permission_error', 'key_disabled').body,
        )
      return
    }

    // 3) Per-key rate limit (charter §10: RateLimiterMemory + 429 Retry-After).
    const rpm = verdict.key.rpmLimit
    if (rpm > 0) {
      const limiter = getLimiter(verdict.key.id, rpm)
      try {
        await limiter.consume(1)
      } catch (res) {
        const sec = Math.max(1, Math.ceil(((res as { msBeforeNext?: number }).msBeforeNext ?? 1000) / 1000))
        await sendError(reply, quotaRejectFor(request.url, `Requests per-minute limit reached for this key (rpm=${rpm}). Retry in ${sec}s.`, sec))
        return
      }
    }

    // 4) Daily token budget (MA5): reject BEFORE the engine spawns agy.
    const daily = verdict.key.dailyTokenLimit
    if (daily > 0 && deps.ledger !== undefined) {
      const used = deps.ledger.tokensUsedToday(verdict.key.id)
      if (used >= daily) {
        const resetMs = msUntilLocalMidnight()
        const sec = Math.max(1, Math.ceil(resetMs / 1000))
        const message = `Daily token limit reached for this key: used ${used} of ${daily} tokens (daily_token_limit). Resets at ${new Date(Date.now() + resetMs).toISOString()} (in ${sec}s).`
        await sendError(reply, quotaRejectFor(request.url, message, sec))
        return
      }
    }

    ;(request as unknown as RequestWithKey).agyKey = { id: verdict.key.id, name: verdict.key.name }
    deps.keys.touch(verdict.key.id)
  }
}

// ---- per-key rate limiters (created lazily, keyed id:rpm) --------------------
const limiters = new Map<string, RateLimiterMemory>()

function getLimiter(keyId: string, rpm: number): RateLimiterMemory {
  const cacheKey = `${keyId}:${rpm}`
  let limiter = limiters.get(cacheKey)
  if (limiter === undefined) {
    limiter = new RateLimiterMemory({ points: rpm, duration: 60 })
    limiters.set(cacheKey, limiter)
  }
  return limiter
}

export function msUntilLocalMidnight(): number {
  const next = new Date()
  next.setHours(24, 0, 0, 0)
  return next.getTime() - Date.now()
}