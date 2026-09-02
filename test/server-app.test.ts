// Server skeleton tests: healthz, routing fallbacks, auth matrix, error
// shapes, and log redaction — exercised through app.inject() with a stub
// engine (no spawn). The OpenAI route itself is covered in openai-chat.test.
import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'node:stream'
import type { InjectOptions } from 'light-my-request'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { redactLine } from '../src/host/diagnostics.ts'
import { GatewayHttpError, openAiError } from '../src/server/errors.ts'
import type { AgyEngine } from '../src/host/engine.ts'

function stubEngine(overrides: Partial<AgyEngine> = {}): AgyEngine {
  // The route only calls engine.stream(); cast keeps the test focused.
  return {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'hi' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    ...overrides,
  } as unknown as AgyEngine
}

function makeServer(overrides: Partial<GatewayConfig> = {}, engine: AgyEngine = stubEngine()) {
  const cfg: GatewayConfig = { ...defaultConfig(), ...overrides }
  const log = buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' })
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log })
  return { built, cfg }
}

const REQ: InjectOptions = {
  method: 'POST',
  url: '/v1/chat/completions',
  payload: { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] },
}

describe('server skeleton', () => {
  afterEach(() => {
    delete process.env.AGY_PROXY_API_KEY
  })

  it('GET /healthz responds ok without auth', async () => {
    const { built } = makeServer({ apiKey: 'k' })
    const res = await built.app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await built.app.close()
  })

  it('unknown routes get the OpenAI 404 body', async () => {
    // JSON-only posture: opt out explicitly — cwd web/dist can exist in the
    // repo after a web build (see test/static-web.test.ts for the WebUI pose).
    process.env.AGY_PROXY_WEB_DIST = 'none'
    const { built } = makeServer()
    const res = await built.app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { message: 'Not found.', type: 'invalid_request_error', code: 'not_found', param: null } })
    await built.app.close()
    delete process.env.AGY_PROXY_WEB_DIST
  })

  it('malformed JSON body → 400 invalid_request_error', async () => {
    const { built } = makeServer()
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: '{not json',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error.type).toBe('invalid_request_error')
    await built.app.close()
  })

  it('auth disabled when no key is set', async () => {
    const { built } = makeServer({ apiKey: '' })
    const res = await built.app.inject(REQ)
    expect(res.statusCode).toBe(200)
    await built.app.close()
  })

  it('auth matrix: missing / malformed / wrong / correct key', async () => {
    const { built } = makeServer({ apiKey: 'sekrit' })
    const noHeader = await built.app.inject(REQ)
    expect(noHeader.statusCode).toBe(401)
    expect(noHeader.json().error.code).toBe('invalid_api_key')
    expect(noHeader.json().error.type).toBe('authentication_error')

    const bare = await built.app.inject({ ...REQ, headers: { authorization: 'sekrit' } })
    expect(bare.statusCode).toBe(401)
    const wrongScheme = await built.app.inject({ ...REQ, headers: { authorization: 'Token sekrit' } })
    expect(wrongScheme.statusCode).toBe(401)
    const wrongKey = await built.app.inject({ ...REQ, headers: { authorization: 'Bearer nope' } })
    expect(wrongKey.statusCode).toBe(401)
    // Wildly different length must 401 (digest compare), never 500.
    const longKey = await built.app.inject({ ...REQ, headers: { authorization: 'Bearer ' + 'x'.repeat(1000) } })
    expect(longKey.statusCode).toBe(401)

    const ok = await built.app.inject({ ...REQ, headers: { authorization: 'Bearer sekrit' } })
    expect(ok.statusCode).toBe(200)
    await built.app.close()
  })

  it('GatewayHttpError surfaces its body verbatim; unknown errors → 500 api_error', async () => {
    const failing: AgyEngine = stubEngine({
      stream: async function* () {
        throw new GatewayHttpError(418, openAiError('teapot', 'api_error', 'teapot'))
      },
    } as Partial<AgyEngine>)
    const { built } = makeServer({}, failing)
    const res = await built.app.inject(REQ)
    expect(res.statusCode).toBe(418)
    expect(res.json()).toEqual({ error: { message: 'teapot', type: 'api_error', code: 'teapot', param: null } })
    await built.app.close()

    const unknown: AgyEngine = stubEngine({
      stream: async function* () {
        throw new Error('boom')
      },
    } as Partial<AgyEngine>)
    const built2 = makeServer({}, unknown).built
    const res2 = await built2.app.inject(REQ)
    expect(res2.statusCode).toBe(500)
    expect(res2.json().error.type).toBe('api_error')
    await built2.app.close()
  })

  it('EngineError from pre-flight maps through the Err table', async () => {
    const { AgyEngine: _unused, EngineError } = await import('../src/host/engine.ts')
    const { Err } = await import('../src/common/types.ts')
    const failing: AgyEngine = stubEngine({
      stream: async function* () {
        throw new EngineError('agy is not signed in — add a Google account to the pool (admin UI) to login', Err.AUTH)
      },
    } as Partial<AgyEngine>)
    const { built } = makeServer({}, failing)
    const res = await built.app.inject(REQ)
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH')
    expect(res.json().error.message).toContain('not signed in')
    await built.app.close()
  })

  it('disabled gateway → 503', async () => {
    const { built } = makeServer({ enabled: false })
    const res = await built.app.inject(REQ)
    expect(res.statusCode).toBe(503)
    await built.app.close()
  })
})

