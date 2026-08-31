// Golden-case runner (acceptance.md §2): directory-driven across all three
// protocol surfaces. Each case under test/golden/<protocol>/<case>/ carries:
//   request.json   — either a raw POST body for /v1/chat/completions (legacy
//                    oa1 style) or {method,url,query,headers,body}
//   events.ndjson  — agy stream-json lines replayed verbatim through
//                    fake-agy's FAKE_AGY_EVENTS_FILE hook (empty file for
//                    cases that settle before a spawn)
//   expected.json  — normalized response: body fields for JSON cases (`_status`
//                    pins the HTTP status), `sse` frame array for streaming
//                    cases; `_provenance` is documentation and stripped
//   PROVENANCE.md  — source basis (acceptance §2 用例来源纪律)
// The runner drives the real HTTP route through the real engine + fake agy,
// normalizes dynamic fields (chatcmpl-/msg_ ids → __ID__, agytc- mirror ids →
// __AGYTC__, embedded UUID run ids → __UUID__, chat `created` epochs → 0) and
// compares FIELD BY FIELD with explicit mismatch paths (no snapshot tooling,
// per development.md §5). Heartbeats are off (sseHeartbeatMs: 0) so SSE frame
// streams are deterministic.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

type Json = { [k: string]: Json } | Json[] | string | number | boolean | null

interface CaseRequest {
  method?: string
  url?: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: unknown
}

interface CaseConfig {
  /** Static bearer key the server requires (error-matrix goldens). */
  apiKey?: string
  /** fake-agy replay exit code (upstream-failure goldens, e.g. oa8b). */
  fakeAgyExitCode?: number
  /** When present the catalog is force-refreshed from these raw models. */
  discoveredModels?: Array<{ id: string; display_name?: string }>
}

/** Field-walk diff with explicit mismatch paths (acceptance §2 字段级 diff). */
function diffFields(expected: Json, actual: Json, path: string, out: string[]): void {
  if (expected === null || typeof expected !== 'object' || actual === null || typeof actual !== 'object') {
    if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    return
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    const e = Array.isArray(expected) ? expected : [expected]
    const a = Array.isArray(actual) ? actual : [actual]
    if (e.length !== a.length) out.push(`${path}: array length ${e.length} !== ${a.length}`)
    for (let i = 0; i < Math.min(e.length, a.length); i++) diffFields(e[i] as Json, a[i] as Json, `${path}[${i}]`, out)
    return
  }
  const eo = expected as { [k: string]: Json }
  const ao = actual as { [k: string]: Json }
  for (const k of Object.keys(eo)) {
    if (!(k in ao)) out.push(`${path}.${k}: missing in actual`)
    else diffFields(eo[k] as Json, ao[k] as Json, `${path}.${k}`, out)
  }
  for (const k of Object.keys(ao)) {
    if (!(k in eo)) out.push(`${path}.${k}: unexpected in actual`)
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Replace dynamic values with sentinels. Id strings are matched by SHAPE so a
 * malformed id would fail the diff instead of being silently rewritten.
 * `zeroChatCreated` zeroes the OpenAI `created` epoch (Date.now()-based on
 * the chat surfaces); model listings pin MODEL_CREATED and are compared
 * literally.
 */
function normalizeJson(v: Json, zeroChatCreated: boolean): Json {
  if (typeof v === 'string') {
    if (/^chatcmpl-[A-Za-z0-9_-]{24}$/.test(v)) return '__ID__'
    if (/^msg_[A-Za-z0-9_-]{24}$/.test(v)) return '__ID__'
    if (/^agytc-[A-Za-z0-9_-]+$/.test(v)) return '__AGYTC__'
    if (UUID_RE.test(v)) return '__UUID__'
    return v
  }
  if (Array.isArray(v)) return v.map((x) => normalizeJson(x as Json, zeroChatCreated))
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const [k, val] of Object.entries(v)) {
      out[k] = zeroChatCreated && k === 'created' && typeof val === 'number' ? 0 : normalizeJson(val as Json, zeroChatCreated)
    }
    return out
  }
  return v
}

/** OpenAI SSE body → array of normalized data payloads ('[DONE]' kept as a string). */
function openAiFrames(body: string): Json[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b !== '')
    .map((b) => {
      const data = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      if (data === '[DONE]') return '[DONE]' as Json
      return normalizeJson(JSON.parse(data) as Json, true)
    })
}

/** Anthropic SSE body → normalized {event, data} pairs. */
function anthropicFrames(body: string): Json[] {
  return body
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b !== '')
    .map((b) => {
      const lines = b.split('\n')
      const event = (lines.find((l) => l.startsWith('event:')) ?? '').slice(6).trim()
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
      return { event, data: normalizeJson(JSON.parse(data) as Json, false) } as unknown as Json
    })
}

