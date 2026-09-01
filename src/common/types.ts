// Shared vocabulary for agy-proxy: gateway config, stable error codes, and
// the normalized event stream produced by the stream-json parser.
// Ported from dsh-agy-link src/common/types.ts @ 46984db (modified: gateway
// config surface replaces plugin config; DSH-specific fields removed; new
// gateway fields added for keys/ledger/admin; AgyEvent/AgyToolInfo/RawUsage
// and the auth/rate-limit helpers brought over verbatim; AUX_DISABLED dropped
// — the gateway has no auxiliary compaction/title calls).

export const ENGINE_ID = 'agy-proxy'

export type PermissionMode = 'skip' | 'plan' | 'accept-edits'

export interface FallbackModelDef {
  id: string
  name: string
  /** Selectable reasoning efforts; omit for fixed-thinking models. */
  efforts?: readonly string[]
}

export interface GatewayConfig {
  enabled: boolean
  /** Absolute path to the agy binary; empty string = resolve from PATH. */
  agyBin: string
  /** Extra argv appended to every spawn (escape hatch). */
  extraArgs: readonly string[]
  /** Agy permission mode. `skip` (--dangerously-skip-permissions) grants
   *  unattended shell in the container — default off; enabling requires an
   *  explicit double-confirm in the admin UI (docs/charter.md §10). */
  permissionMode: PermissionMode
  defaultModel: string
  defaultEffort: string
  /** Activity watchdog for one full agy -p run. */
  timeoutMs: number
  /** Global upper bound on agy processes running concurrently. */
  maxConcurrent: number
  /** Max queued requests before 429 BUSY. */
  maxQueueDepth: number
  contextWindowDefault: number
  maxTokensDefault: number
  modelsCacheTtlMs: number
  /** Directory where inbound images are staged for agy (path-based multimodal). */
  mediaDir: string
  mediaTtlMs: number
  mediaMaxBytes: number
  mediaMaxImages: number
  /** Gateway workspace root for agy tool execution; each account gets an
   *  isolated subdirectory under it. Empty = <dataDir>/workspace. */
  workspaceRoot: string
  fallbackModels: readonly FallbackModelDef[]
  rateLimitPerMinute: number
  autoFallbackModel: boolean
  logRetentionDays: number
  /** Background quota polling interval in ms (default 15 min; clamped >= 60s).
   *  Lower = more risk-control exposure on cloud IPs. */
  quotaPollIntervalMs: number
  /** Disable agy's Google Cloud Code / Antigravity telemetry tracking. */
  disableTelemetry: boolean
  /** Base directory for all persistent state (pool, sessions, accounts, media,
   *  sqlite). Docker mounts a named volume here. */
  dataDir: string
  /** Admin API / WebUI listen port. */
  port: number
  /** Bind address. Default 0.0.0.0 in Docker; set 127.0.0.1 when exposing
   *  via a reverse proxy on the same host. */
  host: string
  /** Comma-separated CIDR allowlist for /admin routes (empty = any). */
  adminAllowCidr: string
  /** Initial admin password. If unset on first boot, one is generated and
   *  printed ONCE to the log. Stored only as an argon2 hash afterwards. */
  adminPassword: string
  /** Comma-separated list of proxy IPs trusted for X-Forwarded-For resolution. */
  trustedProxies: string
  /** Static bearer key for /v1/* endpoints. Empty = auth disabled (a warning
   *  is logged at boot). Read from the environment only — never from the
   *  runtime-overrides file, so a plaintext key never rests on disk. The M3
   *  sha256 key store replaces this behind the same middleware. */
  apiKey: string
  /** SSE heartbeat interval in ms: when a streaming response stays silent
   *  longer than this, the writer emits a keepalive (`: ping` comment on the
   *  OpenAI leg, a `ping` event on the Anthropic leg) so reverse proxies and
   *  Cloudflare keep the connection alive. 0 disables the heartbeat. */
  sseHeartbeatMs: number
  /** SQLite database path (keys, usage ledger, admin sessions). Empty =
   *  <dataDir>/agy-proxy.db. Lives on the Docker volume by construction. */
  dbPath: string
  /** Admin session lifetime in ms (default 7 days). */
  adminSessionTtlMs: number
  /** Static WebUI directory override. Empty = auto-detect (env
   *  AGY_PROXY_WEB_DIST, then the entry's sibling web/dist, then cwd). */
  webDist: string
}

