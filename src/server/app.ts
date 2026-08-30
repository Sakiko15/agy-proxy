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
import type { StreamChunk } from '../host/stream-types.ts'
import type { GatewayConfig } from '../common/types.ts'
import { redactLine } from '../host/diagnostics.ts'
import { buildAuthHook } from './auth.ts'
import {
  GatewayHttpError,
  engineFailureToHttp,
  httpError,
  openAiError,
} from './errors.ts'
import {
  assembleCompletion,
  collectChunks,
  mapChatRequest,
  newCompletionId,
} from './openai-adapter.ts'
import { InFlightTracker } from './shutdown.ts'

export interface ServerDeps {
  getConfig: () => GatewayConfig
  engine: AgyEngine
  log: PinoLogger
}

export interface BuiltServer {
  app: AppInstance
  inFlight: InFlightTracker
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
  const app = Fastify({
    loggerInstance: deps.log,
    bodyLimit: 32 * 1024 * 1024,
    genReqId: () => randomUUID(),
  })

  const inFlight = new InFlightTracker()

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof GatewayHttpError) {
      void reply.code(err.statusCode).send(err.body)
      return
    }
    // TypeBox/Fastify validation and malformed-JSON bodies.
    const status = err instanceof Error && 'statusCode' in err ? (err as { statusCode?: number }).statusCode : undefined
    const validation = err instanceof Error && 'validation' in err ? (err as { validation?: unknown }).validation : undefined
    if (validation !== undefined || status === 400 || status === 413) {
      const message = err instanceof Error ? err.message : String(err)
      void reply
        .code(status ?? 400)
        .send(openAiError(message, 'invalid_request_error', 'invalid_request'))
      return
    }
    const detail = redactLine(err instanceof Error ? err.message : String(err))
    request.log.error({ err: detail }, 'internal error')
    void reply.code(500).send(openAiError('Internal server error: ' + detail, 'api_error', 'internal_error'))
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.code(404).send(httpError(404, 'Not found.', 'invalid_request_error', 'not_found').body)
  })

  app.get('/healthz', async () => ({ ok: true }))

  app.post('/v1/chat/completions', { preHandler: buildAuthHook(deps), ...chatRequestSchema }, async (request, reply) => {
    const cfg = deps.getConfig()
    if (!cfg.enabled) {
      throw httpError(503, 'gateway is disabled by config (enabled=false)', 'api_error', 'gateway_disabled')
    }

    const { call, meta } = mapChatRequest(request.body, cfg)
    for (const w of meta.warnings) request.log.info({ warning: w }, 'request-mapping warning')

    const abort = new AbortController()
    inFlight.add(abort)
    // Client disconnect must cascade into the agy process tree (charter §6):
    // the engine passes `signal` to startAgyProcess, whose abort kills the
    // process group.
    request.raw.on('close', () => {
      if (!reply.sent) abort.abort(new Error('client disconnected'))
    })

    try {
      const chunks: StreamChunk[] = []
      for await (const ch of deps.engine.stream({ ...call, signal: abort.signal })) {
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
        stop: [],
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
        throw engineFailureToHttp(redactLine(err.message), code)
      }
      throw err
    } finally {
      inFlight.remove(abort)
    }
  })

  return { app, inFlight }
}
