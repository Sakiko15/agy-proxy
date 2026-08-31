// Fastify app factory (charter §3 service layer). The engine and config are
// injected so tests can build the app with a fake-agy-backed engine and
// app.inject() without listening. New code, not a port. Logging discipline
// (G4): log sites carry request metadata only — bodies, headers, and prompt
// text never enter a log line.
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Type } from '@sinclair/typebox'
import type { FastifyInstance } from 'fastify'
import type { Logger as PinoLogger } from 'pino'

/** Fastify instance bound to our concrete pino logger type (loggerInstance). */
export type AppInstance = FastifyInstance<any, any, any, PinoLogger, any>
import type { AgyEngine } from '../host/engine.ts'
import type { StreamChunk, TokenUsage } from '../host/stream-types.ts'
import type { GatewayConfig } from '../common/types.ts'
import { redactLine } from '../host/diagnostics.ts'
import { buildAuthHook, requestKey } from './auth.ts'
import { registerAdminApi, type AdminDeps } from './admin-api.ts'
import {
  GatewayHttpError,
  engineFailureToHttp,
  httpError,
  openAiError,
  anthropicError,
  isAnthropicPath,
  type OpenAiErrorBody,
} from './errors.ts'
import {
  assembleCompletion,
  collectChunks,
  mapChatRequest,
  newCompletionId,
  openAiStreamFrames,
  type RequestMeta,
} from './openai-adapter.ts'
import type { EngineCall } from '../host/engine.ts'
import { SseWriter } from './sse.ts'
import { InFlightTracker } from './shutdown.ts'
import {
  assembleMessage,
  collectChunks as collectAnthropicChunks,
  estimateInputTokens,
  anthropicStreamEvents,
  mapMessagesRequest,
  newMessageId,
  type AnthropicRequestMeta,
} from './anthropic-adapter.ts'
import { engineFailureToAnthropic } from './errors.ts'
import { registerModelRoutes } from './models-routes.ts'
import type { KeyStore } from './key-store.ts'
import type { UsageLedger } from './usage-ledger.ts'

import type { ModelCatalog } from '../host/models.ts'

export interface ServerDeps {
  getConfig: () => GatewayConfig
  engine: AgyEngine
  /** Model catalog for the OA8 model pre-validation (advisory when fallback). */
  catalog: ModelCatalog
  log: PinoLogger
  /** M3 optional subsystems; absent → M2 behavior (env key only, no /admin, no ledger). */
  keys?: KeyStore
  ledger?: UsageLedger
  admin?: AdminDeps
}

export interface BuiltServer {
  app: AppInstance
  inFlight: InFlightTracker
}

/**
 * Per-request image byte reader: the protocol adapters decode data:/base64
 * payloads into meta.imageBytes; the engine's stager pulls the bytes back
 * through this closure, keyed by the staged ref's attachmentId (the
 * adapter-assigned img-N name). Without it the engine finds no reader and
 * silently skips staging — data: images would never reach the prompt or the
 * --add-dir argv.
 */
function stagedImageReader(meta: { imageBytes: Map<string, Uint8Array> }): NonNullable<EngineCall['readImage']> | undefined {
  if (meta.imageBytes.size === 0) return undefined
  return (ref) => Promise.resolve(meta.imageBytes.get(ref.attachmentId) ?? null)
}

/**
 * Merge the server-side observability meta into an outgoing EngineCall: the
 * ledger request id (client x-request-id wins — it is the replay-idempotency
 * key, DoD ⑥), the authenticated key id (null = bootstrap root key), and the
 * protocol surface. The enriched settle-time onRun echoes it back.
 */
function withCallMeta(
  request: Pick<import('fastify').FastifyRequest, 'headers' | 'id'>,
  call: EngineCall,
  protocol: 'openai' | 'anthropic',
  readImage?: EngineCall['readImage'],
): EngineCall {
  const hdr = request.headers['x-request-id']
  return {
    ...call,
    ...(readImage !== undefined ? { readImage } : {}),
    meta: {
      reqId: typeof hdr === 'string' && hdr.trim() !== '' ? hdr.trim() : request.id,
      keyId: requestKey(request as import('fastify').FastifyRequest)?.id ?? null,
      protocol,
    },
  }
}