// Fallback line-up, mined from the agy 1.1.13 binary (inherited from
// dsh-agy-link). Serves the model list when `agy models` cannot run
// (signed out / offline); the live list always comes from agy once signed in.
export const DEFAULT_FALLBACK_MODELS: readonly FallbackModelDef[] = [
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

export function defaultConfig(): GatewayConfig {
  return {
    enabled: true,
    agyBin: '',
    extraArgs: [],
    permissionMode: 'plan',
    defaultModel: '',
    defaultEffort: '',
    timeoutMs: 600_000,
    maxConcurrent: 3,
    maxQueueDepth: 64,
    contextWindowDefault: 1_048_576,
    maxTokensDefault: 65_536,
    modelsCacheTtlMs: 300_000,
    mediaDir: '',
    mediaTtlMs: 86_400_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxImages: 8,
    workspaceRoot: '',
    fallbackModels: DEFAULT_FALLBACK_MODELS,
    rateLimitPerMinute: 0,
    autoFallbackModel: false,
    logRetentionDays: 7,
    quotaPollIntervalMs: 15 * 60_000,
    disableTelemetry: true,
    dataDir: '',
    port: 8080,
    host: '0.0.0.0',
    adminAllowCidr: '',
    adminPassword: '',
    trustedProxies: '',
    apiKey: '',
    sseHeartbeatMs: 60_000,
    dbPath: '',
    adminSessionTtlMs: 7 * 86_400_000,
    webDist: '',
  }
}

// Stable engine error codes surfaced as EngineError (inherited from the
// dsh-agy-link error table; protocol adapters map these onto OpenAI/Anthropic
// error bodies — see docs/charter.md §4.4).
export const Err = {
  AUTH: 'AUTH',
  AGY_NOT_INSTALLED: 'AGY_NOT_INSTALLED',
  AGY_VERSION_UNSUPPORTED: 'AGY_VERSION_UNSUPPORTED',
  AGY_ERROR: 'AGY_ERROR',
  TIMEOUT: 'TIMEOUT',
  PROCESS_EXIT: 'PROCESS_EXIT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  UNKNOWN_MODEL: 'UNKNOWN_MODEL',
  UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
  BUSY: 'BUSY',
  /** Every pool account is cooling down or quota-empty for the family → 429. */
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
  /** Upstream 403 re-validation (validation_url rides the message) → 403. */
  VALIDATION_REQUIRED: 'VALIDATION_REQUIRED',
} as const

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  total_tokens?: number
}

export type AgyStepKind =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'title'
  | 'subagent'
  | 'user-input'
  | 'unknown'

export interface AgyToolInfo {
  name: string
  /** Raw arguments: JSON string when agy serializes them, else object. */
  args?: unknown
  output?: unknown
  /** Tool-side failure text (agy 1.1.15: tool_info.error.message on state=ERROR). */
  error?: string
}

/** Normalized AgyEvent union consumed by the StreamChunk mapper (see parser).
 *  Shape aligns with upstream dsh-agy-link: each parsed variant carries the
 *  raw line object so the engine can inspect fields the normalized surface
 *  does not project (e.g. result.status=CANCELED for empty-run detection). */
export type AgyEvent = InitEvent | StepEvent | ResultEvent | GarbageEvent

export interface InitEvent {
  kind: 'init'
  conversationId?: string
  model?: string
  raw: unknown
}

export interface StepEvent {
  kind: 'step'
  stepKey: string
  stepKind: AgyStepKind
  text: string
  /** true when this step is a sequential fragment to append (text_delta). */
  fragment?: boolean
  tool?: AgyToolInfo
  /** Step lifecycle as reported by agy: ACTIVE / DONE / ERROR. */
  state?: string
  /** Per-step usage (agy ≥1.1.15 reports usage on agent_response steps). */
  usage?: RawUsage
  raw: unknown
}

export interface ResultEvent {
  kind: 'result'
  conversationId: string
  ok: boolean
  response: string
  error?: string
  usage: RawUsage
  raw: unknown
}

export interface GarbageEvent {
  kind: 'garbage'
  line: string
}

