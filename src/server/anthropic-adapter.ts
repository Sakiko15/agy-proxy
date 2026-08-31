// Anthropic Messages adapter (charter §4.2/§4.3, Anthropic leg): maps
// /v1/messages bodies onto EngineCalls and the engine's StreamChunk span onto
// Anthropic message bodies / SSE event sequences. Pure functions — no Fastify
// imports — so the mapping tables are unit-testable in isolation. New code,
// not a port; field decisions follow docs/charter.md §4.2-§4.4 and the
// platform.claude.com/docs references listed in charter.md §12 (messages,
// streaming, thinking, stop-reasons, count-tokens).
import { randomBytes } from 'node:crypto'
import type { GatewayConfig } from '../common/types.ts'
import { parseMirrorCallId } from '../host/recording.ts'
import type { EngineCall, EngineMessage, EngineMessageImage } from '../host/engine.ts'
import type {
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from '../host/stream-types.ts'
import { anthropicError, GatewayHttpError } from './errors.ts'
import { estimateTokens } from './tokens.ts'

// ---- response body shapes ---------------------------------------------------

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens_details?: { thinking_tokens: number }
}

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
}

export interface AnthropicMessage {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

/** msg_ + 24 base64url chars (Anthropic id convention). */
export function newMessageId(): string {
  return 'msg_' + randomBytes(18).toString('base64url')
}

// ---- request mapping ---------------------------------------------------------

function bad(message: string): GatewayHttpError {
  return new GatewayHttpError(400, anthropicError('invalid_request_error', message))
}

/**
 * budget_tokens tier boundaries (charter §4.2: "boundaries noted in the
 * docs" — this is the note): ≤4096 → low, ≤16384 → medium, else high.
 */
export const BUDGET_TIERS: ReadonlyArray<{ upTo: number; effort: string }> = [
  { upTo: 4_096, effort: 'low' },
  { upTo: 16_384, effort: 'medium' },
  { upTo: Number.MAX_SAFE_INTEGER, effort: 'high' },
]

/** thinking.budget_tokens → engine effort (charter §4.2). */
export function mapBudget(budgetTokens: unknown): string {
  if (typeof budgetTokens !== 'number' || !Number.isInteger(budgetTokens) || budgetTokens < 1024) {
    throw bad('thinking.budget_tokens must be an integer >= 1024')
  }
  for (const tier of BUDGET_TIERS) {
    if (budgetTokens <= tier.upTo) return tier.effort
  }
  return 'high'
}

/** thinking {type:enabled|adaptive|disabled} → engine effort or undefined. */
export function mapThinking(thinking: unknown): string | undefined {
  if (thinking === undefined || thinking === null) return undefined
  if (typeof thinking !== 'object') throw bad('thinking must be an object')
  const t = thinking as { type?: unknown; budget_tokens?: unknown }
  if (t.type === 'disabled') return undefined
  if (t.type === 'adaptive') return undefined // model default (charter §4.2)
  if (t.type === 'enabled') return mapBudget(t.budget_tokens)
  throw bad('thinking.type must be enabled, adaptive, or disabled')
}

/** Content block text extractor for system prompts. */
function systemText(system: unknown): string {
  if (system === undefined || system === null) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    // [{type:'text',text,cache_control?}] — cache_control is accepted and
    // ignored (agy has no explicit cache-control knob).
    const parts: string[] = []
    for (const block of system) {
      if (block === null || typeof block !== 'object') throw bad('system blocks must be objects')
      const b = block as { type?: unknown; text?: unknown }
      if (b.type !== 'text' || typeof b.text !== 'string') {
        throw bad('system blocks must be {type:"text", text}')
      }
      parts.push(b.text)
    }
    return parts.join('\n\n')
  }
  throw bad('system must be a string or an array of text blocks')
}

const IMAGE_MIME: Record<string, EngineMessageImage['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** image source {type:base64, media_type, data} → staging ref (user decision: base64 only). */
function decodeImageSource(source: unknown, imageBytes: Map<string, Uint8Array>): EngineMessageImage {
  if (source === null || typeof source !== 'object') throw bad('image source must be an object')
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown }
  if (s.type !== 'base64') {
    throw bad('only base64 image sources are accepted (url sources are not fetched by this gateway — see docs)')
  }
  const mediaType = typeof s.media_type === 'string' ? IMAGE_MIME[s.media_type] : undefined
  if (mediaType === undefined) {
    throw bad('image source media_type must be image/png, image/jpeg, image/webp, or image/gif')
  }
  if (typeof s.data !== 'string' || s.data === '') throw bad('image source data must be a base64 string')
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(s.data, 'base64'))
  } catch {
    throw bad('image source base64 payload is malformed')
  }
  if (bytes.length === 0) throw bad('image source base64 payload is empty')
  const name = 'img-' + String(imageBytes.size + 1)
  imageBytes.set(name, bytes)
  return { name, mediaType, bytes: bytes.length }
}

