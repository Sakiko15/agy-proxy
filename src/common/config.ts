// Config resolution for agy-proxy: env (AGY_PROXY_*) > runtime overrides file
// > defaults. Ported from dsh-agy-link src/common/config.ts @ 46984db
// (modified: env prefix DSH_AGY_* → AGY_PROXY_*; cordis entry-config layer
// removed — the gateway has no host config; dataDir/base paths re-rooted;
// AGY_PROXY_API_KEY added, environment-only by design).
// The overrides file backs admin-UI hot changes and survives restarts; env is
// read per call so a changed process environment is honored without reload.
import { defaultConfig, type GatewayConfig, type PermissionMode } from './types.ts'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OverridesFile { [key: string]: unknown }

/** Root for all persistent state. Docker mounts a named volume here. */
export function dataDir(): string {
  return process.env.AGY_PROXY_DATA_DIR ?? join(homedir(), '.agy-proxy')
}

export function stateDir(): string {
  return join(dataDir(), 'gateway')
}

export function overridesPath(): string {
  return join(stateDir(), 'runtime-overrides.json')
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readOverrides(file = overridesPath()): OverridesFile {
  return readJson(file)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  // Same truthy set as settings.ts's copy — 'false'/'0' must parse as false
  // or AGY_PROXY_ENABLED=false silently keeps the gateway enabled (S-M1).
  if (typeof v === 'string') return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined
  return undefined
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

const MODES: readonly PermissionMode[] = ['skip', 'plan', 'accept-edits']

function asMode(v: unknown): PermissionMode | undefined {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
    ? (v as PermissionMode)
    : undefined
}

/** Layered config read; cheap enough to call per request (thunk pattern). */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: OverridesFile = readOverrides(),
): GatewayConfig {
  const base = defaultConfig()
  const get = (k: string): unknown => {
    if (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '') return overrides[k]
    return undefined
  }
  const cfg: GatewayConfig = {
    ...base,
    enabled: asBool(get('enabled')) ?? base.enabled,
    agyBin: asString(get('agyBin')) ?? base.agyBin,
    extraArgs: Array.isArray(get('extraArgs'))
      ? (get('extraArgs') as unknown[]).filter((x): x is string => typeof x === 'string')
      : base.extraArgs,
    permissionMode: asMode(get('permissionMode')) ?? base.permissionMode,
    defaultModel: asString(get('defaultModel')) ?? base.defaultModel,
    defaultEffort: asString(get('defaultEffort')) ?? base.defaultEffort,
    timeoutMs: asNum(get('timeoutMs')) ?? base.timeoutMs,
    maxConcurrent: asNum(get('maxConcurrent')) ?? base.maxConcurrent,
    maxQueueDepth: asNum(get('maxQueueDepth')) ?? base.maxQueueDepth,
    contextWindowDefault: asNum(get('contextWindowDefault')) ?? base.contextWindowDefault,
    maxTokensDefault: asNum(get('maxTokensDefault')) ?? base.maxTokensDefault,
    modelsCacheTtlMs: asNum(get('modelsCacheTtlMs')) ?? base.modelsCacheTtlMs,
    mediaDir: asString(get('mediaDir')) ?? base.mediaDir,
    mediaTtlMs: asNum(get('mediaTtlMs')) ?? base.mediaTtlMs,
    mediaMaxBytes: asNum(get('mediaMaxBytes')) ?? base.mediaMaxBytes,
    mediaMaxImages: asNum(get('mediaMaxImages')) ?? base.mediaMaxImages,
    workspaceRoot: asString(get('workspaceRoot')) ?? base.workspaceRoot,
    fallbackModels: Array.isArray(get('fallbackModels'))
      ? (get('fallbackModels') as unknown[]).filter(
          (x): x is GatewayConfig['fallbackModels'][number] =>
            !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string',
        )
      : base.fallbackModels,
    rateLimitPerMinute: asNum(get('rateLimitPerMinute')) ?? base.rateLimitPerMinute,
    autoFallbackModel: asBool(get('autoFallbackModel')) ?? base.autoFallbackModel,
    logRetentionDays: asNum(get('logRetentionDays')) ?? base.logRetentionDays,
    quotaPollIntervalMs: asNum(get('quotaPollIntervalMs')) ?? base.quotaPollIntervalMs,
    disableTelemetry: asBool(get('disableTelemetry')) ?? base.disableTelemetry,
    dataDir: asString(get('dataDir')) ?? base.dataDir,
    port: asNum(get('port')) ?? base.port,
    host: asString(get('host')) ?? base.host,
    adminAllowCidr: asString(get('adminAllowCidr')) ?? base.adminAllowCidr,
    adminPassword: asString(get('adminPassword')) ?? base.adminPassword,
    trustedProxies: asString(get('trustedProxies')) ?? base.trustedProxies,
    dbPath: asString(get('dbPath')) ?? base.dbPath,
    adminSessionTtlMs: asNum(get('adminSessionTtlMs')) ?? base.adminSessionTtlMs,
    webDist: asString(get('webDist')) ?? base.webDist,
  }
  // Env wins last.
  if (env.AGY_PROXY_ENABLED !== undefined) cfg.enabled = asBool(env.AGY_PROXY_ENABLED) ?? cfg.enabled
  if (env.AGY_PROXY_BIN) cfg.agyBin = env.AGY_PROXY_BIN
  if (env.AGY_PROXY_MODE) {
    const m = asMode(env.AGY_PROXY_MODE)
    if (m) cfg.permissionMode = m
  }
  if (env.AGY_PROXY_SKIP_PERMISSIONS !== undefined) {
    const skip = asBool(env.AGY_PROXY_SKIP_PERMISSIONS)
    if (skip !== undefined) cfg.permissionMode = skip ? 'skip' : 'plan'
  }
  if (env.AGY_PROXY_DEFAULT_MODEL) cfg.defaultModel = env.AGY_PROXY_DEFAULT_MODEL
  if (env.AGY_PROXY_DEFAULT_EFFORT) cfg.defaultEffort = env.AGY_PROXY_DEFAULT_EFFORT
  if (env.AGY_PROXY_TIMEOUT_MS) {
    const t = asNum(env.AGY_PROXY_TIMEOUT_MS)
    if (t && t > 0) cfg.timeoutMs = t
  }
  if (env.AGY_PROXY_EXTRA_ARGS) {
    cfg.extraArgs = env.AGY_PROXY_EXTRA_ARGS.split(/\s+/).filter(Boolean)
  }
  if (env.AGY_PROXY_MAX_CONCURRENT !== undefined) {
    const c = asNum(env.AGY_PROXY_MAX_CONCURRENT)
    // README documents this var; out-of-range values are ignored (not
    // clamped) so the layering predicate in settings.ts mirrors exactly.
    if (c !== undefined && c >= 1) cfg.maxConcurrent = c
  }
  if (env.AGY_PROXY_MAX_QUEUE_DEPTH !== undefined) {
    const q = asNum(env.AGY_PROXY_MAX_QUEUE_DEPTH)
    if (q !== undefined && q >= 0) cfg.maxQueueDepth = q
  }
  if (env.AGY_PROXY_WORKSPACE_ROOT) cfg.workspaceRoot = env.AGY_PROXY_WORKSPACE_ROOT
  if (env.AGY_PROXY_MEDIA_DIR) cfg.mediaDir = env.AGY_PROXY_MEDIA_DIR
  if (env.AGY_PROXY_MEDIA_TTL_MS) {
    const t = asNum(env.AGY_PROXY_MEDIA_TTL_MS)
    if (t && t > 0) cfg.mediaTtlMs = t
  }
  if (env.AGY_PROXY_RATE_LIMIT_PER_MINUTE) {
    const r = asNum(env.AGY_PROXY_RATE_LIMIT_PER_MINUTE)
    if (r !== undefined && r >= 0) cfg.rateLimitPerMinute = r
  }
  if (env.AGY_PROXY_AUTO_FALLBACK_MODEL !== undefined) {
    const af = asBool(env.AGY_PROXY_AUTO_FALLBACK_MODEL)
    if (af !== undefined) cfg.autoFallbackModel = af
  }
  if (env.AGY_PROXY_LOG_RETENTION_DAYS) {
    const l = asNum(env.AGY_PROXY_LOG_RETENTION_DAYS)
    if (l && l > 0) cfg.logRetentionDays = l
  }
  if (env.AGY_PROXY_QUOTA_POLL_INTERVAL_MS) {
    const q = asNum(env.AGY_PROXY_QUOTA_POLL_INTERVAL_MS)
    if (q && q >= 60_000) cfg.quotaPollIntervalMs = q
  }
  if (env.AGY_PROXY_DATA_DIR) cfg.dataDir = env.AGY_PROXY_DATA_DIR
  if (env.AGY_PROXY_PORT) {
    const p = asNum(env.AGY_PROXY_PORT)
    if (p && p > 0 && p < 65_536) cfg.port = p
  }
  if (env.AGY_PROXY_HOST) cfg.host = env.AGY_PROXY_HOST
  if (env.AGY_PROXY_ADMIN_ALLOW_CIDR) cfg.adminAllowCidr = env.AGY_PROXY_ADMIN_ALLOW_CIDR
  if (env.AGY_PROXY_ADMIN_PASSWORD) cfg.adminPassword = env.AGY_PROXY_ADMIN_PASSWORD
  if (env.AGY_PROXY_TRUSTED_PROXIES) cfg.trustedProxies = env.AGY_PROXY_TRUSTED_PROXIES
  if (env.AGY_PROXY_DB_PATH) cfg.dbPath = env.AGY_PROXY_DB_PATH
  if (env.AGY_PROXY_ADMIN_SESSION_TTL_MS) {
    const t = asNum(env.AGY_PROXY_ADMIN_SESSION_TTL_MS)
    if (t && t >= 60_000) cfg.adminSessionTtlMs = t
  }
  if (env.AGY_PROXY_WEB_DIST) cfg.webDist = env.AGY_PROXY_WEB_DIST
  if (env.AGY_PROXY_DEBUG_METRICS_MS) {
    const d = asNum(env.AGY_PROXY_DEBUG_METRICS_MS)
    if (d !== undefined && d >= 0) cfg.debugMetricsMs = d
  }
  // Static API key: environment-only (never the overrides file) so a
  // plaintext key cannot rest on disk. An explicitly-set empty string
  // disables auth, distinct from leaving it unset.
  if (env.AGY_PROXY_API_KEY !== undefined) cfg.apiKey = env.AGY_PROXY_API_KEY
  if (env.AGY_PROXY_SSE_HEARTBEAT_MS !== undefined) {
    const v = Number(env.AGY_PROXY_SSE_HEARTBEAT_MS)
    if (Number.isFinite(v) && v >= 0) cfg.sseHeartbeatMs = v
  }
  // Floors after layering (S-M4'): the overrides file and env are both
  // clamped here because a hand-edited maxConcurrent: 0 once bricked the
  // gateway — every semaphore acquire saw an exhausted cap and 429'd
  // forever. maxQueueDepth 0 stays legal (reject overflow at once).
  cfg.maxConcurrent = Math.max(1, cfg.maxConcurrent)
  cfg.maxQueueDepth = Math.max(0, cfg.maxQueueDepth)
  return cfg
}
