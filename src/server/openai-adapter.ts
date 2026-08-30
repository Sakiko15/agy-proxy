// OpenAI Chat Completions adapter (non-streaming leg of charter §4.2): maps
// inbound /v1/chat/completions bodies onto EngineCalls and the engine's
// StreamChunk span onto the OpenAI completion body. Pure functions — no
// Fastify imports — so the mapping tables are unit-testable in isolation.
// New code, not a port. Field decisions follow docs/charter.md §4.2/§4.3.
import { randomBytes } from 'node:crypto'
import { Err, type GatewayConfig } from '../common/types.ts'
import { parseMirrorCallId } from '../host/recording.ts'
import type { EngineCall, EngineMessage } from '../host/engine.ts'
import type {
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from '../host/stream-types.ts'
import { GatewayHttpError, httpError } from './errors.ts'

// ---- response body shapes (only what this adapter emits) ----

export interface OpenAiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details: { cached_tokens: number }
  completion_tokens_details: { reasoning_tokens: number }
}

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
    logprobs: null
  }>
  usage: OpenAiUsage
}

export interface RequestMeta {
  requestId: string
  warnings: string[]
  /** Validated max-token cap; M1 carries it for accounting only (OA10, M2). */
  maxTokens?: number
}

/** chatcmpl- + 24 base64url chars (openai-node examples use the same shape). */
export function newCompletionId(): string {
  return 'chatcmpl-' + randomBytes(18).toString('base64url')
}

// ---- request mapping -------------------------------------------------------

function bad(message: string): GatewayHttpError {
  return httpError(400, message, 'invalid_request_error', 'invalid_request')
}

const EFFORT_MAP: Record<string, string | undefined> = {
  none: undefined,
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/** reasoning_effort → engine effort (charter §4.2). none → no effort flag. */
export function mapEffort(e: unknown): string | undefined {
  if (e === undefined || e === null) return undefined
  if (typeof e !== 'string' || !(e in EFFORT_MAP)) {
    throw bad('reasoning_effort must be one of none, minimal, low, medium, high, xhigh, max')
  }
  return EFFORT_MAP[e]
}

function contentToText(content: unknown, role: string): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part === null || typeof part !== 'object') throw bad(role + ' content part must be an object')
      const p = part as { type?: unknown; text?: unknown }
      if (p.type === 'text') {
        if (typeof p.text !== 'string') throw bad(role + ' text part must carry a string `text`')
        parts.push(p.text)
        continue
      }
      if (p.type === 'image_url') throw bad('image inputs arrive in M2 — this gateway accepts text only for now')
      if (p.type === 'input_audio') throw bad('audio input is not supported by this gateway')
      throw bad('unsupported ' + role + ' content part type: ' + String(p.type))
    }
    return parts.join('')
  }
  throw bad(role + ' content must be a string or an array of content parts')
}