type MappedBlocks = { text: string; images: EngineMessageImage[] }

/** One message's content (string or block array) → engine text + staged images. */
function mapContent(content: unknown, role: 'user' | 'assistant', imageBytes: Map<string, Uint8Array>): MappedBlocks {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) throw bad(role + ' content must be a string or an array of blocks')
  const parts: string[] = []
  const images: EngineMessageImage[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') throw bad(role + ' content blocks must be objects')
    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text':
        if (typeof b.text !== 'string') throw bad('text blocks must carry a string `text`')
        parts.push(b.text)
        break
      case 'image':
        if (role !== 'user') throw bad('image blocks are only supported on user messages')
        images.push(decodeImageSource(b.source, imageBytes))
        break
      case 'thinking':
      case 'redacted_thinking': {
        // AN4: replayed thinking rides the context verbatim (charter §4.3 —
        // the gateway neither validates nor strips signatures).
        const th = b.thinking ?? b.data
        if (typeof th === 'string' && th !== '') parts.push('[thinking replay] ' + th)
        break
      }
      case 'tool_use':
        // Historical tool_use from a previous turn: keep as context text.
        if (typeof b.name === 'string') {
          parts.push('[tool_use replay] ' + b.name)
        }
        break
      case 'tool_result': {
        // Real continuation cursors are handled by the caller (role 'tool');
        // a stray tool_result elsewhere degrades to context text.
        const inner = b.content
        if (typeof inner === 'string') parts.push(inner)
        else if (Array.isArray(inner)) {
          for (const p of inner) {
            if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string') {
              parts.push((p as { text: string }).text)
            }
          }
        }
        break
      }
      default:
        throw bad('unsupported ' + role + ' content block type: ' + String(b.type))
    }
  }
  return { text: parts.join(''), images }
}

/**
 * Map one /v1/messages request body onto an EngineCall (throws 400s with
 * invalid_request_error). `max_tokens` is REQUIRED by the Messages API.
 */
