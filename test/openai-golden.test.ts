// Golden-case runner (acceptance.md §2): replays the recorded agy event
// sequence through fake-agy's FAKE_AGY_EVENTS_FILE hook, drives the real
// HTTP route, normalizes the dynamic fields (id → __ID__ sentinel, created →
// 0) and compares the response body FIELD BY FIELD against expected.json,
// printing field-level diffs on mismatch (no snapshot tooling, per
// development.md §5).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const caseDir = join(import.meta.dirname, 'golden', 'openai', 'oa1-basic')

type Json = { [k: string]: Json } | Json[] | string | number | boolean | null

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

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const workDir = mkdtempSync(join(tmpdir(), 'agy-golden-'))
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(workDir, 'sessions.json')),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    ...deps,
  })
  const built = buildServer({ getConfig: () => cfg, engine, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  return { built, workDir }
}

afterEach(() => {
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_AGY_EVENTS_FILE
})

describe('golden: OA1 basic non-streaming', () => {
  it('replayed events produce the exact expected completion body', async () => {
    const request = JSON.parse(readFileSync(join(caseDir, 'request.json'), 'utf8')) as Record<string, unknown>
    const expected = JSON.parse(readFileSync(join(caseDir, 'expected.json'), 'utf8')) as Record<string, unknown>
    const provenance = readFileSync(join(caseDir, 'PROVENANCE.md'), 'utf8')
    expect(provenance).toContain('platform.openai.com/docs/api-reference/chat/object')
    const { built, workDir } = makeServer()
    process.env.FAKE_AGY_EVENTS_FILE = join(caseDir, 'events.ndjson')

    const res = await built.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: request as object,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    const actual = res.json() as Record<string, unknown>

    // Normalize dynamic fields.
    expect(typeof actual.id).toBe('string')
    expect(actual.id).toMatch(/^chatcmpl-[A-Za-z0-9_-]{24}$/)
    actual.id = '__ID__'
    expect(typeof actual.created).toBe('number')
    expect((actual.created as number) <= Math.floor(Date.now() / 1000) + 5).toBe(true)
    actual.created = 0

    // The provenance key is documentation, not an expected field.
    delete expected._provenance

    const diffs: string[] = []
    diffFields(expected as unknown as Json, actual as unknown as Json, '$', diffs)
    if (diffs.length > 0) throw new Error('golden field diffs:\n' + diffs.join('\n'))
    await built.app.close()
    rmSync(workDir, { recursive: true, force: true })
  })
})