/**
 * Retry-After headers for engine failures that carry one (POOL_EXHAUSTED's
 * EngineError.retryAfterSec). SSE legs ignore it — by then the headers are
 * already sent and the countdown text rides the error payload itself.
 */
function retryHeaders(retryAfterSec?: number): Record<string, string> | undefined {
  return retryAfterSec !== undefined ? { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) } : undefined
}

// Permissive on purpose: OpenAI-compatible gateways in the wild accept extra
// fields, and the mapper decides — with explicit 400s — which known fields
// are unsupported. Only the shapes we branch on are tightened here.
const chatRequestSchema = {
  schema: {
    body: Type.Object(
      {
        model: Type.Optional(Type.String({ minLength: 1 })),
        messages: Type.Optional(
          Type.Array(Type.Object({}, { additionalProperties: true }), { minItems: 1 }),
        ),
        stream: Type.Optional(Type.Boolean()),
        n: Type.Optional(Type.Number()),
        temperature: Type.Optional(Type.Number()),
        top_p: Type.Optional(Type.Number()),
      },
      { additionalProperties: true },
    ),
  },
}

export function buildServer(deps: ServerDeps): BuiltServer {
  const cfg0 = deps.getConfig()
  // TRUSTED_PROXIES → real client IP for the admin CIDR allowlist (charter
  // §10 transport row). An empty list keeps inject()/local behavior intact.
  const trusted = new Set(
    cfg0.trustedProxies
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  const app = Fastify({
    loggerInstance: deps.log,
    bodyLimit: 32 * 1024 * 1024,
    genReqId: () => randomUUID(),
    ...(trusted.size > 0 ? { trustProxy: (addr: string) => trusted.has(addr) } : {}),
  })

  const inFlight = new InFlightTracker()
  const authHook = buildAuthHook(deps)

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof GatewayHttpError) {
      void reply.code(err.statusCode).headers(err.headers ?? {}).send(err.body)
      return
    }
    // TypeBox/Fastify validation and malformed-JSON bodies.
    const status = err instanceof Error && 'statusCode' in err ? (err as { statusCode?: number }).statusCode : undefined
    const validation = err instanceof Error && 'validation' in err ? (err as { validation?: unknown }).validation : undefined
    if (validation !== undefined || status === 400 || status === 413) {
      const message = err instanceof Error ? err.message : String(err)
      if (isAnthropicPath(request.url)) {
        void reply.code(status ?? 400).send(anthropicError('invalid_request_error', message))
      } else {
        void reply
          .code(status ?? 400)
          .send(openAiError(message, 'invalid_request_error', 'invalid_request'))
      }
      return
    }
    const detail = redactLine(err instanceof Error ? err.message : String(err))
    request.log.error({ err: detail }, 'internal error')
    if (isAnthropicPath(request.url)) {
      void reply.code(500).send(anthropicError('api_error', 'Internal server error: ' + detail))
    } else {
      void reply.code(500).send(openAiError('Internal server error: ' + detail, 'api_error', 'internal_error'))
    }
  })

  app.setNotFoundHandler((request, reply) => {
    if (isAnthropicPath(request.url)) {
      void reply.code(404).send(anthropicError('not_found_error', 'Not found.'))
    } else {
      void reply.code(404).send(httpError(404, 'Not found.', 'invalid_request_error', 'not_found').body)
    }
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.post('/v1/chat/completions', { preHandler: authHook, ...chatRequestSchema }, async (request, reply) => {
    const cfg = deps.getConfig()
    if (!cfg.enabled) {
      throw httpError(503, 'gateway is disabled by config (enabled=false)', 'api_error', 'gateway_disabled')
    }

    const { call, meta } = await mapChatRequest(request.body, cfg, deps.catalog.get())
    for (const w of meta.warnings) request.log.info({ warning: w }, 'request-mapping warning')
    const readImage = stagedImageReader(meta)

    const abort = new AbortController()
    inFlight.add(abort)
    // Client disconnect must cascade into the agy process tree (charter §6):
    // the engine passes `signal` to startAgyProcess, whose abort kills the
    // process group.
    request.raw.on('close', () => {
      if (!reply.sent) abort.abort(new Error('client disconnected'))
    })

    try {
      if (meta.stream === true) {
        await streamOpenAiChat({ deps, request, reply, call: withCallMeta(request, call, 'openai', readImage), meta, abort, inFlight })
        return
      }
      const chunks: StreamChunk[] = []
      for await (const ch of deps.engine.stream(withCallMeta(request, call, 'openai', readImage))) {
        chunks.push(ch)
      }
      const collected = collectChunks(chunks)
      const finish = collected.finish
      if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
        throw engineFailureToHttp(finish.failure.message, finish.failure.code)
      }
      const body = assembleCompletion({
        id: newCompletionId(),
        created: Math.floor(Date.now() / 1000),
        requestModel: call.model,
        collected,
        stop: meta.stop,
        ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
      })
      request.log.info(
        {
          model: call.model,
          promptTokens: body.usage.prompt_tokens,
          completionTokens: body.usage.completion_tokens,
          finishKind: finish?.kind ?? 'stop',
        },
        'request complete',
      )
      return reply.code(200).send(body)
    } catch (err) {
      if (err instanceof GatewayHttpError) throw err
      if (err instanceof Error && err.name === 'EngineError') {
        const code = (err as { code?: string }).code ?? 'AGY_ERROR'
        throw engineFailureToHttp(redactLine(err.message), code, retryHeaders((err as { retryAfterSec?: number }).retryAfterSec))
      }
      throw err
    } finally {
      inFlight.remove(abort)
    }
  })

  // ---- Anthropic Messages (charter §4.1: POST /v1/messages, stream + non-stream)

  const messagesRequestSchema = {
    schema: {
      body: Type.Object(
        {
          model: Type.Optional(Type.String({ minLength: 1 })),
          max_tokens: Type.Optional(Type.Number()),
          stream: Type.Optional(Type.Boolean()),
          messages: Type.Optional(
            Type.Array(Type.Object({}, { additionalProperties: true }), { minItems: 1 }),
          ),
        },
        { additionalProperties: true },
      ),
    },
  }

  app.post('/v1/messages', { preHandler: authHook, ...messagesRequestSchema }, async (request, reply) => {
    const cfg = deps.getConfig()
    if (!cfg.enabled) {
      throw new GatewayHttpError(503, anthropicError('api_error', 'gateway is disabled by config (enabled=false)'))
    }

    const { call, meta } = await mapMessagesRequest(request.body, cfg, deps.catalog.get())
    for (const w of meta.warnings) request.log.info({ warning: w }, 'request-mapping warning')
    const readImage = stagedImageReader(meta)

    const abort = new AbortController()
    inFlight.add(abort)
    request.raw.on('close', () => {
      if (!reply.sent) abort.abort(new Error('client disconnected'))
    })

    try {
      if (meta.stream === true) {
        await streamAnthropicMessages({ deps, request, reply, call: withCallMeta(request, call, 'anthropic', readImage), meta, abort, inFlight })
        return
      }
      const chunks: StreamChunk[] = []
      for await (const ch of deps.engine.stream(withCallMeta(request, call, 'anthropic', readImage))) {
        chunks.push(ch)
      }
      const collected = collectAnthropicChunks(chunks)
      const finish = collected.finish
      if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
        const mapped = engineFailureToAnthropic(finish.failure.message, finish.failure.code)
        throw new GatewayHttpError(mapped.statusCode, mapped.body, mapped.headers)
      }
      const body = assembleMessage({
        id: newMessageId(),
        requestModel: call.model,
        collected,
        stop: meta.stop,
        ...(meta.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
      })
      request.log.info(
        {
          model: call.model,
          promptTokens: body.usage.input_tokens,
          completionTokens: body.usage.output_tokens,
          finishKind: finish?.kind ?? 'stop',
        },
        'request complete',
      )
      return reply.code(200).send(body)
    } catch (err) {
      if (err instanceof GatewayHttpError) throw err
      if (err instanceof Error && err.name === 'EngineError') {
        const code = (err as { code?: string }).code ?? 'AGY_ERROR'
        const mapped = engineFailureToAnthropic(redactLine(err.message), code, retryHeaders((err as { retryAfterSec?: number }).retryAfterSec))
        throw new GatewayHttpError(mapped.statusCode, mapped.body, mapped.headers)
      }
      throw err
    } finally {
      inFlight.remove(abort)
    }
  })

  // count_tokens (AN7): deterministic heuristic; response notes non-exactness.
  const countTokensSchema = {
    schema: {
      body: Type.Object(
        {
          model: Type.Optional(Type.String()),
          messages: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
        },
        { additionalProperties: true },
      ),
    },
  }
  app.post('/v1/messages/count_tokens', { preHandler: authHook, ...countTokensSchema }, async (request, reply) => {
    const cfg = deps.getConfig()
    if (!cfg.enabled) {
      throw new GatewayHttpError(503, anthropicError('api_error', 'gateway is disabled by config (enabled=false)'))
    }
    const inputTokens = estimateInputTokens(request.body)
    void cfg
    return reply
      .code(200)
      .header('x-agy-proxy-token-estimate', 'heuristic')
      .send({ input_tokens: inputTokens })
  })

  registerModelRoutes(app, { getConfig: deps.getConfig, catalog: deps.catalog, authHook: authHook as never })

  // M3 admin surface (JSON): mounted only when the admin subsystem is wired
  // (index.ts). Tests/goldens without deps.admin keep the M2 route set.
  if (deps.admin !== undefined) {
    registerAdminApi(app as unknown as Parameters<typeof registerAdminApi>[0], deps.admin)
  }

  return { app, inFlight }
}