export async function mapMessagesRequest(
  body: unknown,
  cfg: GatewayConfig,
  catalog?: Parameters<typeof import('../host/models.ts').findEntry>[0],
): Promise<{ call: EngineCall; meta: AnthropicRequestMeta }> {
  if (body === null || typeof body !== 'object') throw bad('request body must be a JSON object')
  const b = body as Record<string, unknown>
  const warnings: string[] = []
  const imageBytes = new Map<string, Uint8Array>()

  const model = typeof b.model === 'string' && b.model.trim() !== '' ? b.model : cfg.defaultModel
  if (model === '') throw bad('model is required')

  // OA8 mirror: same pre-validation policy as the OpenAI leg (live catalog
  // enforces, fallback stays advisory).
  if (catalog !== undefined && catalog.source === 'discovered') {
    const known = catalog.models.some((m) => m.id === model) || catalog.models.some((m) => m.id === model)
    if (!known) {
      const available = catalog.models.map((m) => m.id).join(', ')
      throw new GatewayHttpError(
        404,
        anthropicError(
          'not_found_error',
          `model '${model}' was not found by this gateway — available models: ${available}`,
        ),
      )
    }
  }

  if (!Array.isArray(b.messages) || b.messages.length === 0) throw bad('messages must be a non-empty array')

  let maxTokens: number | undefined
  if (b.max_tokens === undefined) {
    throw bad('max_tokens is required')
  }
  if (typeof b.max_tokens !== 'number' || !Number.isInteger(b.max_tokens) || b.max_tokens <= 0) {
    throw bad('max_tokens must be a positive integer')
  }
  maxTokens = b.max_tokens

  const messages: EngineMessage[] = []
  for (const raw of b.messages) {
    if (raw === null || typeof raw !== 'object') throw bad('each message must be an object')
    const m = raw as Record<string, unknown>
    const role = m.role
    if (role === 'user') {
      const { text, images } = mapContent(m.content, 'user', imageBytes)
      messages.push({ role: 'user', text, ...(images.length > 0 ? { images } : {}) })
      continue
    }
    if (role === 'assistant') {
      const { text } = mapContent(m.content, 'assistant', imageBytes)
      messages.push({ role: 'assistant', text })
      continue
    }
    throw bad('unsupported message role: ' + String(role))
  }

  // Continuation cursor: Anthropic tool_result blocks addressed to our
  // mirror tool are surfaced as the engine's role:'tool' continuation.
  const lastMsg = b.messages[b.messages.length - 1] as Record<string, unknown> | undefined
  if (lastMsg !== undefined && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
    for (const block of lastMsg.content) {
      if (block === null || typeof block !== 'object') continue
      const bl = block as Record<string, unknown>
      if (bl.type !== 'tool_result') continue
      const callId = typeof bl.tool_use_id === 'string' ? bl.tool_use_id : undefined
      if (callId === undefined || parseMirrorCallId(callId) === null) {
        throw bad('tool_result blocks are only accepted as continuations of this gateway\'s own tool_use blocks (agytc- ids)')
      }
      // The engine's continuation path keys on the LAST message being a tool
      // result. Replace the trailing user turn with the tool message.
      const text = typeof bl.content === 'string'
        ? bl.content
        : Array.isArray(bl.content)
          ? (bl.content as Array<{ type?: unknown; text?: unknown }>)
              .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text as string)
              .join('')
          : 'ok'
      messages[messages.length - 1] = { role: 'tool', text, toolCallId: callId }
    }
  }

  const effort = mapThinking(b.thinking)

  let stop: string[] = []
  if (b.stop_sequences !== undefined && b.stop_sequences !== null) {
    if (!Array.isArray(b.stop_sequences) || b.stop_sequences.length > 4) {
      throw bad('stop_sequences must be an array of at most 4 strings')
    }
    for (const s of b.stop_sequences) {
      if (typeof s !== 'string' || s === '') throw bad('stop_sequences entries must be non-empty strings')
    }
    stop = b.stop_sequences as string[]
  }

  let system: string | undefined
  const sys = systemText(b.system)
  if (sys !== '') system = sys

  let jsonSchema: unknown
  if (b.output_config !== undefined && b.output_config !== null) {
    const oc = b.output_config as Record<string, unknown>
    const format = oc.format as Record<string, unknown> | undefined
    if (format !== undefined) {
      if (format.type !== 'json_schema') throw bad('output_config.format.type must be json_schema')
      const schema = format.schema
      if (schema === undefined || schema === null || typeof schema !== 'object') {
        throw bad('output_config.format requires a schema')
      }
      jsonSchema = schema
    }
  }

  if (b.tools !== undefined && Array.isArray(b.tools) && b.tools.length > 0) {
    warnings.push('tools were accepted but are not executed by this gateway (agy runs its own tool loop); tool_use blocks in responses mirror agy activity')
  }
  if (b.metadata !== undefined) warnings.push('metadata is logged context only — never forwarded upstream')
  for (const k of ['temperature', 'top_p', 'top_k'] as const) {
    if (b[k] !== undefined) warnings.push(k + ' is accepted but not forwarded (agy has no corresponding knob)')
  }

  const call: EngineCall = {
    model,
    messages,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    ...(system !== undefined ? { system } : {}),
    ...(jsonSchema !== undefined ? { jsonSchema } : {}),
  }
  const stream = b.stream === true
  return {
    call,
    meta: {
      requestId: '',
      warnings,
      stop,
      imageBytes,
      ...(stream ? { stream: true } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    },
  }
}

export interface AnthropicRequestMeta {
  requestId: string
  warnings: string[]
  maxTokens?: number
  stop: string[]
  imageBytes: Map<string, Uint8Array>
  stream?: boolean
}

// ---- non-streaming response mapping ------------------------------------------

export interface CollectedChunks {
  text: string
  thinking: string
  toolCalls: ToolCallBlock[]
  usage: TokenUsage | null
  finish: FinishReason | null
}

