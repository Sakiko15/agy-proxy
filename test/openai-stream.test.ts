// OpenAI streaming (OA2–OA4): SSE frames through the REAL AgyEngine wired to
// fake-agy. Covers the OA2 chunk anatomy, OA3 reasoning_content ordering, OA4
// tool_calls streaming + agytc- continuation without a new spawn, the
// heartbeat drill (fake-agy `slow` mode), and error-terminal SSE payloads.
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

let lastWorkDir: string | null = null

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const workDir = mkdtempSync(join(tmpdir(), 'agy-stream-'))
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const argsFile = join(workDir, 'args-' + Math.random().toString(36).slice(2) + '.json')
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
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  lastWorkDir = workDir
  return { built, argsFile, workDir, cfg }
}

interface Frame { data: string }

/** Split an SSE wire body into data-frame payloads (comments excluded).
 *  The [DONE] sentinel frame stays as the raw string '[DONE]'. */
function parseSse(body: string): Array<{ data: string; json: Record<string, unknown> | null }> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => {
      const dataLines = block.split('\n').filter((l) => l.startsWith('data:'))
      const data = dataLines.map((l) => l.slice(5).trim()).join('')
      let json: Record<string, unknown> | null = null
      if (data !== '' && data !== '[DONE]') {
        try {
          json = JSON.parse(data) as Record<string, unknown>
        } catch {
          json = null
        }
      }
      return { data, json }
    })
    .filter((f) => f.data !== '')
}

/** JSON frames of one SSE body, narrowed to the Oa3 chunk shape. */
function oa3Frames(body: string): Oa3Frame[] {
  return parseSse(body)
    .map((f) => f.json)
    .filter((j): j is Record<string, unknown> => j !== null)
    .map((j) => j as unknown as Oa3Frame)
}

function post(built: ReturnType<typeof makeServer>['built'], payload: unknown) {
  return built.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: payload as object,
    headers: { 'content-type': 'application/json' },
  })
}

const BASE = { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'hi' }] }

/** Narrowed chunk shape used by the OA3 assertions. */
interface Oa3Frame {
  choices: Array<{
    delta: { reasoning_content?: string; content?: string; tool_calls?: Array<{ id: string }> }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    prompt_tokens_details: { cached_tokens: number }
    completion_tokens_details: { reasoning_tokens: number }
  }
}

afterEach(() => {
  delete process.env.FAKE_AGY_MODE
  delete process.env.FAKE_AGY_ARGS_FILE
  delete process.env.FAKE_AGY_SILENCE_MS
  delete process.env.AGY_PROXY_SSE_HEARTBEAT_MS
})

describe('OA2: streaming basics', () => {
  it('first chunk carries delta:{role,content:""}; ids stay constant; [DONE] closes', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')

    const frames = parseSse(res.body)
    const payloads = frames.map((f) => f.json as Record<string, unknown>)
    // First frame: role announcement.
    const first = payloads[0] as { choices: Array<{ delta: Record<string, unknown> }> }
    expect(first.choices[0]?.delta).toEqual({ role: 'assistant', content: '' })
    // Every frame: same id, chunk object type, model echo.
    const jsons = payloads.filter((p) => p !== null)
    const ids = new Set(jsons.map((p) => p.id))
    expect(ids.size).toBe(1)
    expect(jsons.every((p) => p.object === 'chat.completion.chunk')).toBe(true)
    expect(jsons.every((p) => p.model === 'gemini-3.7-flash')).toBe(true)
    // No usage frames without include_usage.
    expect(jsons.some((p) => Array.isArray(p.choices) && (p.choices as unknown[]).length === 0)).toBe(false)
    // Terminal frame is the [DONE] sentinel (data-only frame).
    expect(frames[frames.length - 1]?.data).toBe('[DONE]')
    await built.app.close()
    rmSync(lastWorkDir ?? '', { recursive: true, force: true })
  })

  it('include_usage adds the choices:[] usage frame before [DONE]', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true, stream_options: { include_usage: true } })
    const frames = parseSse(res.body)
    const jsons = frames.map((f) => f.json as Record<string, unknown>).filter((p) => p !== null)
    const usageFrame = jsons.find((p) => Array.isArray(p.choices) && (p.choices as unknown[]).length === 0)
    expect(usageFrame).toBeTruthy()
    const usage = usageFrame?.usage as { prompt_tokens: number; completion_tokens: number }
    expect(typeof usage.prompt_tokens).toBe('number')
    // Usage frame comes after the finish frame, before [DONE].
    const finishIdx = jsons.findIndex((p) => Array.isArray(p.choices) && (p.choices as Array<{ finish_reason?: string }>).length > 0 && (p.choices as Array<{ finish_reason?: string }>)[0]!.finish_reason !== null)
    const usageIdx = jsons.indexOf(usageFrame as Record<string, unknown>)
    expect(usageIdx).toBeGreaterThan(finishIdx)
    await built.app.close()
  })
})

/** Unwrap helper: makeServer records the workDir in lastWorkDir for cleanup. */