// ---- T2: streaming stop-sequence holdback + output budget ------------------
// The SSE legs share StopHoldback/OutputBudget (stream-guards.ts); these
// tests drive both routes with a stub engine so delta boundaries are exact.

/** Split an SSE wire body into {event, data} frames (comments excluded). */
function sseEvents(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const event = (b.split('\n').find((l) => l.startsWith('event:')) ?? '').slice(6).trim()
      const dataLine = b.split('\n').find((l) => l.startsWith('data:')) ?? ''
      return { event, data: JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown> }
    })
}

/** Stub engine streaming the given chunks, recording the abort signal. */
function scriptedEngine(chunks: Array<Record<string, unknown>>, signals: Array<AbortSignal>): AgyEngine {
  return stubEngine({
    stream: async function* (call: { signal?: AbortSignal }) {
      if (call?.signal !== undefined) signals.push(call.signal)
      for (const c of chunks) yield c as never
    },
  } as Partial<AgyEngine>)
}

const TEXT_THEN_STOP: Array<Record<string, unknown>> = [
  { type: 'text-delta', index: 0, text: 'hello ' },
  { type: 'text-delta', index: 0, text: 'ST' },
  { type: 'text-delta', index: 0, text: 'OP' },
  { type: 'text-delta', index: 0, text: ' more' },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('streaming stop_sequences (T2-8)', () => {
  afterEach(() => {
    delete process.env.AGY_PROXY_API_KEY
  })

  it('Anthropic leg: held text never emitted; message_delta echoes the stop', async () => {
    const signals: Array<AbortSignal> = []
    const { built } = makeServer({}, scriptedEngine(TEXT_THEN_STOP, signals))
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'gemini-3.7-flash',
        max_tokens: 100,
        stream: true,
        stop_sequences: ['STOP'],
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    expect(res.statusCode).toBe(200)
    const events = sseEvents(res.body)
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as { text?: string }).text ?? '')
      .join('')
    expect(text).toBe('hello ')
    const md = events.find((e) => e.event === 'message_delta')
    expect(md?.data.delta).toEqual({ stop_reason: 'stop_sequence', stop_sequence: 'STOP' })
    await built.app.close()
  })

  it('OpenAI leg: held text never emitted; finish_reason stays stop', async () => {
    const signals: Array<AbortSignal> = []
    const { built } = makeServer({}, scriptedEngine(TEXT_THEN_STOP, signals))
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gemini-3.7-flash',
        stream: true,
        stop: ['STOP'],
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    expect(res.statusCode).toBe(200)
    const payloads = res.body
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data:') && !b.includes('[DONE]'))
      .map((b) => JSON.parse((b.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5).trim()) as Record<string, unknown>)
    const content = payloads
      .map((p) => (p.choices as Array<{ delta: { content?: string } }> | undefined)?.[0]?.delta.content)
      .filter((c): c is string => typeof c === 'string')
      .join('')
    expect(content).toBe('hello ')
    const finish = payloads.find((p) => (p.choices as Array<{ finish_reason: string | null }>)?.[0]?.finish_reason !== null)
    expect((finish?.choices as Array<{ finish_reason: string }>)[0]?.finish_reason).toBe('stop')
    await built.app.close()
  })

  it('reasoning deltas are never cut by the holdback', async () => {
    const signals: Array<AbortSignal> = []
    const engine = scriptedEngine(
      [
        { type: 'reasoning-delta', index: 0, text: 'STOP is a word in reasoning' },
        { type: 'text-delta', index: 0, text: 'answer' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      signals,
    )
    const { built } = makeServer({}, engine)
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.7-flash', stream: true, stop: ['STOP'], messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const payloads = res.body
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data:') && !b.includes('[DONE]'))
      .map((b) => JSON.parse((b.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5).trim()) as Record<string, unknown>)
    const reasoning = payloads
      .map((p) => (p.choices as Array<{ delta: { reasoning_content?: string } }> | undefined)?.[0]?.delta.reasoning_content)
      .filter((r): r is string => typeof r === 'string')
      .join('')
    expect(reasoning).toBe('STOP is a word in reasoning')
    await built.app.close()
  })
})

describe('streaming max_tokens budget (T2-10)', () => {
  afterEach(() => {
    delete process.env.AGY_PROXY_API_KEY
  })

  const LONG_OUTPUT: Array<Record<string, unknown>> = [
    { type: 'reasoning-delta', index: 0, text: 'thinking ' },
    { type: 'text-delta', index: 0, text: 'x'.repeat(80) },
    { type: 'text-delta', index: 0, text: 'y'.repeat(80) },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 50 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  it('Anthropic leg: engine aborted mid-stream; stop_reason max_tokens', async () => {
    const signals: Array<AbortSignal> = []
    const { built } = makeServer({}, scriptedEngine(LONG_OUTPUT, signals))
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'gemini-3.7-flash',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
    expect(res.statusCode).toBe(200)
    const events = sseEvents(res.body)
    const md = events.find((e) => e.event === 'message_delta')
    expect((md?.data.delta as { stop_reason: string }).stop_reason).toBe('max_tokens')
    // The engine was told to stop generating.
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s.aborted)).toBe(true)
    // The stream terminates at the cut: only the first long delta streams.
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data.delta as { text?: string }).text ?? '')
      .join('')
    expect(text).toBe('x'.repeat(80))
    await built.app.close()
  })

  it('OpenAI leg: engine aborted mid-stream; finish_reason length', async () => {
    const signals: Array<AbortSignal> = []
    const { built } = makeServer({}, scriptedEngine(LONG_OUTPUT, signals))
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.7-flash', stream: true, max_completion_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const payloads = res.body
      .split('\n\n')
      .map((b) => b.trim())
      .filter((b) => b.startsWith('data:') && !b.includes('[DONE]'))
      .map((b) => JSON.parse((b.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5).trim()) as Record<string, unknown>)
    const finish = payloads.find((p) => (p.choices as Array<{ finish_reason: string | null }> | undefined)?.[0]?.finish_reason !== null)
    expect((finish?.choices as Array<{ finish_reason: string }>)[0]?.finish_reason).toBe('length')
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => s.aborted)).toBe(true)
    await built.app.close()
  })
})

