// Batch-1 engine-hang hardening tests (A-H1 / A-M2 / A-L6):
//  - runner kill ladder: a SIGTERM-immune hung tree must still end the run
//    (escalation SIGTERM → killGraceMs → SIGKILL); before A-H1 the outcome
//    promise never resolved on POSIX and pinned the semaphore slot forever.
//  - onLine consumer guard (A-L6): a throwing line consumer lands in the
//    stderr tail instead of crashing the gateway from inside a stdout
//    'data' handler.
//  - pre-spawn aborts (A-M2): a client that aborts while parked in the
//    gateway semaphore queue — or queued behind another run on the same
//    pool account — must never spawn agy, must hand its slot/mark back,
//    and must leave the per-account queue drainable (no deadlock).
//
// Harness mirrors test/engine-retry.test.ts: node + fake-agy.mjs, mode via
// env / mode file, spawn count read from FAKE_AGY_ARGS_FILE.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyEngine, RETRY_POLICY, type EngineCall, type EngineDeps, type EngineMessage } from '../src/host/engine.ts'
import { startAgyProcess } from '../src/host/runner.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'
import type { StreamChunk } from '../src/host/stream-types.ts'
import { defaultConfig, Err, type GatewayConfig } from '../src/common/types.ts'

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
  pool?: AccountPoolManager
  setMode: (mode: string) => void
  spawns: () => number
  acquireCalls: () => number
  delays: number[]
  onRunCalls: OnRunInfo[]
}

interface HarnessOpts {
  cfgOverrides?: Partial<GatewayConfig>
  pool?: boolean
  sem?: GatewaySemaphore
  /** Resolved lazily at retry time so a drill can flip the fake's mode. */
  rescueMode?: () => string | undefined
}

function mk(opts: HarnessOpts = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ladder-'))
  dirs.push(dir)
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(dir, 'convs')
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 5_000, ...opts.cfgOverrides }

  const modeFile = join(dir, 'fake-mode')
  process.env.FAKE_AGY_MODE_FILE = modeFile
  const argsFile = join(dir, 'args.jsonl')
  process.env.FAKE_AGY_ARGS_FILE = argsFile
  const setMode = (mode: string): void => {
    writeFileSync(modeFile, mode + '\n')
  }
  setMode('ok')

  let pool: AccountPoolManager | undefined
  if (opts.pool === true) {
    // Temp baseDir is mandatory: the default reads the operator's real pool.
    pool = new AccountPoolManager(join(dir, 'pool'))
    pool.createAccountSlot('ladder-test account')
  }

  const acquireCalls = { n: 0 }
  const delays: number[] = []
  const onRunCalls: OnRunInfo[] = []
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog: new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000),
    store: new SessionStore(join(dir, 'sessions.json')),
    bin: () => process.execPath,
    binArgs: [fakeScript],
    ...(pool !== undefined ? { pool } : {}),
    acquire: () => {
      acquireCalls.n++
      return opts.sem !== undefined ? opts.sem.acquire() : Promise.resolve(() => {})
    },
    runs: new RunRegistry(),
    onRun: (i) => { onRunCalls.push(i) },
    retryDelay: async (ms) => {
      delays.push(ms)
      const rescue = opts.rescueMode?.()
      if (rescue !== undefined) setMode(rescue)
    },
  })

  const spawns = (): number => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0)
  return { engine, dir, pool, setMode, spawns, acquireCalls: () => acquireCalls.n, delays, onRunCalls }
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

/** Drive one logical turn hop-by-hop (a tool step cuts the span). */
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

describe('A-H1 runner kill ladder (hang-sigterm)', () => {
  it('a SIGTERM-immune hung tree still resolves the outcome inside grace + margin', async () => {
    // Watchdog fires at 400ms; the ladder escalates SIGTERM→SIGKILL after
    // killGraceMs=300 (POSIX). Before A-H1 this promise never resolved on
    // POSIX — the test's whole red state was that suspension.
    const run = startAgyProcess({
      bin: process.execPath,
      args: [fakeScript],
      timeoutMs: 400,
      killGraceMs: 300,
      env: { ...process.env, FAKE_AGY_MODE: 'hang-sigterm' },
    })
    const out = await run.outcome
    expect(out.timedOut).toBe(true)
    // 400 (watchdog) + 300 (grace) + 600 (final blow) + scheduler margin.
    expect(out.durationMs).toBeLessThan(2_500)
    if (process.platform === 'win32') {
      // taskkill /F: fatal immediately, no signal phase.
      expect(out.signal).toBeNull()
      expect(out.code).toBe(1)
    } else {
      // hang-sigterm ignores SIGTERM — only the ladder's SIGKILL can end it.
      expect(out.signal).toBe('SIGKILL')
    }
  })
})