describe('OA3: reasoning_content ordering', () => {
  it('reasoning deltas precede content; continuation carries cached/reasoning usage', async () => {
    process.env.FAKE_AGY_MODE = 'real'
    const { built } = makeServer()
    // Hop 1 (span cut by the mirror tool step): reasoning annotation streams,
    // then the tool_calls finish.
    const res1 = await post(built, { ...BASE, stream: true, stream_options: { include_usage: true } })
    const live1 = oa3Frames(res1.body)
    const reasoningIdx = live1.findIndex((p) => typeof p.choices[0]?.delta.reasoning_content === 'string')
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(live1.find((p) => p.choices[0]?.finish_reason === 'tool_calls')).toBeTruthy()
    const tc = live1.find((p) => p.choices[0]?.delta.tool_calls !== undefined)?.choices[0]?.delta.tool_calls?.[0]?.id
    expect(tc).toMatch(/^agytc-/)
    // Usage at a tool cut is the 0/0 placeholder — real per-call samples ride
    // the hop that reaches the result envelope.
    const usage1 = live1.find((p) => Array.isArray(p.choices) && p.choices.length === 0)?.usage
    expect(usage1?.prompt_tokens).toBe(0)

    // Hop 2 (continuation): the failed find_by_name step cuts a SECOND
    // tool-calls span (usage 0/0 by design at tool cuts), so hop 3 replays it
    // too and finally reaches the streamed answer; the final usage frame
    // carries the cached/reasoning token details (OA3).
    const res2 = await post(built, {
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'replayed', tool_call_id: tc },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
    const live2 = oa3Frames(res2.body)
    const tc2 = live2.find((p) => p.choices[0]?.delta.tool_calls !== undefined)?.choices[0]?.delta.tool_calls?.[0]?.id
    expect(tc2).toMatch(/^agytc-/)

    const res3 = await post(built, {
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'replayed', tool_call_id: tc },
        { role: 'tool', content: 'replayed', tool_call_id: tc2 },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
    const live3 = oa3Frames(res3.body)
    const contentIdx = live3.findIndex((p) => typeof p.choices[0]?.delta.content === 'string')
    expect(contentIdx).toBeGreaterThanOrEqual(0)
    const usageFrame = live3.find((p) => Array.isArray(p.choices) && p.choices.length === 0)
    const u = usageFrame?.usage
    expect(u?.prompt_tokens_details.cached_tokens).toBeGreaterThan(0)
    expect(u?.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0)
    await built.app.close()
  })
})

describe('OA4: tool_calls streaming + continuation without re-spawn', () => {
  it('delta.tool_calls frames carry stable ids; tool-result replay continues in-stream with no new process', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built, argsFile } = makeServer()
    process.env.FAKE_AGY_ARGS_FILE = argsFile

    // Hop 1: the mirror cut.
    const res1 = await post(built, { ...BASE, stream: true })
    const payloads1 = parseSse(res1.body).map((f) => f.json).filter((p): p is NonNullable<typeof p> => p !== null) as unknown as Array<{
      choices: Array<{ delta: { tool_calls?: Array<{ index: number; id: string; function?: { name: string; arguments: string } }> }; finish_reason: string | null }>
    }>
    const tcFrame = payloads1.find((p) => p.choices[0]?.delta.tool_calls !== undefined)
    const tc = tcFrame?.choices[0]?.delta.tool_calls?.[0]
    expect(tc?.id).toMatch(/^agytc-/)
    expect(tc?.function?.name).toBe('agy_tool')
    // arguments must be a parseable JSON string (OA4).
    const parsed = JSON.parse(tc?.function?.arguments ?? '{}') as { run: string; step: number }
    expect(typeof parsed.run).toBe('string')
    const finish1 = payloads1.find((p) => p.choices[0]?.finish_reason !== null)
    expect(finish1?.choices[0]?.finish_reason).toBe('tool_calls')

    const spawnCountBefore = readFileSync(argsFile, 'utf8').trim().split('\n').length

    // Hop 2: continuation carries the tool result; the SAME run resumes with
    // no new agy process (engine continuation path, OA4 游标复用).
    const res2 = await post(built, {
      ...BASE,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'replayed', tool_call_id: tc?.id },
      ],
      stream: true,
    })
    const frames2 = parseSse(res2.body)
    expect(frames2.length).toBeGreaterThan(0)
    expect(frames2[frames2.length - 1]?.data).toBe('[DONE]')

    const spawnCountAfter = readFileSync(argsFile, 'utf8').trim().split('\n').length
    expect(spawnCountAfter).toBe(spawnCountBefore) // no new spawn
    await built.app.close()
    rmSync(lastWorkDir ?? '', { recursive: true, force: true })
  })
})

describe('SSE heartbeat (charter §6)', () => {
  it('silent stretch longer than the interval emits `: ping` comments', async () => {
    process.env.FAKE_AGY_MODE = 'slow'
    process.env.FAKE_AGY_SILENCE_MS = '500'
    const { built } = makeServer({ sseHeartbeatMs: 150 })
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(': ping')
    // The stream still completes normally.
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true)
    await built.app.close()
  })

  it('no pings when events flow faster than the interval', async () => {
    process.env.FAKE_AGY_MODE = 'ok'
    const { built } = makeServer({ sseHeartbeatMs: 60_000 })
    const res = await post(built, { ...BASE, stream: true })
    expect(res.body).not.toContain(': ping')
    await built.app.close()
  })
})

describe('error terminals in-stream', () => {
  it('upstream failure surfaces as an error payload + [DONE] inside SSE', async () => {
    process.env.FAKE_AGY_MODE = 'exit-error'
    const { built } = makeServer()
    const res = await post(built, { ...BASE, stream: true })
    expect(res.statusCode).toBe(200) // stream already opened
    const payloads = parseSse(res.body).map((f) => f.json).filter((p): p is NonNullable<typeof p> => p !== null)
    const errFrame = payloads.find((p) => (p as { error?: { code?: string } }).error !== undefined) as { error: { message: string; type: string; code: string } } | undefined
    expect(errFrame?.error.code).toBe('PROCESS_EXIT')
    expect(errFrame?.error.message).toContain('upstream request failed while generating') // real agy text
    await built.app.close()
  })
})
