// Pure unit tests for the Anthropic Messages adapter (src/server/
// anthropic-adapter.ts): request mapping tables, budget tiers, content
// blocks, stop/max-token transforms, usage mapping, error helpers, and the
// streaming event generator — all without Fastify or the engine.
import { describe, it, expect } from 'vitest'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import {
  anthropicStreamEvents,
  assembleMessage,
  BUDGET_TIERS,
  collectChunks,
  estimateInputTokens,
  mapAnthropicUsage,
  mapBudget,
  mapMessagesRequest,
  mapThinking,
  newMessageId,
} from '../src/server/anthropic-adapter.ts'
import { anthropicError, engineFailureToAnthropic, isAnthropicPath, openAiError, stampRequestId } from '../src/server/errors.ts'
import { estimateTokens } from '../src/server/tokens.ts'
import { CallId, type StreamChunk } from '../src/host/stream-types.ts'
import type { Catalog } from '../src/host/models.ts'

const cfg = defaultConfig()
const map = (body: unknown, c: GatewayConfig = cfg) => mapMessagesRequest(body, c)
const mapThrows = (body: unknown, re: RegExp, c: GatewayConfig = cfg) =>
  expect(mapMessagesRequest(body, c)).rejects.toThrow(re)

describe('newMessageId', () => {
  it('mints msg_ ids with 24 base64url chars', () => {
    const id = newMessageId()
    expect(id).toMatch(/^msg_[A-Za-z0-9_-]{24}$/)
    expect(newMessageId()).not.toBe(id)
  })
})

describe('mapBudget / BUDGET_TIERS', () => {
  it('uses the documented tier boundaries', () => {
    expect(BUDGET_TIERS.map((t) => t.effort)).toEqual(['low', 'medium', 'high'])
    expect(mapBudget(1024)).toBe('low')
    expect(mapBudget(4096)).toBe('low')
    expect(mapBudget(4097)).toBe('medium')
    expect(mapBudget(16384)).toBe('medium')
    expect(mapBudget(16385)).toBe('high')
    expect(mapBudget(1_000_000)).toBe('high')
  })
  it('rejects budgets below 1024 or non-integers', () => {
    expect(() => mapBudget(1023)).toThrow(/>= 1024/)
    expect(() => mapBudget(500.5)).toThrow(/>= 1024/)
    expect(() => mapBudget('big')).toThrow(/>= 1024/)
  })
})

describe('mapThinking', () => {
  it('maps enabled/adaptive/disabled and rejects unknown types', () => {
    expect(mapThinking(undefined)).toBeUndefined()
    expect(mapThinking(null)).toBeUndefined()
    expect(mapThinking({ type: 'disabled' })).toBeUndefined()
    expect(mapThinking({ type: 'adaptive' })).toBeUndefined()
    expect(mapThinking({ type: 'enabled', budget_tokens: 4096 })).toBe('low')
    expect(mapThinking({ type: 'enabled', budget_tokens: 8192 })).toBe('medium')
    expect(() => mapThinking({ type: 'turbo' })).toThrow(/enabled, adaptive, or disabled/)
    expect(() => mapThinking({ type: 'enabled' })).toThrow(/budget_tokens/)
  })
})

