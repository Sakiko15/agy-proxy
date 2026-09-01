// Hand-written mirrors of the admin API payload shapes (src/server/*).
// Keep these in lockstep with the server; the admin suites pin the shapes.
// Never exposed: key hashes, session tokens, OAuth material (charter §10).

export interface UsageSummary {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface FamilyCooldownState {
  cooldownUntil: number
  reason: string
  consecutiveFailures: number
}

export interface ModelQuotaInfo {
  modelId: string
  displayName?: string
  remainingFraction?: number
  resetTime?: string
}

export interface FamilyQuotaInfo {
  remainingFraction?: number // 0..1, 5h window
  resetTime?: string
  weeklyFraction?: number
  weeklyResetTime?: string
  description?: string
  updatedAt?: number
  models?: ModelQuotaInfo[]
}

export interface ManagedAccount {
  id: string
  alias: string
  email?: string
  dir: string
  proxyUrl?: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  authRequired?: boolean
  authError?: string
  cooldowns: Partial<Record<string, FamilyCooldownState>>
  quotas: Partial<Record<string, FamilyQuotaInfo>>
}

export interface AccountPoolData {
  version: 1
  mode: 'sequential' | 'round-robin'
  defaultCooldownMs: number
  maxCooldownMs: number
  activeAccountIds?: Partial<Record<string, string>>
  accounts: ManagedAccount[]
}

export interface PoolAuthStatus {
  phase: 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed'
  stagingId?: string
  alias?: string
  url?: string
  mode?: 'auto' | 'manual'
  browserOpened?: boolean
  message?: string
  ok: boolean
}

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  createdAt: number
  disabledAt: number | null
  dailyTokenLimit: number
  rpmLimit: number
  scopes: string | null
  lastUsedAt: number | null
}

export interface ApiKeyWithToday extends ApiKeyRecord {
  tokensToday: number
}

export interface UsageRow {
  seq: number
  requestId: string
  keyId: string | null
  accountId: string | null
  model: string
  family: string
  protocol: 'openai' | 'anthropic'
  promptTokens: number
  completionTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  totalTokens: number
  status: string
  durationMs?: number
  /** Terminal failure text (schema v2 error_text) — present on failed rows. */
  errorText?: string
  createdAt: number
}

export interface AdminStatus {
  gateway: {
    enabled: boolean
    permissionMode: 'skip' | 'plan' | 'accept-edits'
    maxConcurrent: number
    maxQueueDepth: number
  }
  pool: {
    mode: 'sequential' | 'round-robin'
    accounts: Array<{
      id: string
      alias: string
      email: string | null
      enabled: boolean
      lastUsedAt: number | null
      authRequired: boolean | null
      cooldowns: Partial<Record<string, FamilyCooldownState>>
      quotas: Partial<Record<string, FamilyQuotaInfo>>
    }>
  }
  poolAuth: PoolAuthStatus
  catalog: { source: string; count: number }
  keys: { count: number }
  usage: { today: UsageSummary }
}

export interface SettingsView {
  requested: Partial<Record<string, unknown>>
  effective: Record<string, unknown>
  envLocked: string[]
}

export interface RunEventPayload {
  ok: boolean
  status: string
  durationMs: number
  model: string
  family?: string
  conversationId?: string
  accountId: string | null
  keyId: string | null
  protocol: 'openai' | 'anthropic'
  reqId: string
  usage: {
    promptTokens: number
    completionTokens: number
    reasoningTokens?: number
    cacheReadTokens?: number
  } | null
}

export interface AdminEvent {
  type: 'snapshot' | 'run' | 'pool'
  seq: number
  at: number
  pool?: AccountPoolData
  run?: RunEventPayload
}