/** Map one OpenAI request body onto an EngineCall (throws 400s). */
export function mapChatRequest(
  body: unknown,
  cfg: GatewayConfig,
): { call: EngineCall; meta: RequestMeta } {
  if (body === null || typeof body !== 'object') throw bad('request body must be a JSON object')
  const b = body as Record<string, unknown>
  const warnings: string[] = []

  if (b.stream === true) {
    throw bad('streaming support arrives in M2 — use stream:false')
  }
  if (b.stream !== undefined && typeof b.stream !== 'boolean') throw bad('stream must be a boolean')

  const model = typeof b.model === 'string' && b.model.trim() !== '' ? b.model : cfg.defaultModel
  if (model === '') throw bad('model is required')
  if (typeof b.model !== 'string' && b.model !== undefined) throw bad('model must be a string')

  const rawMessages = b.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw bad('messages must be a non-empty array')

  const messages: EngineMessage[] = []
  const systemParts: string[] = []
  for (const raw of rawMessages) {
    if (raw === null || typeof raw !== 'object') throw bad('each message must be an object')
    const m = raw as Record<string, unknown>
    const role = m.role
    if (role === 'system' || role === 'developer') {
      systemParts.push(contentToText(m.content, String(role)))
      continue
    }
    if (role === 'user') {
      if (m.tool_calls !== undefined) throw bad('user messages cannot carry tool_calls')
      messages.push({ role: 'user', text: contentToText(m.content, 'user') })
      continue
    }
    if (role === 'assistant') {
      if (m.tool_calls !== undefined) throw bad('assistant tool_calls round trips arrive in M2')
      messages.push({ role: 'assistant', text: contentToText(m.content, 'assistant') })
      continue
    }
    if (role === 'tool') {
      // A tool result is meaningful only as the continuation cursor of one of
      // OUR mirrored agy tool calls (engine detects the agytc- run/step id).
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined
      if (callId === undefined || parseMirrorCallId(callId) === null) {
        throw bad('tool messages are only accepted as continuations of this gateway\'s own tool calls (agytc- cursor)')
      }
      messages.push({ role: 'tool', text: contentToText(m.content, 'tool'), toolCallId: callId })
      continue
    }
    if (role === 'function') throw bad('the legacy function role is not supported — use tools in M2')
    throw bad('unsupported message role: ' + String(role))
  }

  if (Array.isArray(b.tools) || b.tool_choice !== undefined) {
    throw bad('tool calling round trips arrive in M2 — this gateway accepts text requests only for now')
  }
  if (b.functions !== undefined || b.function_call !== undefined) {
    throw bad('the legacy functions API is not supported — use tools (arrives in M2)')
  }
  if (typeof b.n === 'number' && b.n > 1) {
    throw bad('n > 1 is not supported (single candidate only)')
  }

  const effort = mapEffort(b.reasoning_effort)

  let maxTokens: number | undefined
  if (b.max_completion_tokens !== undefined) {
    if (typeof b.max_completion_tokens !== 'number' || !Number.isInteger(b.max_completion_tokens) || b.max_completion_tokens <= 0) {
      throw bad('max_completion_tokens must be a positive integer')
    }
    maxTokens = b.max_completion_tokens
    if (b.max_tokens !== undefined) warnings.push('both max_tokens and max_completion_tokens were sent; max_completion_tokens wins')
  } else if (b.max_tokens !== undefined) {
    if (typeof b.max_tokens !== 'number' || !Number.isInteger(b.max_tokens) || b.max_tokens <= 0) {
      throw bad('max_tokens must be a positive integer')
    }
    maxTokens = b.max_tokens
    warnings.push('max_tokens is deprecated by OpenAI; prefer max_completion_tokens')
  }

  for (const k of ['temperature', 'top_p'] as const) {
    if (b[k] !== undefined && (typeof b[k] !== 'number' || Number.isNaN(b[k]))) throw bad(k + ' must be a number')
  }
  const IGNORED_PARAMS = [
    'temperature', 'top_p', 'frequency_penalty', 'presence_penalty',
    'seed', 'logprobs', 'top_logprobs', 'service_tier', 'store', 'parallel_tool_calls',
  ] as const
  for (const k of IGNORED_PARAMS) {
    if (b[k] !== undefined) warnings.push(k + ' is accepted but not forwarded (agy has no corresponding knob)')
  }

  let stop: string[] = []
  if (b.stop !== undefined && b.stop !== null) {
    if (typeof b.stop === 'string') {
      if (b.stop === '') throw bad('stop must not be an empty string')
      stop = [b.stop]
    } else if (Array.isArray(b.stop)) {
      if (b.stop.length > 4) throw bad('stop accepts at most 4 sequences')
      for (const s of b.stop) {
        if (typeof s !== 'string' || s === '') throw bad('stop sequences must be non-empty strings')
      }
      stop = b.stop as string[]
    } else {
      throw bad('stop must be a string or an array of strings')
    }
  }

  let system: string | undefined
  let jsonSchema: unknown
  if (b.response_format !== undefined && b.response_format !== null) {
    const rf = b.response_format as Record<string, unknown>
    if (rf.type === 'json_object') {
      systemParts.push('Respond with a single valid JSON document and nothing else.')
      warnings.push('response_format json_object is enforced by prompt + gateway-side parse check, not a hard guarantee')
    } else if (rf.type === 'json_schema') {
      const js = rf.json_schema as Record<string, unknown> | undefined
      const schema = js?.schema
      if (schema === undefined || schema === null || typeof schema !== 'object') {
        throw bad('response_format json_schema requires json_schema.schema')
      }
      jsonSchema = schema // native --json-schema passthrough; `strict` is semantic only
    } else {
      throw bad('unsupported response_format type: ' + String(rf.type))
    }
  }
  if (systemParts.length > 0) system = systemParts.join('\n\n')

  if (b.metadata !== undefined || b.user !== undefined || b.safety_identifier !== undefined) {
    warnings.push('metadata/user/safety_identifier are logged context only — never forwarded upstream')
  }

  const call: EngineCall = {
    model,
    messages,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
  }
  return { call, meta: { requestId: '', warnings, ...(maxTokens !== undefined ? { maxTokens } : {}) } }
}

