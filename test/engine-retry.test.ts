// Engine-level single retry (M5): retryable failure classes (TIMEOUT /
// PROCESS_EXIT / INVALID_OUTPUT) get exactly one dispatch-level retry; a
// failure frame may only reach the client after retries are exhausted, and
// only when no client-visible output ever shipped. The retryDelay seam is
// injected everywhere: the requested delay is captured (never slept) so the
// suite stays fast, and it doubles as the hook that flips the fake-agy mode
// file between attempts — file-based mode flipping is also what the soak
// harness drives.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyEngine, computeRetryDelayMs, RETRY_POLICY, type EngineCall, type EngineDeps, type EngineMessage } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import type { StreamChunk } from '../src/host/stream-types.ts'
import { defaultConfig, Err, type GatewayConfig } from '../src/common/types.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const dirs: string[] = []
const ENV_KEYS = ['FAKE_AGY_MODE', 'FAKE_AGY_MODE_FILE', 'FAKE_AGY_ARGS_FILE', 'FAKE_AGY_EVENTS_FILE', 'FAKE_AGY_EXIT_CODE'] as const

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* fake-agy child */ }
  }
  for (const key of ENV_KEYS) delete process.env[key]
})

type OnRunInfo = Parameters<NonNullable<EngineDeps['onRun']>>[0]

interface Harness {
  engine: AgyEngine
  dir: string
  setMode: (mode: string) => void
  spawns: () => number
  onRunCalls: OnRunInfo[]
  delays: number[]
}

/** Engine wired to the mode-file fake: the retry seam flips the mode file when
 *  rescueMode is set; delays are recorded, never slept. */
function mk(opts: { rescueMode?: string; cfgOverrides?: Partial<GatewayConfig> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agy-retry-'))
  dirs.push(dir)
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(dir, 'convs')
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 5_000, ...opts.cfgOverrides }

  // Wire the env hooks BEFORE any spawn; the mode file is read per process.
  const modeFile = join(dir, 'fake-mode')
  process.env.FAKE_AGY_MODE_FILE = modeFile
  const argsFile = join(dir, 'args.jsonl')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const setMode = (mode: string): void => {
    writeFileSync(modeFile, mode + '\n')
  }
  setMode('ok')

  const onRunCalls: OnRunInfo[] = []
  const delays: number[] = []
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog: new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000),
    store: new SessionStore(join(dir, 'sessions.json')),
    bin: () => process.execPath,
    binArgs: [fakeScript],
    acquire: () => Promise.resolve(() => {}),
    runs: new RunRegistry(),
    onRun: (i) => { onRunCalls.push(i) },
    retryDelay: async (ms) => {
      delays.push(ms)
      if (opts.rescueMode !== undefined) setMode(opts.rescueMode)
    },
  })

  const spawns = (): number => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0)
  return { engine, dir, setMode, spawns, onRunCalls, delays }
}

function msg(role: 'user' | 'assistant', text: string): EngineMessage {
  return { role, text }
}

function call(messages: EngineMessage[], extra: Partial<EngineCall> = {}): EngineCall {
  return { model: 'gemini-3.7-flash', messages, ...extra }
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

function finishOf(chunks: StreamChunk[]): { type: string; reason: { kind: string; failure?: { code: string; message: string } } } {
  const last = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
  if (last === undefined || last.type !== 'finish') throw new Error('stream ended without a finish chunk')
  return last
}

function textOf(chunks: StreamChunk[]): string {
  return (chunks.filter((c) => c.type === 'text-delta') as Array<{ text: string }>).map((c) => c.text).join('')
}

/**
 * Drive one logical turn the way the gateway loop would: a completed agy tool
 * step cuts the span with finish:tool-calls; append the mirrored tool result
 * and continue until a terminal finish. (The fake 'ok' run streams a tool
 * step, so a single collect() would only pull the first span.)
 */
async function collectTurn(h: { engine: AgyEngine }, base: EngineMessage[]): Promise<{ all: StreamChunk[]; tail: StreamChunk[] }> {
  const messages = [...base]
  const all: StreamChunk[] = []
  for (let hop = 0; hop < 12; hop++) {
    const chunks = await collect(h.engine.stream(call([...messages])))
    all.push(...chunks)
    const finish = finishOf(chunks)
    if (finish.reason.kind !== 'tool-calls') return { all, tail: chunks }
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
    ) as unknown as { block: { id: string } } | undefined
    if (end === undefined) throw new Error('tool-calls finish without a tool-call block')
    messages.push({ role: 'tool', toolCallId: end.block.id, text: 'mirrored tool output' })
  }
  throw new Error('too many hops')
}