/** Accumulate one span for the Anthropic body (block-end carries assembled blocks). */
export function collectChunks(chunks: readonly StreamChunk[]): CollectedChunks {
  const out: CollectedChunks = { text: '', thinking: '', toolCalls: [], usage: null, finish: null }
  for (const ch of chunks) {
    if (ch.type === 'text-delta') out.text += ch.text
    else if (ch.type === 'reasoning-delta') out.thinking += ch.text
    else if (ch.type === 'block-end' && ch.block.type === 'tool-call') out.toolCalls.push(ch.block)
    else if (ch.type === 'usage') out.usage = ch.usage
    else if (ch.type === 'finish') out.finish = ch.reason
  }
  return out
}

/**
 * usage mapping (charter §4.3): engine counts are DISJOINT (input_tokens =
 * uncached input); cache_read lands in cache_read_input_tokens. thinking
 * rides the output_tokens_details.thinking_tokens extension.
 */
export function mapAnthropicUsage(u: TokenUsage): AnthropicUsage {
  const usage: AnthropicUsage = {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
  }
  if (u.cacheReadTokens !== undefined) usage.cache_read_input_tokens = u.cacheReadTokens
  if (u.reasoningTokens !== undefined) usage.output_tokens_details = { thinking_tokens: u.reasoningTokens }
  return usage
}

/** AN10 + OA10: stop-sequence cut then max-token proportional truncation. */
function applyFinishTransforms(collected: CollectedChunks, meta: { stop: readonly string[]; maxTokens?: number }): { collected: CollectedChunks; stopHit: string | null } {
  let out = collected
  let stopHit: string | null = null
  // stop_sequences hit?
  let cut = -1
  for (const s of meta.stop) {
    const i = out.text.indexOf(s)
    if (i >= 0 && (cut === -1 || i < cut)) {
      cut = i
      stopHit = s
    }
  }
  if (cut >= 0 && out.finish?.kind === 'stop') {
    out = { ...out, text: out.text.slice(0, cut) }
  } else {
    stopHit = null
  }
  // max_tokens proportional truncation on stop-finished text.
  if (meta.maxTokens !== undefined && out.finish?.kind === 'stop' && !stopHit) {
    const output = out.usage?.outputTokens ?? 0
    if (output > meta.maxTokens && out.text !== '') {
      const keepChars = Math.max(0, Math.floor((out.text.length * meta.maxTokens) / output))
      if (keepChars < out.text.length) {
        out = { ...out, text: out.text.slice(0, keepChars), finish: { kind: 'max-tokens' } }
      }
    }
  }
  return { collected: out, stopHit }
}

function stopReasonOf(kind: 'stop' | 'tool-calls' | 'max-tokens', stopHit: string | null): AnthropicMessage['stop_reason'] {
  if (stopHit !== null) return 'stop_sequence'
  if (kind === 'tool-calls') return 'tool_use'
  if (kind === 'max-tokens') return 'max_tokens'
  return 'end_turn'
}

export function assembleMessage(args: {
  id: string
  requestModel: string
  collected: CollectedChunks
  stop: readonly string[]
  maxTokens?: number
}): AnthropicMessage {
  const { id, requestModel, collected: raw, stop, maxTokens } = args
  const { collected, stopHit } = applyFinishTransforms(raw, { stop, maxTokens })
  const finish = collected.finish
  // error/aborted finishes never reach here — the route converts them into
  // HTTP error bodies first (charter §4.4).
  const kind = finish !== null && (finish.kind === 'stop' || finish.kind === 'tool-calls' || finish.kind === 'max-tokens')
    ? finish.kind
    : 'stop'
  const content: AnthropicContentBlock[] = []
  // Block order: thinking → text → tool_use (charter §4.3 block sequence).
  if (collected.thinking !== '') content.push({ type: 'thinking', thinking: collected.thinking })
  if (collected.text !== '' || collected.toolCalls.length === 0) content.push({ type: 'text', text: collected.text })
  for (const t of collected.toolCalls) {
    content.push({ type: 'tool_use', id: t.id, name: t.name, input: safeParse(t.arguments) })
  }
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: stopReasonOf(kind, stopHit),
    stop_sequence: stopHit,
    usage: mapAnthropicUsage(collected.usage ?? { inputTokens: 0, outputTokens: 0 }),
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/** count_tokens (AN7): deterministic heuristic estimate, declared approximate. */
export function estimateInputTokens(body: unknown): number {
  let tokens = 0
  if (body !== null && typeof body === 'object') {
    const b = body as Record<string, unknown>
    tokens += estimateTokens(systemText(b.system))
    if (Array.isArray(b.messages)) {
      for (const m of b.messages) {
        if (m === null || typeof m !== 'object') continue
        const msg = m as Record<string, unknown>
        if (typeof msg.content === 'string') {
          tokens += estimateTokens(msg.content)
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block && typeof block === 'object') {
              const bl = block as Record<string, unknown>
              if (typeof bl.text === 'string') tokens += estimateTokens(bl.text)
              if (bl.type === 'image') tokens += 1000
              if (typeof bl.thinking === 'string') tokens += estimateTokens(bl.thinking)
            }
          }
        }
      }
    }
  }
  return tokens
}

