// Settings write path (M4, charter §9 page 6): the runtime-overrides.json
// writer behind the WebUI settings page. The file has been read-layered by
// resolveConfig() since M0 (env > overrides > defaults, re-read per call) but
// had no writer — this module adds one behind the same guard chain as every
// other admin route. Design rules:
//   - allowlist only: apiKey/adminPassword are charter red lines (env-only /
//     argon2 path), and a bad write to boot-critical keys (host/port/dbPath/
//     adminAllowCidr/…) could lock the operator out of the admin surface;
//   - clamps mirror the resolveConfig() env rules line-for-line so a UI write
//     and an env set behave identically;
//   - env-owned keys are REPORTED (envLocked), not rejected: the file still
//     stores the requested value (it becomes effective the day the env var is
//     removed), while a hard 400 would silently block rotation workflows;
//   - unknown pre-existing keys in the overrides file are preserved verbatim.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  overridesPath,
  readOverrides,
  resolveConfig,
  type OverridesFile,
} from '../common/config.ts'
import type { GatewayConfig, PermissionMode } from '../common/types.ts'

/** The settings the WebUI may write. Everything else is rejected. */
export const WRITABLE_KEYS = [
  'defaultModel',
  'defaultEffort',
  'timeoutMs',
  'maxConcurrent',
  'maxQueueDepth',
  'permissionMode',
  'enabled',
  'autoFallbackModel',
  'quotaPollIntervalMs',
] as const

export type WritableKey = (typeof WRITABLE_KEYS)[number]

const MODES: readonly PermissionMode[] = ['skip', 'plan', 'accept-edits']
const MAX_STRING_LENGTH = 200

/**
 * Which env vars own which setting, and whether they currently win over the
 * overrides file. The `wins` predicates mirror resolveConfig()'s env block
 * expression for expression — including the truthy vs `!== undefined`
 * asymmetry (AGY_PROXY_ENABLED/AUTO_FALLBACK_MODEL react to a *set* variable
 * even when its value is "false", while the plain string keys require a
 * non-empty value) — so envLocked reporting can never contradict resolveConfig.
 */
const ENV_OWNERS: Readonly<Record<WritableKey, { wins: (env: NodeJS.ProcessEnv) => boolean }>> = {
  defaultModel: { wins: (e) => !!e.AGY_PROXY_DEFAULT_MODEL },
  defaultEffort: { wins: (e) => !!e.AGY_PROXY_DEFAULT_EFFORT },
  timeoutMs: { wins: (e) => { const t = asNum(e.AGY_PROXY_TIMEOUT_MS); return t !== undefined && t > 0 } },
  // The clamps themselves live in resolveConfig's post-layering floors; an
  // out-of-range env value is ignored, so the wins predicates check the same
  // ranges rather than mere presence.
  maxConcurrent: { wins: (e) => { const c = asNum(e.AGY_PROXY_MAX_CONCURRENT); return c !== undefined && c >= 1 } },
  maxQueueDepth: { wins: (e) => { const q = asNum(e.AGY_PROXY_MAX_QUEUE_DEPTH); return q !== undefined && q >= 0 } },
  permissionMode: {
    wins: (e) => {
      if (!!e.AGY_PROXY_MODE) return asMode(e.AGY_PROXY_MODE) !== undefined
      return e.AGY_PROXY_SKIP_PERMISSIONS !== undefined && asBool(e.AGY_PROXY_SKIP_PERMISSIONS) !== undefined
    },
  },
  enabled: { wins: (e) => e.AGY_PROXY_ENABLED !== undefined && asBool(e.AGY_PROXY_ENABLED) !== undefined },
  autoFallbackModel: { wins: (e) => e.AGY_PROXY_AUTO_FALLBACK_MODEL !== undefined && asBool(e.AGY_PROXY_AUTO_FALLBACK_MODEL) !== undefined },
  quotaPollIntervalMs: { wins: (e) => { const q = asNum(e.AGY_PROXY_QUOTA_POLL_INTERVAL_MS); return q !== undefined && q >= 60_000 } },
}

/** Keys whose effective value currently comes from the environment, not the
 *  overrides file (resolveConfig still honours env last, per call). */
export function envLockedKeys(env: NodeJS.ProcessEnv = process.env): WritableKey[] {
  return WRITABLE_KEYS.filter((key) => ENV_OWNERS[key].wins(env))
}

const MODE_VALUES: ReadonlySet<string> = new Set(MODES)

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined
  return undefined
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function asMode(v: unknown): PermissionMode | undefined {
  return typeof v === 'string' && MODE_VALUES.has(v) ? (v as PermissionMode) : undefined
}

