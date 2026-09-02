// POST /v1/chat/completions non-streaming: pure mapper units + end-to-end
// route tests through the REAL AgyEngine wired to the fake agy binary
// (binArgs seam, same harness as engine.test.ts). Covers the OA1 acceptance
// surface plus its immediate error legs (502 with real upstream text).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { CallId } from '../src/host/stream-types.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import { GatewayHttpError } from '../src/server/errors.ts'
import type { Catalog } from '../src/host/models.ts'
import {
  assembleCompletion,
  collectChunks,
  mapChatRequest,
  mapEffort,
  mapUsage,
  newCompletionId,
} from '../src/server/openai-adapter.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-chat-'))
process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const argsFile = join(workDir, 'args-' + Math.random().toString(36).slice(2) + '.json')
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
  return { built, argsFile, catalog }
}

function post(built: ReturnType<typeof makeServer>['built'], payload: unknown, headers: Record<string, string> = {}) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: payload as object,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const BASE = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] }

/**
 * Drive one full gateway turn the way an OpenAI client would: when the
 * response carries tool_calls (our agy_tool mirror), append the tool result
 * message and re-post — until a non-tool_calls finish (or an error status).
 * fake-agy's ok/real modes all contain completed agy tool steps, so single-
 * shot posts would stop at the first mirror cut.
 */
async function postTurn(
  built: ReturnType<typeof makeServer>['built'],
  messages: unknown[],
  model = 'gemini-3.7-flash',
  extra: Record<string, unknown> = {},
  maxHops = 6,
) {
  let msgs = [...messages]
  let res = await post(built, { model, messages: msgs, ...extra })
  for (let hop = 1; hop < maxHops; hop++) {
    if (res.statusCode !== 200) return res
    const body = res.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ id: string }> } }> }
    const tc = body.choices?.[0]?.message?.tool_calls
    if (tc === undefined || tc.length === 0) return res
    msgs = [...msgs, { role: 'tool', content: 'replayed', tool_call_id: tc[0]!.id }]
    res = await post(built, { model, messages: msgs, ...extra })
  }
  return res
}

afterEach(() => {
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_AGY_ARGS_FILE
  delete process.env.FAKE_AGY_DELAY_MS
})

describe('mapEffort', () => {
  it('maps the charter effort table', () => {
    expect(mapEffort(undefined)).toBeUndefined()
    expect(mapEffort('none')).toBeUndefined()
    expect(mapEffort('minimal')).toBe('low')
    expect(mapEffort('low')).toBe('low')
    expect(mapEffort('medium')).toBe('medium')
    expect(mapEffort('high')).toBe('high')
    expect(mapEffort('xhigh')).toBe('high')
    expect(mapEffort('max')).toBe('high')
    expect(() => mapEffort('ultra')).toThrow(/none, minimal, low/)
  })
})