// ---- streaming event mapping (charter §4.3, Anthropic leg) -------------------

export type AnthropicStreamEvent =
  | { event: 'message_start'; data: Record<string, unknown> }
  | { event: 'ping'; data: Record<string, unknown> }
  | { event: 'content_block_start'; data: Record<string, unknown> }
  | { event: 'content_block_delta'; data: Record<string, unknown> }
  | { event: 'content_block_stop'; data: Record<string, unknown> }
  | { event: 'message_delta'; data: Record<string, unknown> }
  | { event: 'message_stop'; data: Record<string, unknown> }
  | { event: 'error'; data: Record<string, unknown> }

/**
 * Map one StreamChunk onto 0..n Anthropic SSE events. Event order per AN2:
 * message_start → (content_block_start → delta* → content_block_stop)+
 * → message_delta → message_stop. agy never produces thinking signatures, so
 * signature_delta is not emitted (documented in charter §4.3).
 */
export function* anthropicStreamEvents(args: {
  id: string
  model: string
  chunk: StreamChunk
  state: {
    messageStarted: boolean
    blockIndex: number
    openType: 'text' | 'thinking' | 'tool_use' | null
  }
  usage?: TokenUsage
}): Generator<AnthropicStreamEvent> {
  const { id, model, chunk, state, usage } = args
  if (!state.messageStarted) {
    state.messageStarted = true
    yield {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    }
  }
  switch (chunk.type) {
    case 'reasoning-delta':
      if (state.openType !== 'thinking') {
        if (state.openType !== null) {
          yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: state.blockIndex } }
          state.blockIndex++
        }
        state.openType = 'thinking'
        yield {
          event: 'content_block_start',
          data: { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'thinking', thinking: '' } },
        }
      }
      if (chunk.text !== '') {
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'thinking_delta', thinking: chunk.text } } }
      }
      return
    case 'text-delta':
      if (state.openType !== 'text') {
        if (state.openType !== null) {
          yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: state.blockIndex } }
          state.blockIndex++
        }
        state.openType = 'text'
        yield {
          event: 'content_block_start',
          data: { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } },
        }
      }
      if (chunk.text !== '') {
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: chunk.text } } }
      }
      return
    case 'block-end':
      if (chunk.block.type === 'tool-call') {
        if (state.openType !== null) {
          yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: state.blockIndex } }
          state.blockIndex++
        }
        state.openType = 'tool_use'
        yield {
          event: 'content_block_start',
          data: { type: 'content_block_start', index: state.blockIndex, content_block: { type: 'tool_use', id: chunk.block.id, name: chunk.block.name, input: {} } },
        }
        // AN5: arguments ride one input_json_delta frame (complete JSON string).
        yield {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: chunk.block.arguments } },
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: state.blockIndex } }
        state.blockIndex++
        state.openType = null
      }
      return
    case 'finish': {
      if (state.openType !== null) {
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: state.blockIndex } }
        state.blockIndex++
        state.openType = null
      }
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        yield { event: 'error', data: { type: 'error', error: { type: 'api_error', message: chunk.reason.failure.message } } }
        return
      }
      const stopReason = chunk.reason.kind === 'tool-calls' ? 'tool_use' : chunk.reason.kind === 'max-tokens' ? 'max_tokens' : 'end_turn'
      const u = mapAnthropicUsage(usage ?? { inputTokens: 0, outputTokens: 0 })
      yield {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: u.output_tokens, ...(u.output_tokens_details !== undefined ? { output_tokens_details: u.output_tokens_details } : {}) },
        },
      }
      yield { event: 'message_stop', data: { type: 'message_stop' } }
      return
    }
    default:
      return
  }
}

/** Engine failure → Anthropic error event payload (stream error terminal). */
export function anthropicStreamErrorEvent(message: string, type: string): AnthropicStreamEvent {
  return { event: 'error', data: { type: 'error', error: { type, message } } }
}
