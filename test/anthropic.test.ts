// POST /v1/messages e2e (AN1–AN10): non-streaming and streaming legs through
// the real AgyEngine wired to fake-agy, plus count_tokens (AN7), x-api-key
// auth, and the Anthropic error-body branches (AN8).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

let lastWorkDir: string | null = null

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const workDir = mkdtempSync(join(tmpdir(), 'agy-an-'))
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(workDir, 'sessions.json')),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    retryDelay: async () => {}, // M5: failing runs retry once - keep tests fast (timing pinned in engine-retry.test)
    ...deps,
  })
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  lastWorkDir = workDir
  return { built, workDir, cfg }
}

/** Split an SSE body into {event, data} pairs (event name defaults to 'message'). */
function parseSseEvents(body: string): Array<{ event: string; data: string; json: Record<string, unknown> | null }> {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b !== '')
    .map((b) => {
      const lines = b.split('\n')
      const event = (lines.find((l) => l.startsWith('event:')) ?? '').slice(6).trim() || 'message'
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      let json: Record<string, unknown> | null = null
      try {
        json = JSON.parse(data) as Record<string, unknown>
      } catch {
        json = null
      }
      return { event, data, json }
    })
}

function post(built: ReturnType<typeof makeServer>['built'], payload: unknown, headers: Record<string, string> = {}) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/messages',
    payload: payload as object,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const BASE = { model: 'gemini-3.7-flash', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }

/** Drive one full Anthropic turn: replay tool_use blocks with tool_result until end_turn.
 *  For streaming legs the continuation replay still runs non-streaming (hops 2+
 *  of a streamed turn re-post as plain requests — this only exercises the mapper,
 *  the streaming event sequence is asserted on hop 1 directly). */
async function postTurn(built: ReturnType<typeof makeServer>['built'], messages: unknown[], extra: Record<string, unknown> = {}, maxHops = 6) {
  const streaming = extra.stream === true
  let msgs = [...messages]
  let res = await post(built, { ...BASE, messages: msgs, ...(streaming ? { stream: true } : extra) })
  for (let hop = 1; hop < maxHops; hop++) {
    if (res.statusCode !== 200) return res
    if (streaming && res.headers['content-type']?.includes('text/event-stream')) {
      // Parse the streamed tool_use id out of the SSE body, then replay as a
      // plain (non-stream) request to drive the continuation hop.
      const events = parseSseEvents(res.body)
      const tu = events
        .map((e) => e.json)
        .filter((j): j is Record<string, unknown> => j !== null && j.type === 'content_block_start')
        .map((j) => (j.content_block ?? {}) as { type?: string; id?: string })
        .find((b) => b.type === 'tool_use')
      if (tu === undefined || tu.id === undefined) return res
      msgs = [...msgs, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'replayed' }] }]
      res = await post(built, { ...BASE, messages: msgs })
      continue
    }
    const body = res.json() as { content?: Array<{ type: string; id?: string }>; stop_reason?: string }
    const tu = body.content?.find((b) => b.type === 'tool_use')
    if (tu === undefined || tu.id === undefined) return res
    msgs = [...msgs, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: 'replayed' }] }]
    res = await post(built, { ...BASE, messages: msgs, ...(streaming ? {} : extra) })
  }
  return res
}

afterEach(() => {
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_AGY_ARGS_FILE
  delete process.env.AGY_PROXY_SSE_HEARTBEAT_MS
})

describe('AN1: non-streaming basics', () => {
  it('returns a message body with id/type/role/stop_reason/usage', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await postTurn(built, [{ role: 'user', content: 'hi' }])
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      id: string
      type: string
      role: string
      model: string
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      stop_sequence: string | null
      usage: Record<string, number>
    }
    expect(body.id).toMatch(/^msg_[A-Za-z0-9_-]{24}$/)
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.model).toBe('gemini-3.7-flash')
    expect(body.stop_reason).toBe('end_turn')
    expect(body.stop_sequence).toBeNull()
    expect(body.content.some((b) => b.type === 'text' && (b.text ?? '').length > 0)).toBe(true)
    expect(typeof body.usage.input_tokens).toBe('number')
    expect(typeof body.usage.output_tokens).toBe('number')
    await built.app.close()
    rmSync(lastWorkDir ?? '', { recursive: true, force: true })
  })

  it('works without the anthropic-version header (default compat)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, BASE)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { type: string }).type).toBe('message')
    await built.app.close()
  })
})

describe('AN6: system prompt forms', () => {
  it('string and block-array system reach the same engine text', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const r1 = await postTurn(built, [{ role: 'user', content: 'hi' }], { system: 'Be terse.' })
    const r2 = await postTurn(built, [{ role: 'user', content: 'hi' }], {
      system: [{ type: 'text', text: 'Be terse.' }],
    })
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    const b1 = r1.json() as { content: Array<{ type: string; text?: string }> }
    const b2 = r2.json() as { content: Array<{ type: string; text?: string }> }
    const t1 = b1.content.find((b) => b.type === 'text')?.text ?? ''
    const t2 = b2.content.find((b) => b.type === 'text')?.text ?? ''
    expect(t1).toBe(t2)
    expect(t1.length).toBeGreaterThan(0)
    await built.app.close()
  })
})

