// OpenAI Chat Completions adapter (non-streaming leg of charter §4.2): maps
// inbound /v1/chat/completions bodies onto EngineCalls and the engine's
// StreamChunk span onto the OpenAI completion body. Pure functions — no
// Fastify imports — so the mapping tables are unit-testable in isolation.
// New code, not a port. Field decisions follow docs/charter.md §4.2/§4.3.
import { randomBytes } from 'node:crypto'
import { Err, type GatewayConfig } from '../common/types.ts'
import { parseMirrorCallId } from '../host/recording.ts'
import { findEntry, resolveModelSlug } from '../host/models.ts'
import type { EngineCall, EngineMessage, EngineMessageImage } from '../host/engine.ts'
import type {
  FinishReason,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from '../host/stream-types.ts'
import { GatewayHttpError, httpError, openAiError } from './errors.ts'
import { estimateTokens } from './tokens.ts'

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
  /** Validated max-token cap; drives OA10 gateway-side truncation. */
  maxTokens?: number
  /** Stop sequences (post-truncation on the assembled text). */
  stop: string[]
  /** Images staged from data: URLs (media.ts writes the bytes to disk). */
  imageBytes: Map<string, Uint8Array>
  /** streaming_options.include_usage — the usage chunk rides the final frames. */
  includeUsage: boolean
  /** The request asked for SSE. */
  stream?: boolean
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
      if (p.type === 'image_url') throw bad(role + ' image_url parts are only supported on user messages')
      if (p.type === 'input_audio') throw bad('audio input is not supported by this gateway')
      throw bad('unsupported ' + role + ' content part type: ' + String(p.type))
    }
    return parts.join('')
  }
  throw bad(role + ' content must be a string or an array of content parts')
}

const IMAGE_MIME: Record<string, EngineMessageImage['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/**
 * Decode one data:/base64 image_url into staging bytes. Only data: URLs are
 * accepted in M2 (user decision): http(s) fetching from a VPS-resident
 * gateway is an SSRF surface deferred to the M5 hardening pass.
 */
function decodeDataImageUrl(url: string, imageBytes: Map<string, Uint8Array>): EngineMessageImage {
  let rest: string
  if (url.startsWith('data:')) {
    rest = url.slice(5)
  } else {
    // Bare base64 without the data: prefix (some clients send it).
    if (!/^[A-Za-z0-9+/=\s]+$/.test(url)) {
      throw bad('image_url must be a data: URL (http(s) URLs are not fetched by this gateway — see docs)')
    }
    rest = 'image/png;base64,' + url.replace(/\s+/g, '')
  }
  const comma = rest.indexOf(',')
  if (comma < 0) throw bad('image_url data: URL must carry base64 payload')
  const meta = rest.slice(0, comma).toLowerCase()
  const payload = rest.slice(comma + 1)
  const mime = meta.split(';')[0] ?? ''
  const mediaType = IMAGE_MIME[mime]
  if (mediaType === undefined) {
    throw bad(`unsupported image media type '${mime}' — supported: image/png, image/jpeg, image/webp, image/gif`)
  }
  if (!meta.includes('base64')) throw bad('image_url data: URL must be base64-encoded')
  // B-M5: Buffer IS a Uint8Array — no second full copy of the staged image.
  // Buffer.from cannot throw on a validated string (invalid base64 chars are
  // skipped); an empty decode is the only malformed case left.
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0) throw bad('image_url base64 payload is empty')
  const name = 'img-' + String(imageBytes.size + 1)
  imageBytes.set(name, bytes)
  return { name, mediaType, bytes: bytes.length }
}