/**
 * Validate a settings PUT body into an overrides-file patch. Returns every
 * problem, not just the first (batch forms), and never mutates the file.
 */
export function sanitizeSettings(input: Record<string, unknown>): { ok: true; patch: OverridesFile } | { ok: false; error: string } {
  const errors: string[] = []
  const patch: OverridesFile = {}
  for (const [rawKey, value] of Object.entries(input)) {
    if (!(WRITABLE_KEYS as readonly string[]).includes(rawKey)) {
      errors.push(`unknown setting '${rawKey}'`)
      continue
    }
    const key = rawKey as WritableKey
    switch (key) {
      case 'defaultModel':
      case 'defaultEffort': {
        if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
          errors.push(`'${key}' must be a string of at most ${MAX_STRING_LENGTH} chars`)
          continue
        }
        patch[key] = value // '' = clear the override (resolveConfig skips empty values)
        break
      }
      case 'timeoutMs': {
        const n = asNum(value)
        if (n === undefined || n <= 0) {
          errors.push(`'${key}' must be a positive number of milliseconds`)
          continue
        }
        patch[key] = n
        break
      }
      case 'maxConcurrent': {
        const n = asNum(value)
        if (n === undefined || n < 1) {
          errors.push(`'${key}' must be a number >= 1`)
          continue
        }
        patch[key] = n
        break
      }
      case 'maxQueueDepth': {
        const n = asNum(value)
        if (n === undefined || n < 0) {
          errors.push(`'${key}' must be a number >= 0`)
          continue
        }
        patch[key] = n
        break
      }
      case 'quotaPollIntervalMs': {
        const n = asNum(value)
        if (n === undefined || n < 60_000) {
          errors.push(`'${key}' must be a number >= 60000 (clamped floor in config)`)
          continue
        }
        patch[key] = n
        break
      }
      case 'permissionMode': {
        const m = asMode(value)
        if (m === undefined) {
          errors.push(`'${key}' must be one of: ${MODES.join(', ')}`)
          continue
        }
        patch[key] = m
        break
      }
      case 'enabled':
      case 'autoFallbackModel': {
        if (typeof value !== 'boolean') {
          errors.push(`'${key}' must be a boolean`)
          continue
        }
        patch[key] = value
        break
      }
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') }
  return { ok: true, patch }
}

/**
 * Merge a validated patch into runtime-overrides.json atomically (tmp +
 * rename, the pool.json/sessions.json pattern). Unknown keys already in the
 * file (hand-edited, or future admin surface) survive untouched.
 */
export function writeOverridesPatch(patch: OverridesFile, file: string = overridesPath()): void {
  if (Object.keys(patch).length === 0) return
  const merged: OverridesFile = { ...readOverrides(file), ...patch }
  const tmp = `${file}.tmp`
  mkdirSync(dirname(tmp), { recursive: true })
  try {
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    // A failed write/rename must not strand the .tmp residue next to the real
    // overrides file (M5 hardening); drop it best-effort and rethrow — the
    // caller surfaces the failure to the operator, the file was never touched.
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
}

export interface SettingsView {
  /** Raw values currently stored in the overrides file (writable keys only). */
  requested: Partial<Record<WritableKey, unknown>>
  /** The values resolveConfig() will actually serve for writable keys. */
  effective: Record<WritableKey, unknown>
  /** Writable keys whose effective value currently comes from the env. */
  envLocked: WritableKey[]
}

/** Effective-subset projection of resolveConfig for the settings UI. */
export function settingsView(env: NodeJS.ProcessEnv = process.env, file: string = overridesPath()): SettingsView {
  const overrides = readOverrides(file)
  const cfg: GatewayConfig = resolveConfig(env, overrides)
  const requested: Partial<Record<WritableKey, unknown>> = {}
  for (const key of WRITABLE_KEYS) {
    if (overrides[key] !== undefined) requested[key] = overrides[key]
  }
  const effective: SettingsView['effective'] = {
    defaultModel: cfg.defaultModel,
    defaultEffort: cfg.defaultEffort,
    timeoutMs: cfg.timeoutMs,
    maxConcurrent: cfg.maxConcurrent,
    maxQueueDepth: cfg.maxQueueDepth,
    permissionMode: cfg.permissionMode,
    enabled: cfg.enabled,
    autoFallbackModel: cfg.autoFallbackModel,
    quotaPollIntervalMs: cfg.quotaPollIntervalMs,
  }
  return { requested, effective, envLocked: envLockedKeys(env) }
}