describe('AN9: output_config json_schema', () => {
  it('accepts output_config.format json_schema (same path as OA5)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    const res = await postTurn(built, [{ role: 'user', content: 'hi' }], {
      output_config: { format: { type: 'json_schema', schema } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { content: Array<{ type: string; text?: string }> }
    const text = body.content.find((b) => b.type === 'text')?.text ?? ''
    expect(text).not.toBe('') // the final hop must carry a text block
    await built.app.close()
  })
})

describe('AN10: stop_sequences', () => {
  it('cuts at the hit and echoes stop_sequence', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    // fake-agy ok mode answers "Hello from fake agy" — cut on "from".
    const res = await postTurn(built, [{ role: 'user', content: 'hi' }], { stop_sequences: ['from'] })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      stop_sequence: string | null
    }
    expect(body.stop_reason).toBe('stop_sequence')
    expect(body.stop_sequence).toBe('from')
    const text = body.content.find((b) => b.type === 'text')?.text ?? ''
    expect(text).not.toContain('from')
    await built.app.close()
  })
})

describe('AN2/AN3/AN5: streaming', () => {
  it('AN2: full event sequence; text_delta concatenation matches non-streaming', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    // Hop 1 raw SSE: the full event sequence from a fresh span.
    const hop1 = await post(built, { ...BASE, stream: true })
    expect(hop1.statusCode).toBe(200)
    const events = parseSseEvents(hop1.body)
    const names = events.map((e) => e.event)
    expect(names[0]).toBe('message_start')
    expect(names[names.length - 2]).toBe('message_delta')
    expect(names[names.length - 1]).toBe('message_stop')
    // output_tokens is monotonically non-decreasing across message_delta.
    const deltas = events.filter((e) => e.event === 'message_delta')
    let prev = -1
    for (const d of deltas) {
      const usage = (d.json?.usage ?? {}) as { output_tokens?: number }
      expect(usage.output_tokens ?? 0).toBeGreaterThanOrEqual(prev)
      prev = usage.output_tokens ?? 0
    }
    // Multi-hop streamed turn: the helper re-posts continuations as plain
    // requests, so the FINAL hop arrives as a message body — it must carry a
    // text block matching the hop-1-style streamed text from a fresh span.
    const streamed = await postTurn(built, [{ role: 'user', content: 'hi' }], { stream: true })
    expect(streamed.statusCode).toBe(200)
    const streamedBody = streamed.json() as { content: Array<{ type: string; text?: string }> }
    const streamedText = streamedBody.content.find((b) => b.type === 'text')?.text ?? ''
    expect(streamedText.length).toBeGreaterThan(0)
    // Non-streaming twin for comparison.
    const plain = await postTurn(built, [{ role: 'user', content: 'hi' }])
    const plainText = ((plain.json() as { content: Array<{ type: string; text?: string }> }).content.find((b) => b.type === 'text')?.text ?? '')
    expect(streamedText).toBe(plainText)
    await built.app.close()
  })

  it('AN3: thinking blocks stream as thinking_delta (no signature_delta)', async () => {
    process.env.FAKE_AGY_MODE = 'real'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true, thinking: { type: 'enabled', budget_tokens: 4096 } })
    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    const start = events.find((e) => e.event === 'content_block_start')
    expect(((start?.json?.content_block ?? {}) as { type?: string }).type).toBe('thinking')
    const thinkDelta = events.find(
      (e) => e.event === 'content_block_delta' && (e.json?.delta as { type?: string })?.type === 'thinking_delta',
    )
    expect(thinkDelta).toBeTruthy()
    expect(streamed_body_has_signature(events)).toBe(false)
    await built.app.close()
  })

  it('AN5: tool_use blocks stream with input_json_delta; stop_reason tool_use', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    const tuStart = events.find(
      (e) => e.event === 'content_block_start' && ((e.json?.content_block ?? {}) as { type?: string }).type === 'tool_use',
    )
    expect(tuStart).toBeTruthy()
    const block = (tuStart?.json?.content_block ?? {}) as { id?: string; name?: string }
    expect(block.id).toMatch(/^agytc-/)
    expect(block.name).toBe('agy_tool')
    const ij = events.find(
      (e) => e.event === 'content_block_delta' && (e.json?.delta as { type?: string })?.type === 'input_json_delta',
    )
    expect(typeof ((ij?.json?.delta ?? {}) as { partial_json?: string }).partial_json).toBe('string')
    const md = events.find((e) => e.event === 'message_delta')
    expect(((md?.json?.delta ?? {}) as { stop_reason?: string }).stop_reason).toBe('tool_use')
    await built.app.close()
  })

  it('stream errors surface as an error event (no message_stop)', async () => {
    process.env.FAKE_AGY_MODE = 'exit-error'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    const err = events.find((e) => e.event === 'error')
    expect(err).toBeTruthy()
    expect(((err?.json?.error ?? {}) as { type?: string }).type).toBe('api_error')
    expect(((err?.json?.error ?? {}) as { message?: string }).message).toContain('upstream request failed while generating')
    expect(events.some((e) => e.event === 'message_stop')).toBe(false)
    await built.app.close()
  })
})

