// Static bearer-key auth for /v1/* (interim until the M3 sha256 key store;
// user decision: key 管理 lands in M3). The key lives in the environment
// only — never in the runtime-overrides file — and its value never reaches a
// log line: hooks log the verdict only, and the pino redact paths in
// logger.ts cover the header as a second layer.
// New code, not a port. Comparison is sha256-digest + timingSafeEqual: both
// digests are exactly 32 bytes (no throw path, no length leak).
import { createHash, timingSafeEqual } from 'node:crypto'
import type { preHandlerHookHandler } from 'fastify'
import type { GatewayConfig } from '../common/types.ts'
import { authErrorFor } from './errors.ts'

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

export function buildAuthHook(deps: { getConfig: () => GatewayConfig }): preHandlerHookHandler {
  return async (request, reply) => {
    const expected = deps.getConfig().apiKey
    if (expected === '') return // auth disabled (boot warning covers the posture)
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
    if (!keyMatches(expected, provided)) {
      await reply.code(401).send(authErrorFor(request.url, 'Invalid API key provided.').body)
      return
    }
  }
}