describe('mapChatRequest', () => {
  const cfg = defaultConfig()
  const map = (body: unknown, c = cfg) => mapChatRequest(body, c)
  const mapThrows = (body: unknown, re: RegExp, c = cfg) =>
    expect(mapChatRequest(body, c)).rejects.toThrow(re)

  it('maps a basic text request', async () => {
    const { call, meta } = await map(BASE)
    expect(call.model).toBe('gemini-3.7-flash')
    expect(call.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(meta.warnings).toEqual([])
  })

  it('rejects a whitespace-only model instead of falling back silently', async () => {
    mapThrows({ ...BASE, model: ' ' }, /non-empty/)
    mapThrows({ ...BASE, model: '  ' }, /non-empty/)
    // Non-string models keep their own error.
    mapThrows({ ...BASE, model: 7 }, /model must be a string/)
    // An unset model still falls back to the configured default.
    await expect(map({ ...BASE, model: undefined }, { ...cfg, defaultModel: 'fallback-m' })).resolves.toBeTruthy()
  })

  it('joins system and developer messages in arrival order', async () => {
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'developer', content: 'no slang' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(call.system).toBe('be brief\n\nno slang')
    expect(call.messages).toEqual([{ role: 'user', text: 'hi' }])
  })

  it('joins text parts; stages data: images; rejects audio and http URLs', async () => {
    const { call } = await map({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    })
    expect(call.messages[0]?.text).toBe('ab')
    // 1x1 PNG (data: URL) stages as an image ref with real bytes.
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const withImg = await map({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngB64 } }] }],
    })
    expect(withImg.call.messages[0]?.images).toHaveLength(1)
    expect(withImg.call.messages[0]?.images?.[0]?.mediaType).toBe('image/png')
    expect(withImg.call.messages[0]?.images?.[0]?.bytes).toBeGreaterThan(0)
    expect(withImg.meta.imageBytes.size).toBe(1)
    mapThrows({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/tiff;base64,AA' } }] }],
    }, /unsupported image media type/)
    mapThrows({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }],
    }, /data: URL/)
    mapThrows({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }],
    }, /audio/)
  })

  it('assistant turns become foreign digest turns; assistant tool_calls kept as context', async () => {
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'next' },
      ],
    })
    expect(call.messages[1]).toEqual({ role: 'assistant', text: 'a' })
    // M2: an assistant turn carrying tool_calls is accepted as history
    // context (the tool_calls array itself is not forwarded — only text).
    const withTc = await map({
      ...BASE,
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'user', content: 'go on' },
      ],
    })
    expect(withTc.call.messages[0]).toEqual({ role: 'assistant', text: '' })
  })

  it('accepts tool results only with our agytc- cursor', async () => {
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'tool', content: 'out', tool_call_id: 'agytc-run1-3' },
      ],
    })
    expect(call.messages[1]).toEqual({ role: 'tool', text: 'out', toolCallId: 'agytc-run1-3' })
    mapThrows({
      ...BASE,
      messages: [{ role: 'tool', content: 'out', tool_call_id: 'call_abc123' }],
    }, /agytc-/)
    mapThrows({
      ...BASE,
      messages: [{ role: 'tool', content: 'out' }],
    }, /agytc-/)
  })

  it('accepts tools/tool_choice with a warning; rejects legacy functions; stream parses', async () => {
    const withTools = await map({ ...BASE, tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] })
    expect(withTools.meta.warnings.some((w) => w.includes('not executed'))).toBe(true)
    const withChoice = await map({ ...BASE, tool_choice: 'auto' })
    expect(withChoice.meta.warnings.some((w) => w.includes('tool_choice'))).toBe(true)
    mapThrows({ ...BASE, functions: [] }, /legacy functions/)
    mapThrows({ ...BASE, function_call: 'auto' }, /legacy functions/)
    mapThrows({ ...BASE, n: 2 }, /n > 1/)
    const streamed = await map({ ...BASE, stream: true })
    expect(streamed.meta.stream).toBe(true)
  })

  it('warns for every silently-dropped sampling/verbosity param', async () => {
    const { meta } = await map({
      ...BASE,
      logit_bias: { x: 1 },
      verbosity: 'low',
      modalities: ['text'],
      prediction: { content: 'x' },
      top_k: 5,
    })
    for (const k of ['logit_bias', 'verbosity', 'modalities', 'prediction', 'top_k']) {
      expect(meta.warnings.some((w) => w.startsWith(k + ' is accepted but not forwarded'))).toBe(true)
    }
  })

  it('validates stop and max-token fields; warns on deprecations', async () => {
    const { call: _c, meta } = await map({
      ...BASE,
      max_tokens: 100,
      temperature: 0.7,
    })
    expect(meta.maxTokens).toBe(100)
    expect(meta.warnings.some((w) => w.includes('max_tokens is deprecated'))).toBe(true)
    expect(meta.warnings.some((w) => w.includes('temperature'))).toBe(true)

    mapThrows({ ...BASE, max_tokens: 0 }, /positive integer/)
    mapThrows({ ...BASE, max_completion_tokens: -1 }, /positive integer/)
    await expect(map({ ...BASE, stop: 'END' })).resolves.toBeTruthy()
    mapThrows({ ...BASE, stop: ['a', 'b', 'c', 'd', 'e'] }, /at most 4/)
    mapThrows({ ...BASE, stop: [''] }, /non-empty/)
  })

  it('json_object injects a system instruction; json_schema passes through natively', async () => {
    const rf = await map({ ...BASE, response_format: { type: 'json_object' } })
    expect(rf.call.system).toContain('valid JSON')
    // The warning must not overclaim: there is no gateway-side parse check.
    expect(rf.meta.warnings.some((w) => w.includes('prompt instruction') && !w.includes('parse check'))).toBe(true)
    const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
    const rs = await map({ ...BASE, response_format: { type: 'json_schema', json_schema: { name: 'r', schema } } })
    expect(rs.call.jsonSchema).toEqual(schema)
    mapThrows({ ...BASE, response_format: { type: 'yaml' } }, /response_format/)
    mapThrows({ ...BASE, response_format: { type: 'json_schema', json_schema: {} } }, /schema/)
  })

  it('accepts response_format {type:"text"} as a no-op; only unknown types 400', async () => {
    const rf = await map({ ...BASE, response_format: { type: 'text' } })
    expect(rf.call.system).toBeUndefined()
    expect(rf.call.jsonSchema).toBeUndefined()
    expect(rf.meta.warnings).toEqual([])
  })

  it('OA8: unknown model 404s against a discovered catalog; fallback stays advisory', async () => {
    const discovered: Catalog = {
      source: 'discovered',
      models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] }],
      discoveredAt: Date.now(),
    }
    await expect(mapChatRequest({ ...BASE, model: 'no-such-model' }, cfg, discovered)).rejects.toMatchObject({ statusCode: 404 })
    // Known ids (and alias-resolvable ones) pass the pre-check.
    await expect(mapChatRequest(BASE, cfg, discovered)).resolves.toBeTruthy()
    await expect(mapChatRequest(BASE, cfg)).resolves.toBeTruthy() // fallback catalog: advisory, no pre-check
  })

  it('stream_options.include_usage parses; invalid shape 400s', async () => {
    const ok = await map({ ...BASE, stream: true, stream_options: { include_usage: true } })
    expect(ok.meta.includeUsage).toBe(true)
    const off = await map({ ...BASE, stream_options: {} })
    expect(off.meta.includeUsage).toBe(false)
    mapThrows({ ...BASE, stream_options: { include_usage: 'yes' } }, /stream_options/)
  })
})