/** AN3 note: signature_delta must never appear (agy has no thinking signatures). */
function streamed_body_has_signature(events: Array<{ event: string; data: string }>): boolean {
  return events.some((e) => e.data.includes('signature_delta'))
}

describe('AN7: count_tokens', () => {
  it('returns a deterministic input_tokens estimate with the heuristic header', async () => {
    const { built } = makeServer()
    const body = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: '一二三四五' }] }
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: body,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-agy-proxy-token-estimate']).toBe('heuristic')
    expect(res.json()).toEqual({ input_tokens: 5 })
    // Deterministic: same input → same count.
    const res2 = await built.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: body,
      headers: { 'content-type': 'application/json' },
    })
    expect(res2.json()).toEqual({ input_tokens: 5 })
    await built.app.close()
  })
})

describe('AN8: error matrix legs', () => {
  it('AN8a: missing key → 401 authentication_error (Anthropic body)', async () => {
    const { built } = makeServer({ apiKey: 'sekrit' })
    const res = await post(built, BASE)
    expect(res.statusCode).toBe(401)
    const an = res.json() as { type?: string; request_id?: string; error?: { type?: string } }
    // Anthropic error shape: {type:'error', error:{type,message}} + the
    // gateway's top-level request_id echo.
    expect(an.type).toBe('error')
    expect(an.error?.type).toBe('authentication_error')
    expect(typeof an.error === 'object' && an.error !== null && 'message' in an.error).toBe(true)
    expect(an.request_id).toMatch(/^[0-9a-f-]{36}$/)
    await built.app.close()
  })

  it('AN8a: x-api-key header authenticates like Bearer', async () => {
    const { built } = makeServer({ apiKey: 'sekrit' })
    const res = await post(built, BASE, { 'x-api-key': 'sekrit' })
    expect(res.statusCode).toBe(200)
    const bad = await post(built, BASE, { 'x-api-key': 'wrong' })
    expect(bad.statusCode).toBe(401)
    await built.app.close()
  })

  it('AN8b: overloaded upstream → 529 overloaded_error with real text', async () => {
    process.env.FAKE_AGY_MODE = 'real-fail'
    const { built } = makeServer()
    // real-fail still streams usable text and a tool step first — drive the
    // full turn so the run reaches the ERROR result envelope.
    const res = await postTurn(built, [{ role: 'user', content: 'hi' }])
    expect(res.statusCode).toBe(529)
    const an = res.json() as { type?: string; error?: { type?: string; message?: string } }
    expect(an.type).toBe('error')
    expect(an.error?.type).toBe('overloaded_error')
    expect(an.error?.message).toContain('model overloaded')
    await built.app.close()
  })

  it('AN8c: missing max_tokens → 400 invalid_request_error (Anthropic body)', async () => {
    const { built } = makeServer()
    const res = await post(built, { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.statusCode).toBe(400)
    const an = res.json() as { type?: string; request_id?: string; error?: { type?: string } }
    expect(an.type).toBe('error')
    expect(an.error?.type).toBe('invalid_request_error')
    expect(an.error && 'message' in an.error).toBe(true)
    expect(an.request_id).toMatch(/^[0-9a-f-]{36}$/)
    await built.app.close()
  })

  it('AN8c: upstream exit-1 → 502 api_error carrying agy real error text', async () => {
    process.env.FAKE_AGY_MODE = 'exit-error'
    const { built } = makeServer()
    const res = await post(built, BASE)
    expect(res.statusCode).toBe(502)
    const an = res.json() as { type?: string; error?: { type?: string; message?: string } }
    expect(an.type).toBe('error')
    expect(an.error?.type).toBe('api_error')
    expect(an.error?.message).toContain('upstream request failed while generating')
    await built.app.close()
  })
})

describe('AN4: thinking replay accepted into context', () => {
  it('historical thinking/redacted_thinking blocks are accepted (tamper leg N/A)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, {
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'prior thought', signature: 'no-sig' }] },
        { role: 'user', content: 'continue' },
      ],
    })
    expect(res.statusCode).toBe(200)
    await built.app.close()
  })
})

describe('SSE heartbeat, Anthropic leg (charter §6)', () => {
  it('silent stretch longer than the interval emits ping events', async () => {
    process.env.FAKE_AGY_MODE = 'slow'
    process.env.FAKE_AGY_SILENCE_MS = '500'
    const { built } = makeServer({ sseHeartbeatMs: 150 })
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('event: ping')
    // The stream still completes normally.
    expect(res.body.trim().endsWith('data: {"type":"message_stop"}')).toBe(true)
    await built.app.close()
  })
})