describe('mapMessagesRequest', () => {
  const BASE = { model: 'gemini-3.7-flash', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }

  it('maps a basic request with max_tokens required', async () => {
    const { call, meta } = await map(BASE)
    expect(call.model).toBe('gemini-3.7-flash')
    expect(call.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(meta.maxTokens).toBe(1024)
    expect(meta.stream).toBeUndefined()
  })

  it('requires max_tokens (Anthropic contract)', async () => {
    await mapThrows({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, /max_tokens is required/)
    await mapThrows({ ...BASE, max_tokens: 0 }, /positive integer/)
    await mapThrows({ ...BASE, max_tokens: 'many' }, /positive integer/)
  })

  it('rejects a whitespace-only model instead of falling back silently', async () => {
    await mapThrows({ ...BASE, model: ' ' }, /non-empty/)
    // Non-string models keep their own error; unset falls back to default.
    await mapThrows({ ...BASE, model: 7 }, /model must be a string/)
    await expect(map({ ...BASE, model: undefined }, { ...cfg, defaultModel: 'fallback-m' })).resolves.toBeTruthy()
  })

  it('OA8 mirror: unknown model 404s on a discovered catalog; aliases pass (M2)', async () => {
    const discovered: Catalog = {
      source: 'discovered',
      models: [
        { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
        { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', efforts: ['high'] },
      ],
      discoveredAt: Date.now(),
    }
    await expect(mapMessagesRequest({ ...BASE, model: 'no-such-model' }, cfg, discovered)).rejects.toMatchObject({
      statusCode: 404,
    })
    // The pre-fix check compared raw ids only (with a duplicated condition),
    // so the claude-opus alias was rejected even though resolveModelSlug maps
    // it to the known claude-opus-4-6-thinking entry.
    const aliased = await mapMessagesRequest({ ...BASE, model: 'claude-opus' }, cfg, discovered)
    expect(aliased.call.model).toBe('claude-opus')
    await expect(mapMessagesRequest(BASE, cfg, discovered)).resolves.toBeTruthy()
    await expect(mapMessagesRequest(BASE, cfg)).resolves.toBeTruthy() // fallback catalog: advisory, no pre-check
  })

  it('joins system string and text-block forms equivalently', async () => {
    const asString = await map({ ...BASE, system: 'Be terse.' })
    const asBlocks = await map({
      ...BASE,
      system: [{ type: 'text', text: 'Be terse.' }, { type: 'text', text: 'Be kind.' }],
    })
    expect(asString.call.system).toBe('Be terse.')
    expect(asBlocks.call.system).toBe('Be terse.\n\nBe kind.')
    await mapThrows({ ...BASE, system: [{ type: 'other', text: 'x' }] }, /system blocks must be \{type:"text", text\}/)
  })

  it('maps content block arrays incl. images and thinking replay', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
    const { call, meta } = await map({
      ...BASE,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            { type: 'thinking', thinking: 'prior thought' },
          ],
        },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'agy_tool', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'and then?' }] },
      ],
    })
    expect(call.messages[0]?.text).toContain('look')
    expect(call.messages[0]?.images).toHaveLength(1)
    expect(call.messages[0]?.images?.[0]?.mediaType).toBe('image/png')
    expect(call.messages[0]?.text).toContain('[thinking replay] prior thought')
    expect(call.messages[1]?.text).toContain('[tool_use replay] agy_tool')
    expect(meta.imageBytes.get('img-1')?.length).toBeGreaterThan(0)
  })

  it('rejects url image sources and bad media types', async () => {
    await mapThrows(
      { ...BASE, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] },
      /only base64 image sources/,
    )
    await mapThrows(
      { ...BASE, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'aGk=' } }] }] },
      /media_type must be/,
    )
  })

  it('surfaces tool_result continuations as the engine tool role', async () => {
    const callId = 'agytc-run-1-3'
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: 'output here' }] }],
        },
      ],
    })
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'tool',
      text: 'output here',
      toolCallId: callId,
    })
  })

  it('rejects tool_result blocks not addressed to our mirror ids', async () => {
    await mapThrows(
      {
        ...BASE,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_foreign', content: 'x' }] },
        ],
      },
      /only accepted as continuations/,
    )
  })

  it('merges multiple trailing tool_results and keeps the furthest cursor', async () => {
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'agytc-run-1-3', content: 'result A' },
            { type: 'tool_result', tool_use_id: 'agytc-run-1-5', content: 'result B' },
          ],
        },
      ],
    })
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'tool',
      text: 'result A\n\nresult B',
      toolCallId: 'agytc-run-1-5',
    })
  })

  it('folds sibling text blocks into the tool message with a marker prefix', async () => {
    const { call } = await map({
      ...BASE,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'agytc-run-1-3', content: 'out' },
            { type: 'text', text: 'note from the client' },
          ],
        },
      ],
    })
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'tool',
      text: 'out\n\n[user context] note from the client',
      toolCallId: 'agytc-run-1-3',
    })
  })

  it('still rejects when any trailing tool_result carries a foreign id', async () => {
    await mapThrows(
      {
        ...BASE,
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'agytc-run-1-3', content: 'out' },
              { type: 'tool_result', tool_use_id: 'tu_foreign', content: 'x' },
            ],
          },
        ],
      },
      /only accepted as continuations/,
    )
  })

  it('maps stop_sequences and rejects oversize lists', async () => {
    const { meta } = await map({ ...BASE, stop_sequences: ['END', 'STOP'] })
    expect(meta.stop).toEqual(['END', 'STOP'])
    await mapThrows({ ...BASE, stop_sequences: ['a', 'b', 'c', 'd', 'e'] }, /at most 4/)
    await mapThrows({ ...BASE, stop_sequences: [''] }, /non-empty strings/)
  })

  it('maps output_config json_schema and rejects other formats', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const { call } = await map({ ...BASE, output_config: { format: { type: 'json_schema', schema } } })
    expect(call.jsonSchema).toEqual(schema)
    await mapThrows({ ...BASE, output_config: { format: { type: 'yaml' } } }, /must be json_schema/)
  })

  it('warns on tools and sampling params (accepted, not forwarded)', async () => {
    const { meta } = await map({ ...BASE, tools: [{ name: 'client_tool' }], temperature: 0.5, top_k: 3 })
    expect(meta.warnings.some((w) => w.includes('tools were accepted but are not executed'))).toBe(true)
    expect(meta.warnings.some((w) => w.includes('temperature'))).toBe(true)
    expect(meta.warnings.some((w) => w.includes('top_k'))).toBe(true)
  })

  it('warns for every silently-ignored extra param (parity with the OpenAI leg)', async () => {
    const { meta } = await map({
      ...BASE,
      tool_choice: { type: 'auto' },
      betas: ['prompt-caching-2024-07-31'],
      mcp_servers: [{ name: 'm', url: 'https://mcp.example' }],
      service_tier: 'auto',
      output_format: { type: 'text' },
    })
    for (const k of ['tool_choice', 'betas', 'mcp_servers', 'service_tier', 'output_format']) {
      expect(meta.warnings.some((w) => w.startsWith(k + ' is accepted but not forwarded'))).toBe(true)
    }
  })

  it('marks streaming requests', async () => {
    const { meta } = await map({ ...BASE, stream: true })
    expect(meta.stream).toBe(true)
  })
})