async function makeServer(caseCfg: CaseConfig): Promise<{ app: ReturnType<typeof buildServer>['app']; workDir: string }> {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, sseHeartbeatMs: 0 }
  const workDir = mkdtempSync(join(tmpdir(), 'agy-golden-'))
  cfg.mediaDir = join(workDir, 'media')
  if (caseCfg.apiKey !== undefined) cfg.apiKey = caseCfg.apiKey
  process.env.AGY_PROXY_DATA_DIR = workDir
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const catalog = new ModelCatalog(
    async () => ({ stdout: JSON.stringify(caseCfg.discoveredModels ?? []), stderr: '' }),
    cfg.fallbackModels,
    300_000,
  )
  if (caseCfg.discoveredModels !== undefined) await catalog.forceRefresh()
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(workDir, 'sessions.json')),
    bin: () => process.execPath,
    binArgs: [join(import.meta.dirname, 'fake-agy.mjs')],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
  })
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  return { app: built.app, workDir }
}

const GOLDEN_ROOT = join(import.meta.dirname, 'golden')
const PROTOCOLS = (['openai', 'anthropic', 'models'] as const).filter((p) => existsSync(join(GOLDEN_ROOT, p)))

for (const protocol of PROTOCOLS) {
  const cases = readdirSync(join(GOLDEN_ROOT, protocol), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  describe(`golden: ${protocol}`, () => {
    for (const name of cases) {
      it(`${name}: replay matches the expected ${protocol} response`, async () => {
        const caseDir = join(GOLDEN_ROOT, protocol, name)
        const request = JSON.parse(readFileSync(join(caseDir, 'request.json'), 'utf8')) as CaseRequest
        const caseCfg: CaseConfig = existsSync(join(caseDir, 'case.json'))
          ? (JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8')) as CaseConfig)
          : {}
        const provenance = readFileSync(join(caseDir, 'PROVENANCE.md'), 'utf8')
        // Source-basis discipline (acceptance §2): every case cites its docs.
        expect(provenance).toContain('http')
        const eventsPath = join(caseDir, 'events.ndjson')
        const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : ''
        const expected = JSON.parse(readFileSync(join(caseDir, 'expected.json'), 'utf8')) as Record<string, unknown>

        const isNewStyle = typeof request.url === 'string'
        const method = request.method ?? 'POST'
        const url0 = request.url ?? '/v1/chat/completions'
        const body: unknown = isNewStyle ? request.body : request

        const { app, workDir } = await makeServer(caseCfg)
        try {
          if (events.trim() !== '') {
            process.env.FAKE_AGY_EVENTS_FILE = eventsPath
            if (caseCfg.fakeAgyExitCode !== undefined) process.env.FAKE_AGY_EXIT_CODE = String(caseCfg.fakeAgyExitCode)
          }
          const qs = request.query !== undefined ? '?' + new URLSearchParams(request.query).toString() : ''
          const res = await app.inject({
            method,
            url: url0 + qs,
            headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(request.headers ?? {}) },
            ...(method === 'POST' ? { payload: body as object } : {}),
          })

          const isSse = String(res.headers['content-type'] ?? '').includes('text/event-stream')
          const diffs: string[] = []
          if (isSse) {
            expect(res.statusCode).toBe(200)
            const frames = url0.startsWith('/v1/messages') ? anthropicFrames(res.body) : openAiFrames(res.body)
            diffFields(expected.sse as unknown as Json, frames as unknown as Json, '$', diffs)
            if (diffs.length > 0) throw new Error('golden SSE diffs:\n' + diffs.join('\n'))
          } else {
            const expectedStatus = typeof expected._status === 'number' ? expected._status : 200
            expect(res.statusCode).toBe(expectedStatus)
            const actualRaw = res.body !== '' ? (JSON.parse(res.body) as unknown) : {}
            const actual = normalizeJson(actualRaw as Json, url0.startsWith('/v1/chat/completions'))
            const expectedBody: Record<string, unknown> = { ...expected }
            delete expectedBody._provenance
            delete expectedBody._status
            diffFields(expectedBody as unknown as Json, actual, '$', diffs)
            if (diffs.length > 0) throw new Error('golden field diffs:\n' + diffs.join('\n'))
          }
        } finally {
          delete process.env.FAKE_AGY_EVENTS_FILE
          delete process.env.FAKE_AGY_EXIT_CODE
          delete process.env.AGY_PROXY_DATA_DIR
          delete process.env.AGY_PROXY_CONVERSATIONS_DIR
          await app.close()
          rmSync(workDir, { recursive: true, force: true })
        }
      })
    }
  })
}