/** SSE leg of POST /v1/messages (AN2/AN3/AN5): Anthropic event sequences. */
async function streamAnthropicMessages(args: {
  deps: ServerDeps
  request: import('fastify').FastifyRequest
  reply: import('fastify').FastifyReply
  call: EngineCall
  meta: AnthropicRequestMeta
  abort: AbortController
  inFlight: InFlightTracker
}): Promise<void> {
  const { deps, request, reply, call, meta, abort, inFlight } = args
  const cfg = deps.getConfig()
  const sse = new SseWriter(reply, {
    heartbeatMs: cfg.sseHeartbeatMs,
    keepalive: () => 'event: ping\ndata: {"type":"ping"}\n\n',
  })
  const id = newMessageId()
  const state = { messageStarted: false, blockIndex: 0, openType: null as 'text' | 'thinking' | 'tool_use' | null }
  let usage: TokenUsage | undefined
  let finishKind: string = 'stop'
  try {
    sse.open()
    for await (const ch of deps.engine.stream({ ...call, signal: abort.signal })) {
      if (ch.type === 'usage') {
        usage = ch.usage
        continue
      }
      if (ch.type === 'finish') finishKind = ch.reason.kind
      for (const ev of anthropicStreamEvents({ id, model: call.model, chunk: ch, state, usage })) {
        await sse.event(ev.event, ev.data)
      }
      if (ch.type === 'finish' && (ch.reason.kind === 'error' || ch.reason.kind === 'aborted')) {
        finishKind = ch.reason.kind
        return
      }
    }
    request.log.info(
      { model: call.model, promptTokens: usage?.inputTokens ?? 0, completionTokens: usage?.outputTokens ?? 0, finishKind },
      'request complete',
    )
  } catch (err) {
    // Mid-stream failures surface as an `error` event per charter §4.3.
    let message = 'Internal server error'
    let type = 'api_error'
    if (err instanceof GatewayHttpError) {
      message = err.body.error.message
      type = err.body.error.type
    } else if (err instanceof Error && err.name === 'EngineError') {
      const ec = (err as { code?: string }).code ?? 'AGY_ERROR'
      const mapped = engineFailureToAnthropic(redactLine(err.message), ec)
      message = mapped.body.error.message
      type = mapped.body.error.type
    } else if (err instanceof Error) {
      message = 'Internal server error: ' + redactLine(err.message)
    }
    request.log.error({ finishKind: 'error' }, 'stream failed')
    if (!sse['closed']) {
      await sse.event('error', { type: 'error', error: { type, message } })
    }
  } finally {
    inFlight.remove(abort)
    await sse.close()
  }
}

