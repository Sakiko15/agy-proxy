// HTTP error model: EngineError codes → OpenAI error bodies (charter §4.4).
// One mapping table for both error paths — pre-flight EngineError throws and
// terminal finish chunks { kind: 'error' | 'aborted' } — so a non-streaming
// request never receives a 200 body describing its own failure.
// agy's real error text is ALWAYS passed through verbatim in `message`
// (dsh-agy-link v0.4.21 lesson: bare "exited with code 1" hid the cause).
export interface OpenAiErrorBody {
  error: {
    message: string
    type: string
    code: string
    /** Official error-object anatomy; we never attribute a param, so null. */
    param: string | null
  }
}

export function openAiError(message: string, type: string, code: string): OpenAiErrorBody {
  return { error: { message, type, code, param: null } }
}

export class GatewayHttpError extends Error {
  readonly statusCode: number
  readonly body: OpenAiErrorBody | AnthropicErrorBody
  /** Optional response headers (Retry-After on rate-limit rejections). */
  readonly headers?: Record<string, string>

  constructor(statusCode: number, body: OpenAiErrorBody | AnthropicErrorBody, headers?: Record<string, string>) {
    super(body.error.message)
    this.name = 'GatewayHttpError'
    this.statusCode = statusCode
    this.body = body
    this.headers = headers
  }
}

/** Protocol-native error, already carrying OpenAI's own `code` vocabulary. */
export function httpError(statusCode: number, message: string, type: string, code: string): GatewayHttpError {
  return new GatewayHttpError(statusCode, openAiError(message, type, code))
}

/**
 * Err code → HTTP status + OpenAI error type. AGY_NOT_INSTALLED → 503 is a
 * deliberate extension of the charter table: a boot-dormant gateway should
 * surface "not installed" per request instead of a generic 500.
 */
export function errorStatus(code: string): { statusCode: number; type: string } {
  switch (code) {
    case 'AUTH':
      return { statusCode: 401, type: 'authentication_error' }
    case 'UNKNOWN_MODEL':
      return { statusCode: 404, type: 'invalid_request_error' }
    case 'BUSY':
    case 'POOL_EXHAUSTED':
      return { statusCode: 429, type: 'rate_limit_error' }
    case 'VALIDATION_REQUIRED':
    case 'MODEL_NOT_ALLOWED':
      return { statusCode: 403, type: 'permission_error' }
    case 'UNSUPPORTED_REASONING_EFFORT':
      return { statusCode: 400, type: 'invalid_request_error' }
    case 'AGY_NOT_INSTALLED':
      return { statusCode: 503, type: 'api_error' }
    case 'TIMEOUT':
    case 'PROCESS_EXIT':
    case 'INVALID_OUTPUT':
    case 'AGY_ERROR':
    case 'AGY_VERSION_UNSUPPORTED':
      return { statusCode: 502, type: 'api_error' }
    default:
      return { statusCode: 500, type: 'api_error' }
  }
}

/** Map an engine failure (thrown or terminal) onto an HTTP error response. */
export function engineFailureToHttp(message: string, code: string, headers?: Record<string, string>): GatewayHttpError {
  const { statusCode, type } = errorStatus(code)
  return new GatewayHttpError(statusCode, openAiError(message, type, code), headers)
}

// ---- Anthropic error model (charter §4.4) -----------------------------------

export interface AnthropicErrorBody {
  type: 'error'
  error: {
    type: string
    message: string
  }
  /** Top-level echo of the gateway's own request id (official API shape). */
  request_id?: string
}

export function anthropicError(type: string, message: string, requestId?: string): AnthropicErrorBody {
  return { type: 'error', error: { type, message }, ...(requestId !== undefined ? { request_id: requestId } : {}) }
}

/**
 * Attach the gateway request id to a body on its way out of the shared error
 * handler. Anthropic bodies get the top-level `request_id`; OpenAI bodies are
 * returned untouched (their anatomy has no such field).
 */
