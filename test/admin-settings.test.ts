// Settings write path (M4): GET/PUT /admin/settings against the real
// runtime-overrides.json writer with a temp AGY_PROXY_DATA_DIR. Covers the
// allowlist, the clamp matrix, env-shadow reporting (envLocked, including the
// set-but-unparseable asymmetry), human-key preservation, and the atomic
// write contract (no .tmp residue, no writes on validation failure).
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/common/config.ts'
import { writeOverridesPatch } from '../src/server/settings.ts'
import { makeAdminServer, login, adminGet } from './helpers.admin.ts'

const dataDirs: string[] = []

const ENV_KEYS = [
  'AGY_PROXY_DATA_DIR',
  'AGY_PROXY_DEFAULT_MODEL',
  'AGY_PROXY_DEFAULT_EFFORT',
  'AGY_PROXY_TIMEOUT_MS',
  'AGY_PROXY_QUOTA_POLL_INTERVAL_MS',
  'AGY_PROXY_ENABLED',
  'AGY_PROXY_AUTO_FALLBACK_MODEL',
  'AGY_PROXY_MODE',
  'AGY_PROXY_SKIP_PERMISSIONS',
] as const

afterEach(() => {
  for (const dir of dataDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* handles */ } }
  for (const key of ENV_KEYS) delete process.env[key]
})

function useTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-settings-'))
  dataDirs.push(dir)
  process.env.AGY_PROXY_DATA_DIR = dir
  return dir
}

function overridesFile(dataDir: string): string {
  return join(dataDir, 'gateway', 'runtime-overrides.json')
}

function settingsPut(built: ReturnType<typeof makeAdminServer>['built'], cookie: string, payload: Record<string, unknown>) {
  return built.app.inject({
    method: 'PUT', url: '/admin/settings', payload,
    headers: { 'content-type': 'application/json', cookie, 'x-requested-with': 'test' },
  })
}

describe('GET /admin/settings', () => {
  it('guard + view shape: requested/effective/envLocked', async () => {
    useTempDataDir()
    const { built } = makeAdminServer()
    const noAuth = await built.app.inject({ method: 'GET', url: '/admin/settings' })
    expect(noAuth.statusCode).toBe(401)

    const { cookie } = await login(built)
    const res = await built.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; requested: Record<string, unknown>; effective: Record<string, unknown>; envLocked: string[] }
    expect(body.ok).toBe(true)
    expect(body.requested).toEqual({})
    expect(body.effective).toMatchObject({ permissionMode: 'plan', enabled: true, timeoutMs: 600_000 })
    expect(body.envLocked).toEqual([])
  })

  it('reflects an existing overrides file value; preserves human keys on later writes', async () => {
    const dir = useTempDataDir()
    mkdirSync(join(dir, 'gateway'), { recursive: true })
    writeFileSync(overridesFile(dir), JSON.stringify({ timeoutMs: 123_456, unknownHumanKey: 'keep-me' }))
    const { built } = makeAdminServer()
    const { cookie } = await login(built)

    const res = await built.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    const body = res.json() as { requested: Record<string, unknown>; effective: Record<string, unknown> }
    expect(body.requested).toEqual({ timeoutMs: 123_456 })
    expect(body.effective.timeoutMs).toBe(123_456)

    const put = await settingsPut(built, cookie, { defaultModel: 'gemini-3.7-pro' })
    expect(put.statusCode).toBe(200)
    const stored = JSON.parse(readFileSync(overridesFile(dir), 'utf8')) as Record<string, unknown>
    expect(stored.defaultModel).toBe('gemini-3.7-pro')
    expect(stored.unknownHumanKey).toBe('keep-me') // hand-edited keys survive
    expect(stored.timeoutMs).toBe(123_456)
  })
})

