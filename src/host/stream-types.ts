// Provider-neutral streaming vocabulary for the agy-proxy engine and protocol
// adapters. Localized from @deepseek-ai/dsh-llm lib/types/{types,brand}.d.ts
// @ 0.1.0-rc.7 (MIT) — the subset the engine layer actually uses. Shape-compatible
// with the upstream protocol so protocol adapters can map 1:1 (usage precedes
// finish and nothing follows it; one content block open at a time; tool
// arguments stay raw JSON strings).
import { randomUUID } from 'node:crypto'

declare const brand: unique symbol
/** Nominal-typing marker: a branded string is not assignable to plain string. */
type Branded<B extends string> = string & { readonly [brand]: B }

/** Correlates a model-issued tool call with its result. */
export type CallId = Branded<'CallId'>
/** Brand a string as a {@link CallId}; no validation is performed. */
export function CallId(id: string): CallId {
  return id as CallId
}

/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: string
}

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

/**
 * Why a model response stopped.
 */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens`.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Adapter-private state carried by a terminal `finish` chunk for replaying a
 * successful response. agy-proxy stores the agy conversation id here.
 */
export interface ReplayEnvelope {
  /** Response-level adapter-private metadata (ids, native stop reason). */
  response: unknown
}

/**
 * Raw streaming protocol emitted by the engine. Block indexes correlate
 * interleaved deltas, and `block-end` carries the assembled block. Emitters
 * put usage before the terminal finish and nothing afterward.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }

/** Fresh random id usable as a message/session identifier. */
export function freshId(): string {
  return randomUUID()
}