// ---- response mapping ------------------------------------------------------

export interface CollectedChunks {
  text: string
  reasoningChars: number
  toolCalls: ToolCallBlock[]
  usage: TokenUsage | null
  finish: FinishReason | null
}

/** Accumulate one non-streaming span. content counts text-delta ONLY — the
 *  block-end text block would double-count. usage precedes finish (protocol
 *  invariant), so the last usage chunk is final. */
export function collectChunks(chunks: readonly StreamChunk[]): CollectedChunks {
  const out: CollectedChunks = { text: '', reasoningChars: 0, toolCalls: [], usage: null, finish: null }
  for (const ch of chunks) {
    if (ch.type === 'text-delta') out.text += ch.text
    else if (ch.type === 'reasoning-delta') out.reasoningChars += ch.text.length
    else if (ch.type === 'block-end' && ch.block.type === 'tool-call') out.toolCalls.push(ch.block)
    else if (ch.type === 'usage') out.usage = ch.usage
    else if (ch.type === 'finish') out.finish = ch.reason
  }
  return out
}

/**
 * usage mapping (charter §4.3): engine counts are DISJOINT (inputTokens =
 * uncached input) while OpenAI's prompt_tokens is total-with-cache; we follow
 * the charter mapping literally (input → prompt, cache_read → detail) and
 * revisit the semantics during the M2 golden pass (OA3).
 */
export function mapUsage(u: TokenUsage): OpenAiUsage {
  const prompt = u.inputTokens
  const completion = u.outputTokens
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
  }
}

/** Truncate at the earliest stop-sequence match, if any. finish stays 'stop'. */
function applyStop(text: string, stop: readonly string[]): string {
  let cut = -1
  for (const s of stop) {
    const i = text.indexOf(s)
    if (i >= 0 && (cut === -1 || i < cut)) cut = i
  }
  return cut >= 0 ? text.slice(0, cut) : text
}

function finishReasonOf(kind: 'stop' | 'tool-calls' | 'max-tokens'): 'stop' | 'tool_calls' | 'length' {
  if (kind === 'tool-calls') return 'tool_calls'
  if (kind === 'max-tokens') return 'length'
  return 'stop'
}

export function assembleCompletion(args: {
  id: string
  created: number
  requestModel: string
  collected: CollectedChunks
  stop: readonly string[]
}): OpenAiChatCompletion {
  const { id, created, requestModel, collected, stop } = args
  const finish = collected.finish
  // error/aborted finishes never reach here — the route converts them into
  // HTTP error bodies first (charter §4.4); stop without a finish is not a
  // protocol state, so defaulting to 'stop' is safe for well-formed spans.
  const kind = finish !== null && (finish.kind === 'stop' || finish.kind === 'tool-calls' || finish.kind === 'max-tokens')
    ? finish.kind
    : 'stop'
  const text = applyStop(collected.text, stop)
  const toolCalls: OpenAiToolCall[] = collected.toolCalls.map((t) => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: t.arguments },
  }))
  const content = text === '' && toolCalls.length > 0 ? null : text
  return {
    id,
    object: 'chat.completion',
    created,
    model: requestModel, // echo the request's model string verbatim
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReasonOf(kind),
        logprobs: null,
      },
    ],
    usage: mapUsage(collected.usage ?? { inputTokens: 0, outputTokens: 0 }),
  }
}

/** Re-export for the route handler's Err-based error path. */
export { Err }