async function contentToTextAndImages(
  content: unknown,
  imageBytes: Map<string, Uint8Array>,
): Promise<{ text: string; images: EngineMessageImage[] }> {  if (content === null || content === undefined) return { text: '', images: [] }
  if (typeof content === 'string') return { text: content, images: [] }
  if (Array.isArray(content)) {
    const parts: string[] = []
    const images: EngineMessageImage[] = []
    for (const part of content) {
      if (part === null || typeof part !== 'object') throw bad('user content part must be an object')
      const p = part as { type?: unknown; text?: unknown; image_url?: unknown }
      if (p.type === 'text') {
        if (typeof p.text !== 'string') throw bad('user text part must carry a string `text`')
        parts.push(p.text)
        continue
      }
      if (p.type === 'image_url') {
        const iu = p.image_url as { url?: unknown } | undefined
        if (iu === null || typeof iu !== 'object' || typeof iu.url !== 'string') {
          throw bad('image_url part must carry image_url.url')
        }
        images.push(decodeDataImageUrl(iu.url, imageBytes))
        continue
      }
      if (p.type === 'input_audio') throw bad('audio input is not supported by this gateway')
      throw bad('unsupported user content part type: ' + String(p.type))
    }
    return { text: parts.join(''), images }
  }
  throw bad('user content must be a string or an array of content parts')
}

/**
 * B-M5: after mapping, the staged bytes live in meta.imageBytes — but the
 * request body kept holding every data:-URL payload (multi-MB each) until the
 * response finished (fastify's body reference + the streaming closures keep
 * it reachable). Blank the payloads here (the map already consumed them);
 * the OpenAI leg has no body-reading token estimate, and nothing else reads
 * the images after mapping.
 */
function releaseBodyImageData(b: Record<string, unknown>): void {
  if (!Array.isArray(b.messages)) return
  for (const m of b.messages) {
    if (m === null || typeof m !== 'object') continue
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part === null || typeof part !== 'object') continue
      const p = part as { type?: unknown; image_url?: unknown }
      if (p.type !== 'image_url') continue
      const iu = p.image_url
      if (iu !== null && typeof iu === 'object') {
        ;(iu as { url?: unknown }).url = ''
      }
    }
  }
}