describe('log redaction', () => {
  it('buildLogger redacts authorization headers end-to-end', async () => {
    let out = ''
    const sink = new Writable({
      write(chunk: unknown, _enc, cb) {
        out += String(chunk)
        cb()
      },
    })
    const log = buildLogger({ AGY_PROXY_LOG_LEVEL: 'info' }, sink)
    log.info({ req: { headers: { authorization: 'Bearer sk-fake-secret' } } }, 'probe')
    await new Promise((r) => setTimeout(r, 20))
    expect(out).toContain('[redacted]')
    expect(out).not.toContain('sk-fake-secret')
  })

  it('redactLine scrubs bearer tokens, auth urls, and codes', () => {
    expect(redactLine('Bearer abc.def.ghi')).toBe('Bearer <redacted>')
    expect(redactLine('visit https://accounts.google.com/o/oauth2/auth?code=x&scope=y now')).toContain('<auth-url-redacted>')
    // The redactLine regex targets `\b[0-9]{4,}/` — a multi-digit prefix
    // before the slash; "4/..." alone is not scrubbed (upstream behavior).
    expect(redactLine('code 1234/AbCdEf123')).toContain('<code-redacted>')
    expect(redactLine('token ya29.abcdefghijklmnop')).toContain('<oauth-token-redacted>')
  })
})
