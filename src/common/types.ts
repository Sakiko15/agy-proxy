// Shared vocabulary for agy-proxy: gateway config, stable error codes, and
// the normalized event stream produced by the stream-json parser.
// Ported from dsh-agy-link src/common/types.ts @ 46984db (modified: gateway
// config surface replaces plugin config; DSH-specific fields removed; new
// gateway fields added for keys/ledger/admin).

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
} as const

// Raw usage object as emitted by agy stream-json (snake_case).
export interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

/** Normalized AgyEvent union consumed by the StreamChunk mapper (see parser). */
export type AgyEvent = InitEvent | StepEvent | ResultEvent | GarbageEvent

export interface InitEvent {
  kind: 'init'
  conversationId?: string
  model?: string
  cwd?: string
  tools?: readonly string[]
  permissionMode?: string
  jsonSchema?: string
}

export type StepKind = 'text' | 'thinking' | 'tool' | 'title' | 'subagent' | 'user-input' | 'unknown'

export interface AgyToolInfo {
  name?: string
  parameters?: unknown
  output?: string
  error?: string
}

export interface StepEvent {
  kind: 'step'
  /** Monotonic index within the run; the continuation cursor. */
  eventIndex: number
  stepKey: string
  stepKind: StepKind
  text?: string
  /** true when this step is a delta fragment of the previous step. */
  fragment?: boolean
  tool?: AgyToolInfo
  state?: string
  usage?: RawUsage
  conversationId?: string
}

export interface ResultEvent {
  kind: 'result'
  conversationId: string
  ok: boolean
  response?: string
  error?: string
  /** Structured output payload when --json-schema was passed. */
  structuredOutput?: unknown
  usage?: RawUsage
  durationSeconds?: number
  numTurns?: number
}

export interface GarbageEvent {
  kind: 'garbage'
  line: string
}