describe('PUT /admin/settings', () => {
  it('writes valid keys; resolveConfig reflects them on the next call; no .tmp residue', async () => {
    const dir = useTempDataDir()
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const res = await settingsPut(built, cookie, { defaultModel: 'gemini-3.7-pro', timeoutMs: 30_000 })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; effective: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.effective.defaultModel).toBe('gemini-3.7-pro')
    expect(body.effective.timeoutMs).toBe(30_000)
    expect(resolveConfig().defaultModel).toBe('gemini-3.7-pro')
    expect(existsSync(overridesFile(dir) + '.tmp')).toBe(false)
  })

  it('empty body is a validated no-op (no file written)', async () => {
    const dir = useTempDataDir()
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const res = await settingsPut(built, cookie, {})
    expect(res.statusCode).toBe(200)
    expect(existsSync(overridesFile(dir))).toBe(false)
  })

  it('rejects unknown/forbidden keys; nothing written; response leaks no secret', async () => {
    const dir = useTempDataDir()
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const res = await settingsPut(built, cookie, { apiKey: 'sk-agy-bad', adminPassword: 'x', host: '0.0.0.0' })
    expect(res.statusCode).toBe(400)
    expect(res.body).not.toContain('sk-agy-')
    expect((res.json() as { ok: boolean }).ok).toBe(false)
    expect(existsSync(overridesFile(dir))).toBe(false)

    const res2 = await settingsPut(built, cookie, { noSuchKey: 1 })
    expect(res2.statusCode).toBe(400)
    expect((res2.json() as { error: string }).error).toContain("unknown setting 'noSuchKey'")
  })

  it('clamp matrix mirrors the config env rules; boundaries accept', async () => {
    useTempDataDir()
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    expect((await settingsPut(built, cookie, { timeoutMs: 0 })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { timeoutMs: -5 })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { maxConcurrent: 0 })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { maxQueueDepth: -1 })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { quotaPollIntervalMs: 1000 })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { permissionMode: 'yolo' })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { enabled: 'yes' })).statusCode).toBe(400)
    expect((await settingsPut(built, cookie, { defaultModel: 42 })).statusCode).toBe(400)
    const ok = await settingsPut(built, cookie, { quotaPollIntervalMs: 60_000, maxQueueDepth: 0, maxConcurrent: 1, timeoutMs: 1 })
    expect(ok.statusCode).toBe(200)
  })

  it('env wins: value stored, effective differs, envLocked reported', async () => {
    useTempDataDir()
    process.env.AGY_PROXY_DEFAULT_MODEL = 'from-env-model'
    process.env.AGY_PROXY_ENABLED = 'false' // set-but-false still owns the key
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    const res = await settingsPut(built, cookie, { defaultModel: 'from-ui', enabled: true })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { requested: Record<string, unknown>; effective: Record<string, unknown>; envLocked: string[] }
    expect(body.requested.defaultModel).toBe('from-ui') // stored for the day the env var is removed
    expect(body.effective.defaultModel).toBe('from-env-model')
    expect(body.envLocked).toContain('defaultModel')
    expect(body.envLocked).toContain('enabled')
  })

  it('set-but-unparseable env does NOT lock boolean/mode keys (asymmetry pinned)', async () => {
    useTempDataDir()
    const { built } = makeAdminServer()
    const { cookie } = await login(built)
    process.env.AGY_PROXY_AUTO_FALLBACK_MODEL = 'banana'
    const res = await built.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    expect((res.json() as { envLocked: string[] }).envLocked).not.toContain('autoFallbackModel')
    process.env.AGY_PROXY_MODE = 'bogus'
    const res2 = await built.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })
    expect((res2.json() as { envLocked: string[] }).envLocked).not.toContain('permissionMode')
  })
})

describe('writeOverridesPatch failure cleanup', () => {
  it('a failed write/rename does not strand the .tmp residue and rethrows', () => {
    // The rename target pre-exists as a directory: writeFileSync(tmp) succeeds,
    // renameSync(tmp → file) fails on every platform (EISDIR/EPERM) — the real
    // error path the guard exists for, no mocks.
    const dir = mkdtempSync(join(tmpdir(), 'agy-settings-fail-'))
    dataDirs.push(dir)
    const file = join(dir, 'gateway')
    mkdirSync(file)
    expect(() => writeOverridesPatch({ timeoutMs: 1000 }, file)).toThrow()
    expect(existsSync(file + '.tmp')).toBe(false)
    expect(existsSync(join(dir, 'gateway.tmp'))).toBe(false)
  })
})