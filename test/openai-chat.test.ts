// POST /v1/chat/completions non-streaming: pure mapper units + end-to-end
// route tests through the REAL AgyEngine wired to the fake agy binary
// (binArgs seam, same harness as engine.test.ts). Covers the OA1 acceptance
// surface plus its immediate error legs (502 with real upstream text).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    ...deps,
  })
  const built = buildServer({ getConfig: () => cfg, engine, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  return { built, argsFile }
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

  it('maps a basic text request', () => {
    const { call, meta } = mapChatRequest(BASE, cfg)
    expect(call.model).toBe('gemini-3.7-flash')
    expect(call.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(meta.warnings).toEqual([])
  })

  it('joins system and developer messages in arrival order', () => {
    const { call } = mapChatRequest({
      ...BASE,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'developer', content: 'no slang' },
        { role: 'user', content: 'hi' },
      ],
    }, cfg)
    expect(call.system).toBe('be brief\n\nno slang')
    expect(call.messages).toEqual([{ role: 'user', text: 'hi' }])
  })

  it('joins text parts; rejects image and audio parts', () => {
    const { call } = mapChatRequest({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    }, cfg)
    expect(call.messages[0]?.text).toBe('ab')
    expect(() => mapChatRequest({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }],
    }, cfg)).toThrow(/M2/)
    expect(() => mapChatRequest({
      ...BASE,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }],
    }, cfg)).toThrow(/audio/)
  })

  it('assistant turns become foreign digest turns; assistant tool_calls rejected', () => {
    const { call } = mapChatRequest({
      ...BASE,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'next' },
      ],
    }, cfg)
    expect(call.messages[1]).toEqual({ role: 'assistant', text: 'a' })
    expect(() => mapChatRequest({
      ...BASE,
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
    }, cfg)).toThrow(/M2/)
  })

  it('accepts tool results only with our agytc- cursor', () => {
    const { call } = mapChatRequest({
      ...BASE,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'tool', content: 'out', tool_call_id: 'agytc-run1-3' },
      ],
    }, cfg)
    expect(call.messages[1]).toEqual({ role: 'tool', text: 'out', toolCallId: 'agytc-run1-3' })
    expect(() => mapChatRequest({
      ...BASE,
      messages: [{ role: 'tool', content: 'out', tool_call_id: 'call_abc123' }],
    }, cfg)).toThrow(/agytc-/)
    expect(() => mapChatRequest({
      ...BASE,
      messages: [{ role: 'tool', content: 'out' }],
    }, cfg)).toThrow(/agytc-/)
  })

  it('rejects tools, legacy functions, n>1, and stream:true with explicit 400s', () => {
    expect(() => mapChatRequest({ ...BASE, tools: [{ type: 'function', function: { name: 'f', parameters: {} } }] }, cfg)).toThrow(/M2/)
    expect(() => mapChatRequest({ ...BASE, tool_choice: 'auto' }, cfg)).toThrow(/M2/)
    expect(() => mapChatRequest({ ...BASE, functions: [] }, cfg)).toThrow(/legacy functions/)
    expect(() => mapChatRequest({ ...BASE, n: 2 }, cfg)).toThrow(/n > 1/)
    expect(() => mapChatRequest({ ...BASE, stream: true }, cfg)).toThrow(/M2/)
  })

  it('validates stop and max-token fields; warns on deprecations', () => {
    const { call: _c, meta } = mapChatRequest({
      ...BASE,
      max_tokens: 100,
      temperature: 0.7,
    }, cfg)
    expect(meta.maxTokens).toBe(100)
    expect(meta.warnings.some((w) => w.includes('max_tokens is deprecated'))).toBe(true)
    expect(meta.warnings.some((w) => w.includes('temperature'))).toBe(true)

    expect(() => mapChatRequest({ ...BASE, max_tokens: 0 }, cfg)).toThrow(/positive integer/)
    expect(() => mapChatRequest({ ...BASE, max_completion_tokens: -1 }, cfg)).toThrow(/positive integer/)
    expect(() => mapChatRequest({ ...BASE, stop: 'END' }, cfg)).not.toThrow()
    expect(() => mapChatRequest({ ...BASE, stop: ['a', 'b', 'c', 'd', 'e'] }, cfg)).toThrow(/at most 4/)
    expect(() => mapChatRequest({ ...BASE, stop: [''] }, cfg)).toThrow(/non-empty/)
  })

  it('json_object injects a system instruction; json_schema passes through natively', () => {
    const rf = mapChatRequest({ ...BASE, response_format: { type: 'json_object' } }, cfg)
    expect(rf.call.system).toContain('valid JSON')
    const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
    const rs = mapChatRequest({ ...BASE, response_format: { type: 'json_schema', json_schema: { name: 'r', schema } } }, cfg)
    expect(rs.call.jsonSchema).toEqual(schema)
    expect(() => mapChatRequest({ ...BASE, response_format: { type: 'yaml' } }, cfg)).toThrow(/response_format/)
    expect(() => mapChatRequest({ ...BASE, response_format: { type: 'json_schema', json_schema: {} } }, cfg)).toThrow(/schema/)
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
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'ultra' },
    ]) {
      const res = await post(built, payload)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.type).toBe('invalid_request_error')
    }
    await built.app.close()
  })
})