describe('A-L6 onLine consumer guard', () => {
  it('a throwing line consumer lands in stderrTail instead of crashing the process', async () => {
    const run = startAgyProcess({
      bin: process.execPath,
      args: [fakeScript],
      timeoutMs: 10_000,
      env: { ...process.env, FAKE_AGY_MODE: 'ok' },
      onLine: () => {
        throw new Error('consumer bug')
      },
    })
    const out = await run.outcome
    // The child itself ran to completion (code 0); the consumer's throws were
    // parked, one per line, in the stderr tail where classification looks.
    expect(out.code).toBe(0)
    expect(out.stderrTail).toContain('[onLine]')
    expect(out.stderrTail).toContain('consumer bug')
  })
})

describe('A-M2 pre-spawn aborts', () => {
  it('abort while parked in the gateway semaphore queue: no spawn, slot handed back', async () => {
    const sem = new GatewaySemaphore(() => 1, () => 4)
    const h = mk({ sem, cfgOverrides: { timeoutMs: 5_000 } })
    // Occupy the only slot so the engine parks inside deps.acquire().
    const held = await sem.acquire()
    expect(sem.inFlight).toBe(1)

    const ctl = new AbortController()
    const pending = collect(h.engine.stream(call([msg('user', 'hi')], { signal: ctl.signal })))
    // Parked: acquire was requested and the semaphore holds one waiter.
    await vi.waitFor(() => expect(h.acquireCalls()).toBe(1), { timeout: 5_000, interval: 10 })
    await vi.waitFor(() => expect(sem.depth).toBe(1), { timeout: 5_000, interval: 10 })

    ctl.abort()
    held()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    // Nothing was consumed: no spawn, no onRun, and the transferred slot
    // went back through the post-acquire release.
    expect(h.spawns()).toBe(0)
    expect(h.onRunCalls).toHaveLength(0)
    expect(sem.inFlight).toBe(0)
  })

  it('abort while queued behind another run on the same account: no second spawn, queue stays live', async () => {
    const h = mk({ pool: true, cfgOverrides: { timeoutMs: 30_000 } })
    h.setMode('hang')

    // s1 holds the single account's serial queue with a run that never ends
    // on its own (mode 'hang'; killed by our abort below, not the watchdog).
    const ctl1 = new AbortController()
    const p1 = collect(h.engine.stream(call([msg('user', 's1')], { signal: ctl1.signal })))
    await vi.waitFor(() => expect(h.spawns()).toBe(1), { timeout: 10_000, interval: 10 })

    // s2 selects the same (busy-filtered fallthrough) account and parks in
    // its PQueue behind s1's spawn→outcome window.
    const ctl2 = new AbortController()
    const p2 = collect(h.engine.stream(call([msg('user', 's2')], { signal: ctl2.signal })))
    await new Promise((r) => setTimeout(r, 200))
    expect(h.spawns()).toBe(1) // s2 did not spawn while queued

    // Abort s2 first (the queue-head check must see it), then kill s1 so the
    // queue frees and s2's task actually starts.
    ctl2.abort()
    ctl1.abort()
    const [c1, c2] = await Promise.all([p1, p2])

    expect(finishOf(c1).reason.kind).toBe('aborted')
    const f2 = finishOf(c2)
    expect(f2.reason.kind).toBe('aborted')
    expect(f2.reason.failure?.code).toBe('ABORTED')
    expect(h.spawns()).toBe(1)

    // No deadlock: the account queue still serves the next request.
    h.setMode('ok')
    const c3 = await collectTurn(h, [msg('user', 's3')])
    expect(finishOf(c3.tail).reason.kind).toBe('stop')
    expect(textOf(c3.all)).toContain('Hello from fake agy')
    expect(h.spawns()).toBe(2)
  })
})

describe('A-H1 engine-level rescue of a hung run', () => {
  it('a SIGTERM-immune hang times out, is killed by the ladder, and the retry serves the turn', async () => {
    const h = mk({ rescueMode: () => 'ok', cfgOverrides: { timeoutMs: 500 } })
    h.setMode('hang-sigterm')

    const { all, tail } = await collectTurn(h, [msg('user', 'hi')])
    // Attempt 0 hung with zero output; the watchdog + ladder ended it and the
    // single dispatch-level retry served a normal run.
    expect(h.spawns()).toBe(2)
    const finish = finishOf(tail)
    expect(finish.reason.kind).toBe('stop')
    expect(textOf(all)).toContain('Hello from fake agy')
    expect(JSON.stringify(all)).not.toContain('TIMEOUT')

    await vi.waitFor(() => {
      expect(h.onRunCalls).toHaveLength(2)
      expect(h.onRunCalls[1]).toMatchObject({ attempt: 1, final: true, ok: true, code: 'OK' })
    }, { timeout: 15_000, interval: 10 })
    expect(h.onRunCalls[0]).toMatchObject({ attempt: 0, final: false, ok: false, code: Err.TIMEOUT })
    expect(h.delays).toEqual([RETRY_POLICY.initialDelayMs])
  })
})