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
  }
}

export function openAiError(message: string, type: string, code: string): OpenAiErrorBody {
  return { error: { message, type, code } }
}

export class GatewayHttpError extends Error {
  readonly statusCode: number
  readonly body: OpenAiErrorBody

  constructor(statusCode: number, body: OpenAiErrorBody) {
    super(body.error.message)
    this.name = 'GatewayHttpError'
    this.statusCode = statusCode
    this.body = body
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
      return { statusCode: 429, type: 'rate_limit_error' }
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
export function engineFailureToHttp(message: string, code: string): GatewayHttpError {
  const { statusCode, type } = errorStatus(code)
  return new GatewayHttpError(statusCode, openAiError(message, type, code))
}