export function stampRequestId(body: OpenAiErrorBody | AnthropicErrorBody, requestId: string): OpenAiErrorBody | AnthropicErrorBody {
  // 'type' exists only on the Anthropic body shape.
  return 'type' in body ? { ...body, request_id: requestId } : body
}

/** Requests under the Anthropic protocol paths get Anthropic error bodies. */
export function isAnthropicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url
  return path.startsWith('/v1/messages') || path.startsWith('/v1/anthropic/')
}

/**
 * Err code → HTTP status + Anthropic error type. The charter type list
 * (§4.4) has no dedicated code for agy-side failure text, so
 * TIMEOUT/PROCESS_EXIT/INVALID_OUTPUT/AGY_ERROR map to api_error 502 like
 * the OpenAI table. One narrow extension: an upstream message matching
 * /overloaded/i (fake-agy real-fail shape; soft rate limit per §4.4) maps to
 * 529 overloaded_error — Anthropic's documented "temporarily overloaded"
 * status. Everything else keeps the Err table's status.
 */
export function anthropicStatusFor(code: string, message: string): { statusCode: number; type: string } {
  if (/overloaded/i.test(message)) return { statusCode: 529, type: 'overloaded_error' }
  switch (code) {
    case 'AUTH':
      return { statusCode: 401, type: 'authentication_error' }
    case 'UNKNOWN_MODEL':
      return { statusCode: 404, type: 'not_found_error' }
    case 'BUSY':
    case 'POOL_EXHAUSTED':
      return { statusCode: 429, type: 'rate_limit_error' }
    case 'VALIDATION_REQUIRED':
    case 'MODEL_NOT_ALLOWED':
      return { statusCode: 403, type: 'permission_error' }
    case 'UNSUPPORTED_REASONING_EFFORT':
      return { statusCode: 400, type: 'invalid_request_error' }
    case 'AGY_NOT_INSTALLED':
      return { statusCode: 503, type: 'api_error' }
    case 'TIMEOUT':
    case 'PROCESS_EXIT':
    case 'INVALID_OUTPUT':
    case 'AGY_ERROR':
    case 'AGY_VERSION_UNSUPPORTED':
      return { statusCode: 502, type: 'api_error' }
    default:
      return { statusCode: 500, type: 'api_error' }
  }
}

/** Map an engine failure onto an Anthropic error response. */
export function engineFailureToAnthropic(
  message: string,
  code: string,
  headers?: Record<string, string>,
): { statusCode: number; body: AnthropicErrorBody; headers?: Record<string, string> } {
  const { statusCode, type } = anthropicStatusFor(code, message)
  return { statusCode, body: anthropicError(type, message), headers }
}

/**
 * Auth failures thrown by the shared hook: the Anthropic paths must receive
 * the Anthropic error shape ({type:'error',error:{...}}), OpenAI paths keep
 * {error:{...}}. Same status/type rows as anthropicStatusFor for AUTH.
 */
export function authErrorFor(url: string, message: string, requestId?: string): GatewayHttpError {
  if (isAnthropicPath(url)) {
    return new GatewayHttpError(401, anthropicError('authentication_error', message, requestId))
  }
  return httpError(401, message, 'authentication_error', 'invalid_api_key')
}

/**
 * Per-key quota rejections (MA4/MA5): RPM and daily-token over-limit map to
 * 429 rate_limit_error with a Retry-After header, bodies following the same
 * per-protocol branching as auth errors. The message must name the quota
 * type (RPM limit / daily_token_limit) and the reset time (MA5).
 */
export function quotaRejectFor(url: string, message: string, retryAfterSec: number, requestId?: string): GatewayHttpError {
  const headers = { 'retry-after': String(Math.max(1, Math.round(retryAfterSec))) }
  if (isAnthropicPath(url)) {
    return new GatewayHttpError(429, anthropicError('rate_limit_error', message, requestId), headers)
  }
  return new GatewayHttpError(429, openAiError(message, 'rate_limit_error', 'rate_limit_exceeded'), headers)
}