/** SSE leg of POST /v1/chat/completions (OA2–OA4): hijack + direct frames. */
async function streamOpenAiChat(args: {
  deps: ServerDeps
  request: import('fastify').FastifyRequest
  reply: import('fastify').FastifyReply
  call: EngineCall
  meta: RequestMeta
  abort: AbortController
  inFlight: InFlightTracker
}): Promise<void> {
  const { deps, request, reply, call, meta, abort, inFlight } = args
  const cfg = deps.getConfig()
  const sse = new SseWriter(reply, {
    heartbeatMs: cfg.sseHeartbeatMs,
    keepalive: () => ': ping\n\n',
  })
  const id = newCompletionId()
  const created = Math.floor(Date.now() / 1000)
  const state = { firstSent: false, toolIndex: 0, sawToolThisSpan: false }
  let usage: TokenUsage | undefined
  let finishKind: string = 'stop'
  try {
    sse.open()
    for await (const ch of deps.engine.stream({ ...call, signal: abort.signal })) {
      if (ch.type === 'usage') {
        usage = ch.usage
        continue
      }
      if (ch.type === 'finish') finishKind = ch.reason.kind === 'max-tokens' ? 'max-tokens' : ch.reason.kind
      if (ch.type === 'finish' && (ch.reason.kind === 'error' || ch.reason.kind === 'aborted')) {
        const failure = engineFailureToHttp(ch.reason.failure.message, ch.reason.failure.code)
        const body = failure.body as OpenAiErrorBody
        await sse.data(openAiError(body.error.message, body.error.type, body.error.code))
        await sse.data('[DONE]')
        finishKind = ch.reason.kind
        return
      }
      for (const frame of openAiStreamFrames({
        id,
        created,
        model: call.model,
        chunk: ch,
        state,
        includeUsage: meta.includeUsage,
        usage,
      })) {
        await sse.data(frame)
      }
    }
    request.log.info(
      { model: call.model, promptTokens: usage?.inputTokens ?? 0, completionTokens: usage?.outputTokens ?? 0, finishKind },
      'request complete',
    )
  } catch (err) {
    // Mid-stream failures surface inside the SSE envelope per charter §4.3.
    let message = 'Internal server error'
    let type = 'api_error'
    let code = 'internal_error'
    if (err instanceof GatewayHttpError) {
      message = err.body.error.message
      type = err.body.error.type
      const maybeCode = (err.body as OpenAiErrorBody).error as { code?: string }
      code = maybeCode.code ?? 'api_error'
    } else if (err instanceof Error && err.name === 'EngineError') {
      const ec = (err as { code?: string }).code ?? 'AGY_ERROR'
      const mapped = engineFailureToHttp(redactLine(err.message), ec)
      message = mapped.body.error.message
      type = mapped.body.error.type
      code = ec
    } else if (err instanceof Error) {
      message = 'Internal server error: ' + redactLine(err.message)
    }
    request.log.error({ code, finishKind: 'error' }, 'stream failed')
    if (!sse['closed']) {
      await sse.data(openAiError(message, type, code))
      await sse.data('[DONE]')
    }
  } finally {
    inFlight.remove(abort)
    await sse.close()
  }
}