describe('collectChunks + assembleCompletion + mapUsage', () => {
  it('counts text deltas only (block-end would double-count) and keeps last usage', () => {
    const collected = collectChunks([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, cacheReadTokens: 7 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(collected.text).toBe('Hello')
    const body = assembleCompletion({ id: 'chatcmpl-x', created: 0, requestModel: 'm', collected, stop: [] })
    expect(body.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 2 },
    })
  })

  it('assembles tool_calls from block-ends with null content', () => {
    const collected = collectChunks([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('call_1'), name: 'agy_tool', arguments: '{"run":"r","step":0}' },
      },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const body = assembleCompletion({ id: 'chatcmpl-x', created: 0, requestModel: 'm', collected, stop: [] })
    expect(body.choices[0]?.finish_reason).toBe('tool_calls')
    expect(body.choices[0]?.message.content).toBeNull()
    expect(body.choices[0]?.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'agy_tool', arguments: '{"run":"r","step":0}' } },
    ])
  })

  it('truncates at the earliest stop sequence and keeps finish stop', () => {
    const collected = collectChunks([
      { type: 'text-delta', index: 0, text: 'one two three' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const body = assembleCompletion({ id: 'i', created: 0, requestModel: 'm', collected, stop: ['three', 'two'] })
    expect(body.choices[0]?.message.content).toBe('one ')
    expect(body.choices[0]?.finish_reason).toBe('stop')
  })

  it('mapUsage zero-fills detail objects', () => {
    expect(mapUsage({ inputTokens: 5, outputTokens: 6 })).toEqual({
      prompt_tokens: 5,
      completion_tokens: 6,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it('newCompletionId has the chatcmpl- base64url shape', () => {
    expect(newCompletionId()).toMatch(/^chatcmpl-[A-Za-z0-9_-]{24}$/)
  })
})

describe('POST /v1/chat/completions end-to-end (fake agy)', () => {
  it('ok mode: full OA1 body (id, object, created, model echo, choices, finish stop, usage)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await postTurn(built, BASE.messages)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toMatch(/^chatcmpl-[A-Za-z0-9_-]{24}$/)
    expect(body.object).toBe('chat.completion')
    expect(typeof body.created).toBe('number')
    expect(body.model).toBe('gemini-3.7-flash')
    expect(body.choices).toHaveLength(1)
    expect(body.choices[0].index).toBe(0)
    expect(body.choices[0].message.role).toBe('assistant')
    expect(body.choices[0].message.content).toContain('Hello from fake agy')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.prompt_tokens).toBeGreaterThan(0)
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens)
    await built.app.close()
  })

  it('real mode: delta join, reasoning kept out of content, usage details present', async () => {
    process.env.FAKE_AGY_MODE = 'real'
    const { built } = makeServer()
    const res = await postTurn(built, BASE.messages)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.choices[0].message.content).toBe('There are 2 files, 6 words total.')
    expect(body.choices[0].message.content).not.toContain('Thinking')
    expect(body.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0)
    expect(body.usage.prompt_tokens_details.cached_tokens).toBeGreaterThan(0)
    await built.app.close()
  })

  it('exit-error mode: 502 with the REAL upstream text and PROCESS_EXIT code', async () => {
    process.env.FAKE_AGY_MODE = 'exit-error'
    const { built } = makeServer()
    const res = await post(built, BASE)
    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.error.type).toBe('api_error')
    expect(body.error.code).toBe('PROCESS_EXIT')
    expect(body.error.message).toContain('upstream request failed while generating (request id 8f3ac2)')
    await built.app.close()
  })

  it('auth mode: 401 with the sign-in message; real-fail: 502 model overloaded', async () => {
    process.env.FAKE_AGY_MODE = 'auth'
    const { built } = makeServer()
    const res = await postTurn(built, BASE.messages)
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('AUTH')
    await built.app.close()

    process.env.FAKE_AGY_MODE = 'real-fail'
    const built2 = makeServer().built
    const res2 = await postTurn(built2, BASE.messages)
    expect(res2.statusCode).toBe(502)
    expect(res2.json().error.message).toContain('model overloaded')
    await built2.app.close()
  })

  it('missing binary → 503 AGY_NOT_INSTALLED', async () => {
    const { built } = makeServer({}, { bin: () => null })
    const res = await post(built, BASE)
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('AGY_NOT_INSTALLED')
    await built.app.close()
  })

  it('BUSY: queue full → 429 rate_limit_error', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    process.env.FAKE_AGY_DELAY_MS = '1500'
    const { built } = makeServer({ maxConcurrent: 1, maxQueueDepth: 0 })
    const first = post(built, BASE) // occupies the only slot
    await new Promise((r) => setTimeout(r, 300))
    const second = await post(built, BASE)
    expect(second.statusCode).toBe(429)
    expect(second.json().error.code).toBe('BUSY')
    expect(second.json().error.type).toBe('rate_limit_error')
    await first
    await built.app.close()
  })

  it('unknown model ids pass through (advisory catalog) and reach argv', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built, argsFile } = makeServer()
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const res = await postTurn(built, [{ role: 'user', content: 'hi' }], 'totally-unknown-model')
    expect(res.statusCode).toBe(200)
    await built.app.close()
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1) ?? '[]') as string[]
    expect(last).toContain('--model')
    expect(last).toContain('totally-unknown-model')
  })

  it('json_schema reaches the --json-schema argv tail', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built, argsFile } = makeServer()
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
    const res = await postTurn(built, BASE.messages, 'gemini-3.7-flash', {
      response_format: { type: 'json_schema', json_schema: { name: 'r', schema } },
    })
    expect(res.statusCode).toBe(200)
    await built.app.close()
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1) ?? '[]') as string[]
    const idx = last.indexOf('--json-schema')
    expect(idx).toBeGreaterThan(0)
    const file = last[idx + 1] ?? ''
    expect(JSON.parse(readFileSync(file, 'utf8') as string)).toEqual(schema)
  })

  it('request-mapping 400s surface as invalid_request_error', async () => {
    const { built } = makeServer()
    for (const payload of [
      { model: 'm', messages: [] },
      { messages: [{ role: 'user', content: 'hi' }] },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], n: 3 },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], functions: [] },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'ultra' },
    ]) {
      const res = await post(built, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.type).toBe('invalid_request_error')
    }
    // Official error-object anatomy carries param (always null from us).
    const res = await post(built, { model: 'm', messages: [{ role: 'user', content: 'hi' }], functions: [] })
    expect(res.json().error.param).toBeNull()
    await built.app.close()
  })

  it('data: images stage to disk and reach --add-dir + view_file prompt (OA7 leg)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    // 1x1 transparent PNG.
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { built, argsFile } = makeServer()
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const res = await postTurn(built, [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + pngB64 } },
      ],
    }])
    expect(res.statusCode).toBe(200)
    await built.app.close()
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1) ?? '[]') as string[]
    const prompt = last[last.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('what is this?')
    expect(prompt).toContain('[image attached: "img-1"')
    expect(prompt).toContain('view_file')
    expect(last).toContain('--add-dir')
    // The staged file itself exists in the media dir (dir rides --add-dir).
    const dir = last[last.indexOf('--add-dir') + 1] ?? ''
    expect(dir).not.toBe('')
    expect(readdirSync(dir).some((f) => f.startsWith('img-1-') || f.includes('-0.png'))).toBe(true)
  })

  it('Anthropic base64 images stage through /v1/messages the same way', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const { built, argsFile } = makeServer()
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: {
        model: 'gemini-3.7-flash',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngB64 } },
          ],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    await built.app.close()
    const lines = readFileSync(argsFile, 'utf8').trim().split('\n')
    const last = JSON.parse(lines.at(-1) ?? '[]') as string[]
    const prompt = last[last.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('[image attached: "img-1"')
    expect(last).toContain('--add-dir')
  })

  it('stream:true now returns an SSE response (M2)', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true, stream_options: { include_usage: true } })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const text = res.body
    expect(text).toContain('"chat.completion.chunk"')
    // fake-agy ok mode contains a completed tool step: the span cuts on it
    // (mirror round trip) — expect the tool_calls finish + usage + [DONE].
    expect(text).toContain('finish_reason":"tool_calls"')
    expect(text).toContain('"choices":[]') // usage frame
    expect(text).toContain('"id":"agytc-') // stable mirror call id
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    await built.app.close()
  })
})
