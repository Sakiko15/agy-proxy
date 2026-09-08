// S1 dispatch-guard nets (B1): the detached dispatch IIFE inside
// AgyEngine.stream must be escape-proof — a throw inside the bookkeeping
// seams (the onRun hook, the semaphore slot release) degrades to a logged,
// client-bounded PROCESS_EXIT terminal error instead of rejecting the
// detached IIFE, which Node turns into a process-killing unhandled rejection
// (bypassing ledger flush + SSE teardown). The EventMapper-construction
// branch of the pump guard (S1b) is not deterministically reachable through
// public seams (sawTextBefore and the tolerant parser cannot be made to
// throw from outside); its unconditional queue.close() in the finally is what
// every other engine test exercises.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyEngine, type EngineCall, type EngineDeps, type EngineMessage } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
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

function mk(deps: Partial<EngineDeps> = {}): AgyEngine {
  const dir = mkdtempSync(join(tmpdir(), 'agy-guards-'))
  dirs.push(dir)
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(dir, 'convs')
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000 }
  return new AgyEngine({
    getConfig: () => cfg,
    catalog: new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000),
    store: new SessionStore(join(dir, 'sessions.json')),
    bin: () => process.execPath,
    binArgs: [fakeScript],
    acquire: () => Promise.resolve(() => {}),
    runs: new RunRegistry(),
    retryDelay: async () => {}, // the guard fires on the first fireRun — retries never start
    ...deps,
  })
}

function call(messages: EngineMessage[]): EngineCall {
  return { model: 'gemini-3.7-flash', messages }
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

type FinishChunk = { type: string; reason: { kind: string; failure?: { message: string; code: string } } }

describe('S1a: the dispatch guard is escape-proof', () => {
  it('a throwing onRun hook settles the run as a bounded PROCESS_EXIT error the client can see', async () => {
    // exit12: zero stdout events + non-zero exit — a retryable PROCESS_EXIT
    // outcome whose FIRST fireRun throws before any retry machinery runs.
    process.env.FAKE_AGY_MODE = 'exit12'
    const engine = mk({ onRun: () => { throw new Error('boom-onrun') } })
    const chunks = await collect(engine.stream(call([{ role: 'user', text: 'hi' }])))
    // The settle-after-dispatch-error fallback: zero usage, then a terminal
    // error finish carrying the hook's message — never a hang, never a crash.
    const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } } | undefined
    expect(usage).toBeDefined()
    expect(usage?.usage.inputTokens).toBe(0)
    expect(usage?.usage.outputTokens).toBe(0)
    const finish = chunks.at(-1) as FinishChunk | undefined
    expect(finish?.type).toBe('finish')
    expect(finish?.reason.kind).toBe('error')
    expect(finish?.reason.failure?.code).toBe(Err.PROCESS_EXIT)
    expect(finish?.reason.failure?.message).toContain('boom-onrun')
  })

  it('a throwing onRun + a throwing slot release both stay inside the guard', async () => {
    // Both faults at once: the catch's releaseOnce() re-throws (the idempotent
    // flag was never set — the throw came from fireRun, not a prior release),
    // which pre-S1a escaped the detached IIFE as an unhandled rejection.
    // Post-S1a it is logged and the settle still lands the bounded error.
    process.env.FAKE_AGY_MODE = 'exit12'
    const logs: string[] = []
    const engine = mk({
      onRun: () => { throw new Error('boom-onrun') },
      acquire: async () => () => { throw new Error('release-boom') },
      log: (m) => logs.push(m),
    })
    const chunks = await collect(engine.stream(call([{ role: 'user', text: 'hi' }])))
    const finish = chunks.at(-1) as FinishChunk | undefined
    expect(finish?.type).toBe('finish')
    expect(finish?.reason.kind).toBe('error')
    expect(finish?.reason.failure?.code).toBe(Err.PROCESS_EXIT)
    // The client sees the primary dispatch error; the release fault is a
    // secondary hygiene failure — logged, never allowed to mask or escape.
    expect(finish?.reason.failure?.message).toContain('boom-onrun')
    expect(logs.some((m) => m.includes('slot release after dispatch error failed'))).toBe(true)
  })
})