describe('collectChunks + assembleMessage', () => {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'pondering' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'pondering' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Hello ' },
    { type: 'text-delta', index: 1, text: 'world' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello world' } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 34, reasoningTokens: 7, cacheReadTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  it('assembles thinking → text blocks with usage details', () => {
    const collected = collectChunks(chunks)
    const msg = assembleMessage({ id: 'msg_x', requestModel: 'gemini-3.7-flash', collected, stop: [] })
    expect(msg.content).toEqual([
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'Hello world' },
    ])
    expect(msg.stop_reason).toBe('end_turn')
    expect(msg.stop_sequence).toBeNull()
    expect(msg.usage).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5,
      output_tokens_details: { thinking_tokens: 7 },
    })
  })

  it('maps tool-calls finishes to stop_reason tool_use with parsed input', () => {
    const collected = collectChunks([
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('agytc-r-1'), name: 'agy_tool', arguments: '{"run":"r","step":1}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const msg = assembleMessage({ id: 'msg_x', requestModel: 'm', collected, stop: [] })
    expect(msg.stop_reason).toBe('tool_use')
    // An empty text block is not pushed alongside tool_use.
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'agytc-r-1', name: 'agy_tool', input: { run: 'r', step: 1 } },
    ])
  })

  it('cuts at stop_sequences and echoes stop_sequence (AN10)', () => {
    const collected = collectChunks([
      { type: 'text-delta', index: 0, text: 'first halfEND second half' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const msg = assembleMessage({ id: 'msg_x', requestModel: 'm', collected, stop: ['END'] })
    expect(msg.content[0]).toEqual({ type: 'text', text: 'first half' })
    expect(msg.stop_reason).toBe('stop_sequence')
    expect(msg.stop_sequence).toBe('END')
  })

  it('truncates proportionally at max_tokens (AN10)', () => {
    const collected = collectChunks([
      { type: 'text-delta', index: 0, text: '0123456789'.repeat(10) }, // 100 chars
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 100 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const msg = assembleMessage({ id: 'msg_x', requestModel: 'm', collected, stop: [], maxTokens: 50 })
    const text = msg.content[0] as { type: string; text: string }
    expect(text.text).toHaveLength(50)
    expect(msg.stop_reason).toBe('max_tokens')
  })
})

describe('mapAnthropicUsage', () => {
  it('omits optional counters when absent (lossless shape)', () => {
    expect(mapAnthropicUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({
      input_tokens: 1,
      output_tokens: 2,
    })
  })
})

describe('estimateInputTokens (AN7 heuristic)', () => {
  it('counts CJK ~1/char and latin ~4 chars/token, images flat', () => {
    const n1 = estimateInputTokens({ messages: [{ role: 'user', content: '一二三四五' }] })
    expect(n1).toBe(5)
    const n2 = estimateInputTokens({ messages: [{ role: 'user', content: 'abcdefgh' }] })
    expect(n2).toBe(2)
    const n3 = estimateInputTokens({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }] }],
    })
    expect(n3).toBe(1000)
  })

  it('counts tools definitions (JSON-serialized) and tool_result contents', () => {
    const tools = [
      { name: 'get_weather', description: '天气查询', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
    ]
    const withTools = estimateInputTokens({ tools, messages: [{ role: 'user', content: 'hi' }] })
    const without = estimateInputTokens({ messages: [{ role: 'user', content: 'hi' }] })
    expect(withTools - without).toBe(tools.reduce((acc, t) => acc + estimateTokens(JSON.stringify(t)), 0))

    const withResult = estimateInputTokens({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agytc-x-1', content: '一二三四五' }] }],
    })
    expect(withResult).toBe(5)
    // Block-array tool_result content counts too.
    const withBlocks = estimateInputTokens({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agytc-x-1', content: [{ type: 'text', text: 'abcdefgh' }] }] }],
    })
    expect(withBlocks).toBe(2)
  })
})

describe('error helpers', () => {
  it('anthropicError carries the gateway request id when provided', () => {
    expect(anthropicError('invalid_request_error', 'x').request_id).toBeUndefined()
    expect(anthropicError('invalid_request_error', 'x', 'req-1').request_id).toBe('req-1')
  })

  it('stampRequestId adds request_id to Anthropic bodies only', () => {
    const an = stampRequestId(anthropicError('invalid_request_error', 'm'), 'rid')
    expect(an).toMatchObject({ type: 'error', request_id: 'rid' })
    const oa = stampRequestId(openAiError('m', 't', 'c'), 'rid') as { error: { param: string | null } }
    expect('request_id' in oa).toBe(false)
    expect(oa.error.param).toBeNull()
  })

  it('routes anthropic paths but not openai ones', () => {
    expect(isAnthropicPath('/v1/messages')).toBe(true)
    expect(isAnthropicPath('/v1/messages/count_tokens?x=1')).toBe(true)
    expect(isAnthropicPath('/v1/anthropic/models')).toBe(true)
    expect(isAnthropicPath('/v1/chat/completions')).toBe(false)
    expect(isAnthropicPath('/v1/models')).toBe(false)
  })

  it('maps engine failures with the 529 overloaded extension', () => {
    const ok = engineFailureToAnthropic('boom', 'PROCESS_EXIT')
    expect(ok.statusCode).toBe(502)
    expect(ok.body.error.type).toBe('api_error')
    const auth = engineFailureToAnthropic('not signed in', 'AUTH')
    expect(auth.statusCode).toBe(401)
    expect(auth.body.error.type).toBe('authentication_error')
    const ov = engineFailureToAnthropic('model overloaded', 'AGY_ERROR')
    expect(ov.statusCode).toBe(529)
    expect(ov.body.error.type).toBe('overloaded_error')
  })
})

describe('anthropicStreamEvents', () => {
  function run(chunks: StreamChunk[]): Array<{ event: string; data: Record<string, unknown> }> {
    const state = { messageStarted: false, blockIndex: 0, openType: null as 'text' | 'thinking' | 'tool_use' | null }
    const out: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const ch of chunks) {
      for (const ev of anthropicStreamEvents({ id: 'msg_x', model: 'm', chunk: ch, state })) out.push(ev)
    }
    return out
  }

  it('emits message_start once with an empty message', () => {
    const events = run([{ type: 'text-delta', index: 0, text: 'hi' }])
    expect(events[0]?.event).toBe('message_start')
    const msg = events[0]?.data.message as Record<string, unknown>
    expect(msg).toMatchObject({ id: 'msg_x', type: 'message', role: 'assistant', content: [] })
  })

  it('message_start.usage.input_tokens carries the provided estimate', () => {
    const state = { messageStarted: false, blockIndex: 0, openType: null as 'text' | 'thinking' | 'tool_use' | null }
    const out: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const ev of anthropicStreamEvents({ id: 'msg_x', model: 'm', chunk: { type: 'text-delta', index: 0, text: 'hi' }, state, inputTokens: 42 })) {
      out.push(ev)
    }
    const msg = out[0]?.data.message as Record<string, unknown>
    expect((msg.usage as Record<string, unknown>).input_tokens).toBe(42)
    expect((msg.usage as Record<string, unknown>).output_tokens).toBe(0)
  })

  it('blocks open/close around thinking → text transitions (AN3)', () => {
    const events = run([
      { type: 'reasoning-delta', index: 0, text: 'th' },
      { type: 'text-delta', index: 1, text: 'te' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const names = events.map((e) => e.event)
    expect(names).toEqual([
      'message_start',
      'content_block_start', // thinking
      'content_block_delta', // thinking_delta
      'content_block_stop',
      'content_block_start', // text
      'content_block_delta', // text_delta
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const start1 = events[1]?.data.content_block as Record<string, unknown>
    expect(start1.type).toBe('thinking')
    const d1 = events[2]?.data.delta as Record<string, unknown>
    expect(d1).toEqual({ type: 'thinking_delta', thinking: 'th' })
    const d2 = events[5]?.data.delta as Record<string, unknown>
    expect(d2).toEqual({ type: 'text_delta', text: 'te' })
    const md = events[7]?.data
    expect((md?.delta as Record<string, unknown>).stop_reason).toBe('end_turn')
    // usage rides the generator arg; none was passed here, so the zero frame.
    expect(md?.usage).toEqual({ output_tokens: 0 })
    // signature_delta is never emitted (agy has no thinking signatures).
    expect(JSON.stringify(events)).not.toContain('signature_delta')
  })

  it('emits tool_use blocks with one complete input_json_delta (AN5)', () => {
    const events = run([
      {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('agytc-r-2'), name: 'agy_tool', arguments: '{"step":2}' },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const start = events.find((e) => e.event === 'content_block_start')
    expect((start?.data.content_block as Record<string, unknown>)).toMatchObject({
      type: 'tool_use', id: 'agytc-r-2', name: 'agy_tool',
    })
    const delta = events.find((e) => e.event === 'content_block_delta')
    expect((delta?.data.delta as Record<string, unknown>).partial_json).toBe('{"step":2}')
    const md = events.find((e) => e.event === 'message_delta')
    expect((md?.data.delta as Record<string, unknown>).stop_reason).toBe('tool_use')
  })

  it('turns error finishes into the terminal error event', () => {
    const events = run([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'PROCESS_EXIT' } } },
    ])
    const last = events[events.length - 1]
    expect(last?.event).toBe('error')
    expect(last?.data.error).toMatchObject({ type: 'api_error', message: 'boom' })
    // No message_stop after an error terminal.
    expect(events.some((e) => e.event === 'message_stop')).toBe(false)
  })

  it('maps error-finish codes through anthropicStatusFor (529 parity, M14)', () => {
    // Pre-fix the in-stream terminal hardcoded api_error, so an upstream
    // overload surfaced as 502-shaped api_error even though the non-stream
    // leg maps the same failure to 529 overloaded_error.
    const ov = run([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'model overloaded', code: 'AGY_ERROR' } } },
    ])
    const ovErr = ov[ov.length - 1]
    expect(ovErr?.event).toBe('error')
    expect(ovErr?.data.error).toMatchObject({ type: 'overloaded_error', message: 'model overloaded' })
    // Unmapped codes keep the api_error default; aborted rides the same table.
    const ab = run([
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'stop', code: 'AUTH' } } },
    ])
    expect(ab[ab.length - 1]?.data.error).toMatchObject({ type: 'authentication_error', message: 'stop' })
  })

  it('stop_sequence override lands in message_delta (streaming stop echo)', () => {
    const state = { messageStarted: false, blockIndex: 0, openType: null as 'text' | 'thinking' | 'tool_use' | null }
    const out: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const ev of anthropicStreamEvents({ id: 'msg_x', model: 'm', chunk: { type: 'finish', reason: { kind: 'stop' } }, state, stopSequence: 'STOP' })) {
      out.push(ev)
    }
    const md = out.find((e) => e.event === 'message_delta')
    expect(md?.data.delta).toEqual({ stop_reason: 'stop_sequence', stop_sequence: 'STOP' })
  })
})