/** Map one OpenAI request body onto an EngineCall (throws 400s). */
export async function mapChatRequest(
  body: unknown,
  cfg: GatewayConfig,
  catalog?: Parameters<typeof findEntry>[0],
): Promise<{ call: EngineCall; meta: RequestMeta }> {
  if (body === null || typeof body !== 'object') throw bad('request body must be a JSON object')
  const b = body as Record<string, unknown>
  const warnings: string[] = []
  const imageBytes = new Map<string, Uint8Array>()

  if (b.stream !== undefined && typeof b.stream !== 'boolean') throw bad('stream must be a boolean')

  if (b.model !== undefined && typeof b.model !== 'string') throw bad('model must be a string')
  // A whitespace-only model string is a client bug — reject instead of
  // silently substituting the default model.
  if (typeof b.model === 'string' && b.model.trim() === '') throw bad('model must be a non-empty string')
  const model = typeof b.model === 'string' ? b.model : cfg.defaultModel
  if (model === '') throw bad('model is required')

  // OA8: when a LIVE catalog was discovered, an unknown id is rejected up
  // front with the list of available models. With only the fallback catalog
  // (signed out / offline) the advisory M1 behavior stays: forward and let
  // agy surface its real error (the fallback list may be stale).
  if (catalog !== undefined && catalog.source === 'discovered') {
    const resolved = resolveModelSlug(model)
    if (findEntry(catalog, model) === undefined && resolved === model) {
      const available = catalog.models.map((m) => m.id).join(', ')
      throw new GatewayHttpError(
        404,
        openAiError(
          `model '${model}' was not found by this gateway — available models: ${available}`,
          'invalid_request_error',
          'model_not_found',
        ),
      )
    }
  }

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
      const { text, images } = await contentToTextAndImages(m.content, imageBytes)
      messages.push({ role: 'user', text, ...(images.length > 0 ? { images } : {}) })
      continue
    }
    if (role === 'assistant') {
      // Assistant turns carrying tool_calls are kept as foreign context turns:
      // the engine's digest treats unmarked assistant text as history agy has
      // not seen. (Our own mirror round trips arrive as role:'tool' below.)
      const text = contentToText(m.content, 'assistant')
      messages.push({ role: 'assistant', text })
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

  // B-M5: drop the base64 payloads from the request body now that the staged
  // bytes are in meta.imageBytes (see releaseBodyImageData).
  releaseBodyImageData(b)

  // Client tool definitions are ACCEPTED BUT IGNORED (M2 decision, charter
  // §4.2): agy runs its own tool loop and the gateway mirrors that activity
  // as tool_calls/tool_use. Definitions are never forwarded nor executed —
  // clients that always send them (Cursor, agent frameworks) keep working.
  if (Array.isArray(b.tools) && b.tools.length > 0) {
    warnings.push('tools were accepted but are not executed by this gateway (agy runs its own tool loop); tool_calls in responses mirror agy activity')
  }
  if (b.tool_choice !== undefined) {
    warnings.push('tool_choice is accepted but not forwarded (client tool definitions are not executed)')
  }
  if (b.functions !== undefined || b.function_call !== undefined) {
    throw bad('the legacy functions API is not supported — use tools')
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
    'logit_bias', 'verbosity', 'modalities', 'prediction', 'top_k',
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
      warnings.push('response_format json_object is best-effort: enforced by prompt instruction only, output validity is not a hard guarantee')
    } else if (rf.type === 'json_schema') {
      const js = rf.json_schema as Record<string, unknown> | undefined
      const schema = js?.schema
      if (schema === undefined || schema === null || typeof schema !== 'object') {
        throw bad('response_format json_schema requires json_schema.schema')
      }
      jsonSchema = schema // native --json-schema passthrough; `strict` is semantic only
    } else if (rf.type === 'text') {
      // Spec-legal default (plain text output) — a no-op for this gateway.
      // Only genuinely unknown types are rejected.
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
  // stream_options.include_usage: the usage frame rides the end of the SSE
  // stream (choices:[]) instead of the body.
  let includeUsage = false
  if (b.stream_options !== undefined) {
    const so = b.stream_options as Record<string, unknown>
    if (so === null || typeof so !== 'object' || (so.include_usage !== undefined && typeof so.include_usage !== 'boolean')) {
      throw bad('stream_options must be an object with an optional boolean include_usage')
    }
    if (so.include_usage === true) includeUsage = true
  }
  const stream = b.stream === true
  return {
    call,
    meta: {
      requestId: '',
      warnings,
      stop,
      imageBytes,
      includeUsage,
      ...(stream ? { stream: true } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    },
  }
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

function finishReasonOf(kind: 'stop' | 'tool-calls' | 'max-tokens'): 'stop' | 'tool_calls' | 'length' {
  if (kind === 'tool-calls') return 'tool_calls'
  if (kind === 'max-tokens') return 'length'
  return 'stop'
}

/**
 * OA10 gateway-side max_tokens truncation. There is no tokenizer at the
 * gateway: outputTokens from agy INCLUDES thinking tokens, so the visible
 * text is cut proportionally — text.length * (max / outputTokens) — and the
 * finish becomes 'length'. Best-effort by design (documented); tool-call
 * spans are never truncated (their finish semantics differ).
 */
export function applyMaxTokens(collected: CollectedChunks, maxTokens: number | undefined): CollectedChunks {
  if (maxTokens === undefined || collected.finish === null || collected.finish.kind !== 'stop') return collected
  const output = collected.usage?.outputTokens ?? 0
  if (output <= 0 || output <= maxTokens || collected.text === '') return collected
  const keepChars = Math.max(0, Math.floor((collected.text.length * maxTokens) / output))
  if (keepChars >= collected.text.length) return collected
  return { ...collected, text: collected.text.slice(0, keepChars), finish: { kind: 'max-tokens' } }
}

/**
 * AN10 / OA10 shared: cut at the earliest stop-sequence match and report the
 * hit. The stop_sequence value is echoed back on the Anthropic side
 * (stop_sequence field); OpenAI keeps finish 'stop' per its own contract.
 */
export function applyStopWithHit(
  text: string,
  stop: readonly string[],
): { text: string; hit: string | null } {
  let cut = -1
  let hit: string | null = null
  for (const s of stop) {
    const i = text.indexOf(s)
    if (i >= 0 && (cut === -1 || i < cut)) {
      cut = i
      hit = s
    }
  }
  return { text: cut >= 0 ? text.slice(0, cut) : text, hit }
}

/** Truncate at the earliest stop-sequence match, if any. finish stays 'stop'. */
function applyStop(text: string, stop: readonly string[]): string {
  return applyStopWithHit(text, stop).text
}

export function assembleCompletion(args: {
  id: string
  created: number
  requestModel: string
  collected: CollectedChunks
  stop: readonly string[]
  maxTokens?: number
}): OpenAiChatCompletion {
  const { id, created, requestModel, collected: raw, stop, maxTokens } = args
  const collected = applyMaxTokens(raw, maxTokens)
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

// ---- streaming mapping (charter §4.3, OpenAI leg) ---------------------------

export interface OpenAiChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{ index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }>
  usage?: OpenAiUsage | null
}

/** One chunk per call; the route serializes frames as they are produced. */
export function openAiChunkOf(id: string, created: number, model: string, chunk: OpenAiChunk['choices'][0]): OpenAiChunk {
  return { id, object: 'chat.completion.chunk', created, model, choices: [chunk] }
}

/**
 * Map one StreamChunk onto 0..n OpenAI SSE frames. The first frame of a span
 * carries delta:{role:'assistant',content:''} (OA2); tool-call blocks are
 * emitted from block-end so id/name/arguments land complete in one frame;
 * usage is emitted only at finish and only when include_usage was set — with
 * one spec addition: with stream_options.include_usage every INTERMEDIATE
 * chunk carries "usage": null (only the terminal choices:[] chunk carries
 * the counts), matching the official stream anatomy.
 */
export function* openAiStreamFrames(args: {
  id: string
  created: number
  model: string
  chunk: StreamChunk
  state: { firstSent: boolean; toolIndex: number; sawToolThisSpan: boolean }
  includeUsage: boolean
  /** Usage from the preceding usage chunk (protocol invariant: arrives before finish). */
  usage?: TokenUsage
}): Generator<OpenAiChunk | '[DONE]'> {
  if (!args.includeUsage) {
    yield* openAiStreamFramesCore(args)
    return
  }
  for (const frame of openAiStreamFramesCore(args)) {
    // The core emits the usage key only on the terminal choices:[] chunk;
    // every other chunk gets the spec's explicit null.
    yield typeof frame === 'string' || frame.usage !== undefined ? frame : { ...frame, usage: null }
  }
}

function* openAiStreamFramesCore(args: {
  id: string
  created: number
  model: string
  chunk: StreamChunk
  state: { firstSent: boolean; toolIndex: number; sawToolThisSpan: boolean }
  includeUsage: boolean
  usage?: TokenUsage
}): Generator<OpenAiChunk | '[DONE]'> {
  const { id, created, model, chunk, state, includeUsage, usage } = args
  if (!state.firstSent) {
    state.firstSent = true
    yield openAiChunkOf(id, created, model, { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null })
  }
  switch (chunk.type) {
    case 'text-delta':
      if (chunk.text !== '') {
        yield openAiChunkOf(id, created, model, { index: 0, delta: { content: chunk.text }, finish_reason: null })
      }
      return
    case 'reasoning-delta':
      // reasoning_content: an established ecosystem convention (official
      // OpenAI docs define no such field — documented deviation, charter §4.3).
      if (chunk.text !== '') {
        yield openAiChunkOf(id, created, model, { index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null })
      }
      return
    case 'block-end':
      if (chunk.block.type === 'tool-call') {
        yield openAiChunkOf(id, created, model, {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: state.toolIndex,
                id: chunk.block.id,
                type: 'function',
                function: { name: chunk.block.name, arguments: chunk.block.arguments },
              },
            ],
          },
          finish_reason: null,
        })
        state.toolIndex++
        state.sawToolThisSpan = true
      }
      return
    case 'finish': {
      const kind = chunk.reason.kind
      yield openAiChunkOf(id, created, model, {
        index: 0,
        delta: {},
        finish_reason: kind === 'tool-calls' ? 'tool_calls' : kind === 'max-tokens' ? 'length' : 'stop',
      })
      if (includeUsage) {
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: mapUsage(usage ?? { inputTokens: 0, outputTokens: 0 }),
        }
      }
      yield '[DONE]'
      return
    }
    default:
      return
  }
}