describe('engine-level single retry', () => {
  it('exit-error is rescued by the retry: two spawns, one seamless success span', async () => {
    const h = mk({ rescueMode: 'ok' })
    h.setMode('exit-error')
    const { all, tail } = await collectTurn(h, [msg('user', 'hi')])
    expect(h.spawns()).toBe(2)
    const finish = finishOf(tail)
    expect(finish.reason.kind).toBe('stop')
    expect(textOf(all)).toContain('Hello from fake agy')
    // No failure fragments anywhere in the client stream.
    expect(JSON.stringify(all)).not.toContain('PROCESS_EXIT')
    // onRun fires at classify time, which lags the mapper's finish for a
    // successful attempt — wait for the settle to land.
    await vi.waitFor(() => {
      expect(h.onRunCalls).toHaveLength(2)
      expect(h.onRunCalls[1]).toMatchObject({ attempt: 1, final: true, ok: true, code: 'OK' })
    }, { timeout: 5_000, interval: 10 })
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: false, ok: false })
    expect(h.onRunCalls[0]?.failureMessage).toContain('upstream request failed while generating')
    // The delay seam asked for the policy delay and never slept the suite.
    expect(h.delays).toEqual([RETRY_POLICY.initialDelayMs])
  })

  it('an exhaustible failure settles its own PROCESS_EXIT after the retry', async () => {
    const h = mk() // no rescue — the mode file stays exit-error
    h.setMode('exit-error')
    const chunks = await collect(h.engine.stream(call([msg('user', 'fail me')])))
    expect(h.spawns()).toBe(2)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.PROCESS_EXIT)
    expect(finish.reason.failure?.message).toContain('agy exited with code 1')
    expect(finish.reason.failure?.message).toContain('upstream request failed while generating')
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: false, ok: false })
    expect(h.onRunCalls[1]).toMatchObject({ attempt: 1, final: true, ok: false })
  })

  it('kill-early is rescued (silent spawn death, then a normal run)', async () => {
    const h = mk({ rescueMode: 'ok' })
    h.setMode('kill-early')
    const { all, tail } = await collectTurn(h, [msg('user', 'hi')])
    expect(h.spawns()).toBe(2)
    const finish = finishOf(tail)
    expect(finish.reason.kind).toBe('stop')
    expect(textOf(all)).toContain('Hello from fake agy')
    await vi.waitFor(() => {
      expect(h.onRunCalls).toHaveLength(2)
      expect(h.onRunCalls[1]).toMatchObject({ attempt: 1, final: true, ok: true })
    }, { timeout: 5_000, interval: 10 })
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: false, ok: false })
  })

  it('kill-mid never replays: partial output ends the run after ONE spawn', async () => {
    const h = mk()
    h.setMode('kill-mid')
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(1)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.PROCESS_EXIT)
    // Partial text reached the client before the death — no hidden retry.
    expect(textOf(chunks)).toContain('partial answer')
    // win32 documents code 1 (TerminateProcess), POSIX a SIGKILL signal.
    if (process.platform === 'win32') {
      expect(finish.reason.failure?.message).toContain('agy exited with code 1')
    } else {
      expect(finish.reason.failure?.message).toContain('terminated (signal SIGKILL)')
    }
    expect(h.onRunCalls).toHaveLength(1)
    expect(h.onRunCalls[0]?.final).toBe(true)
    expect(h.delays).toEqual([])
  })

  it('a spawn failure inside the loop is retried like any PROCESS_EXIT (deps.bin re-read)', async () => {
    const h = mk()
    let binTarget = '/nonexistent/agy-binary-respawn'
    const engine = new AgyEngine({
      getConfig: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 5_000 }),
      catalog: new ModelCatalog(async () => { throw new Error('x') }, defaultConfig().fallbackModels, 300_000),
      store: new SessionStore(join(h.dir, 'sessions-respawn.json')),
      bin: () => binTarget,
      binArgs: [fakeScript],
      acquire: () => Promise.resolve(() => {}),
      runs: new RunRegistry(),
      onRun: (i) => { h.onRunCalls.push(i) },
      retryDelay: async (ms) => {
        h.delays.push(ms) // keep the seam honest
        binTarget = process.execPath // the retry finds a good binary
      },
    })
    const chunks = await collect(engine.stream(call([msg('user', 'hi')])))
    // The rescued attempt serves the fake 'ok' run; the span cuts on its
    // tool step, so the terminal chunk of THIS stream is the cut, but it must
    // not be an error.
    const finish = finishOf(chunks)
    expect(finish.reason.kind).not.toBe('error')
    await vi.waitFor(() => {
      expect(h.onRunCalls).toHaveLength(2)
      expect(h.onRunCalls[1]).toMatchObject({ attempt: 1, final: true, ok: true })
    }, { timeout: 5_000, interval: 10 })
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: false, ok: false })
    expect(h.onRunCalls[0]?.failureMessage).toContain('failed to spawn agy')
  })

  it('AUTH failures never retry — even with a rescue mode armed', async () => {
    const h = mk({ rescueMode: 'ok' })
    h.setMode('auth')
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(1)
    expect(finishOf(chunks).reason.failure?.code).toBe(Err.AUTH)
    expect(h.delays).toEqual([]) // the retry seam was never consulted
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: true, ok: false, code: Err.AUTH })
  })

  it('hard rate limits never retry', async () => {
    const h = mk({ rescueMode: 'ok' })
    h.setMode('rate-limit')
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(1)
    expect(finishOf(chunks).reason.failure?.code).toBe(Err.AGY_ERROR)
    expect(h.delays).toEqual([])
    expect(h.onRunCalls[0]?.final).toBe(true)
  })

  it('VALIDATION_REQUIRED never retries and keeps the challenge URL', async () => {
    const h = mk({ rescueMode: 'ok' })
    h.setMode('validation')
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(1)
    const finish = finishOf(chunks)
    expect(finish.reason.failure?.code).toBe(Err.VALIDATION_REQUIRED)
    expect(finish.reason.failure?.message).toContain('https://accounts.google.com/')
    expect(h.onRunCalls[0]?.final).toBe(true)
  })

  it('a caller abort never retries', async () => {
    const h = mk()
    h.setMode('hang')
    const controller = new AbortController()
    const run = (async () => {
      for await (const _ of h.engine.stream(call([msg('user', 'hi')], { signal: controller.signal }))) {
        // drain
      }
    })()
    // Wait for the spawn, then abort; no retry tail may follow.
    await new Promise((r) => setTimeout(r, 120))
    controller.abort()
    await run
    expect(h.spawns()).toBe(1)
    expect(h.delays).toEqual([])
  })

  it('the #902 CANCELED-empty shape never retries behind the served client', async () => {
    // The CANCELED envelope parses ok (status !== ERROR), so the mapper ships
    // a success finish before the engine classifies; the engine-side
    // settlement is the INVALID_OUTPUT failure (accounting + no retry) — a
    // hidden retry would double-run a turn the client already saw served.
    const h = mk()
    const eventsFile = join(h.dir, 'events.ndjson')
    appendFileSync(eventsFile, JSON.stringify({ event: 'init', conversation_id: 'c-x', model: 'gemini' }) + '\n')
    appendFileSync(eventsFile, JSON.stringify({ event: 'result', result: { conversation_id: 'c-x', status: 'CANCELED', response: '', usage: { input_tokens: 3, output_tokens: 0 } } }) + '\n')
    process.env.FAKE_AGY_EVENTS_FILE = eventsFile
    process.env.FAKE_AGY_EXIT_CODE = '0'
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(1)
    expect(h.delays).toEqual([])
    expect(finishOf(chunks).reason.kind).toBe('stop')
    await vi.waitFor(() => {
      expect(h.onRunCalls).toHaveLength(1)
      expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: true, ok: false, code: Err.INVALID_OUTPUT })
    }, { timeout: 5_000, interval: 10 })
  })

  it('TIMEOUT on a hung run retries once, then surfaces the TIMEOUT', async () => {
    const h = mk({ cfgOverrides: { timeoutMs: 700 } }) // fast watchdog on both attempts
    h.setMode('hang')
    const chunks = await collect(h.engine.stream(call([msg('user', 'hi')])))
    expect(h.spawns()).toBe(2)
    expect(h.delays).toEqual([RETRY_POLICY.initialDelayMs])
    const finish = finishOf(chunks)
    expect(finish.reason.failure?.code).toBe(Err.TIMEOUT)
    expect(finish.reason.kind).toBe('error')
  })
})

describe('computeRetryDelayMs (pure backoff math)', () => {
  it('jitters ±10% around the base and respects the ceiling', () => {
    expect(computeRetryDelayMs(2_000, () => 0)).toBe(1_800)
    expect(computeRetryDelayMs(2_000, () => 1)).toBe(2_200)
    expect(computeRetryDelayMs(2_000, () => 0.5)).toBe(2_000)
    expect(computeRetryDelayMs(50_000, () => 1)).toBe(RETRY_POLICY.maxDelayMs)
    expect(computeRetryDelayMs(50_000, () => 0)).toBe(RETRY_POLICY.maxDelayMs)
  })
})