// Auth-failure sniffing shared by the runner tail, parser output and the
// result envelope (observed on agy 1.1.13: an authentication-required
// banner plus result.error text).
export function looksLikeAuthFailure(text: string): boolean {
  return /authentication required|authentication failed|please sign in|not signed in|timed out waiting for authentication/i.test(
    text,
  )
}

// Google OAuth consent URL pattern; trailing punctuation is trimmed.
export function extractAuthUrl(text: string): string | undefined {
  const m = text.match(/https:\/\/accounts\.google\.com\/\S+/)
  if (!m) return undefined
  return m[0].replace(/[)\]>.,;\x27\x22]+$/, '')
}

/**
 * HARD, server-issued rate-limit signatures — the ONLY patterns allowed to
 * put an account into cooldown. Deliberately narrow: bare `429` or
 * `rate limit` matched incidental substrings in the wild (hash/UUID
 * fragments, model prose mentioning quotas, unrelated tool/permission
 * errors quoting such words) and produced ghost cooldowns that froze
 * healthy accounts out of rotation.
 */
export function looksLikeHardRateLimit(text?: string): boolean {
  if (!text) return false
  return /RESOURCE_EXHAUSTED|code[ :]?429\b|status[ :]?429\b|HTTP[ :]?429\b|too many requests|individual quota reached|quota (?:exceeded|reached|exhausted)|rate[ -]?limit(?:ed)? (?:exceeded|reached|hit)|exceeded (?:your |the )?quota/i.test(
    text,
  )
}

/**
 * Soft heuristic adds capacity signals (model overloaded / high traffic).
 * Shapes the user-facing error message only — NEVER cools an account down.
 */
export function looksLikeRateLimit(text?: string): boolean {
  if (!text) return false
  return (
    looksLikeHardRateLimit(text) || /model overloaded|experiencing high traffic/i.test(text)
  )
}

/**
 * Google's 403 pre-launch / anti-abuse re-validation shape ("your account
 * requires additional verification"): the account cannot serve until the
 * user completes the challenge, so the gateway quarantines it (same
 * markAuthRequired path as an expired login) and surfaces validation_url.
 * Narrow match — never scrapes URLs out of unrelated failures.
 */
export function looksLikeValidationRequired(text?: string): boolean {
  return !!text && /VALIDATION_REQUIRED/i.test(text)
}

/** Extract the https challenge URL from a VALIDATION_REQUIRED failure text. */
export function extractValidationUrl(text?: string): string | undefined {
  if (text === undefined || !looksLikeValidationRequired(text)) return undefined
  const m = text.match(/https:\/\/[^\s"'`<>\\]+/)
  return m ? m[0].replace(/[)\]>.,;]+$/, '') : undefined
}

/**
 * Parse reset duration in milliseconds from rate-limit / quota-exhausted error strings.
 * Supports compact formats ("Resets in 21m25s", "Resets in 2h26m6s", "Resets in 45s"),
 * verbose formats ("Resets in 15 minutes", "retry after 30 seconds"), and ISO timestamps.
 */
export function parseResetDurationMs(text?: string): number | undefined {
  if (!text) return undefined

  // 1. Compact: "Resets in 2h26m6s", "resets in 21m25s", "resets in 45s"
  const compactMatch = text.match(/resets?\s+in\s+((?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?)/i)
  if (compactMatch && compactMatch[1]?.trim()) {
    const hours = parseInt(compactMatch[2] || '0', 10)
    const minutes = parseInt(compactMatch[3] || '0', 10)
    const seconds = parseInt(compactMatch[4] || '0', 10)
    const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000
    if (totalMs > 0) return totalMs
  }

  // 2. Word-based: "Resets in 15 minutes", "resets in 2 hours", "retry after 30 seconds"
  const wordMatch = text.match(/(?:resets?|retry)\s+(?:in|after)\s+(\d+)\s*(hour|hr|minute|min|second|sec)s?/i)
  if (wordMatch) {
    const num = parseInt(wordMatch[1]!, 10)
    const unit = wordMatch[2]!.toLowerCase()
    if (unit.startsWith('h')) return num * 3600 * 1000
    if (unit.startsWith('m')) return num * 60 * 1000
    if (unit.startsWith('s')) return num * 1000
  }

  // 3. ISO timestamp or future date string
  const isoMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0])
    if (!Number.isNaN(parsed) && parsed > Date.now()) {
      return parsed - Date.now()
    }
  }

  return undefined
}
