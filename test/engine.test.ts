// Engine tests against the fake agy binary. Covers the span protocol (native
// tool mirroring via finish:tool-calls + continuation), conversation binding
// reuse, error mapping, argv assembly, digest/compaction discipline, and the
// multimodal staging path.
// Ported from dsh-agy-link test/adapter.test.ts @ 46984db (modified:
// GenerateOptions → EngineCall, Message → EngineMessage, LlmError →
// EngineError; dsh-llm listModels/resolveModel/prepareCall cases dropped —
// the service layer uses ModelCatalog directly; sessionCwd cases dropped —
// the engine has no host-provided session workspace seam).
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyEngine, buildDigest, detectContinuation, EngineError, type EngineCall, type EngineDeps, type EngineMessage } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { executeMirrorTool } from '../src/host/mirror.ts'
import type { StreamChunk } from '../src/host/stream-types.ts'
import { defaultConfig, Err, type GatewayConfig } from '../src/common/types.ts'

// On Windows, Node refuses to spawn a .mjs file directly (EFTYPE — it has no
// executable image header); on Linux it needs a shebang + exec bit. Node's
// own execPath plus the script path works on every platform, so the engine's
// `bin` seam points at node with the fake binary as the first argument.
const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')
const workDir = mkdtempSync(join(tmpdir(), 'agy-engine-'))
process.env.AGY_PROXY_CONVERSATIONS_DIR = join(workDir, 'convs')

function msg(role: 'user' | 'assistant', text: string): EngineMessage {
  return { role, text }
}

function makeEngine(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000, ...cfgOverrides }
  const store = new SessionStore(join(workDir, 'sessions.json'))
  const catalog = new ModelCatalog(
    async () => { throw new Error('no discovery in tests') },
    cfg.fallbackModels,
    300_000,
  )
  const argsFile = join(workDir, 'args.json')
  const runs = new RunRegistry()
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store,
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => Promise.resolve(() => {}),
    runs,
    retryDelay: async () => {}, // M5: failing runs retry once — keep tests fast (timing pinned in engine-retry.test)
    ...deps,
  })
  return { engine, store, argsFile, runs }
}

function call(messages: EngineMessage[], extra: Partial<EngineCall> = {}): EngineCall {
  return {
    model: 'gemini-3.7-flash',
    messages,
    ...extra,
  }
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

async function waitFor<T>(f: () => T | undefined, ms = 3_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v !== undefined) return v
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

type MirrorArgs = { run: string; step: number; tool: string; input?: unknown }

/**
 * Drive one full agy turn the way the gateway loop would: collect a span,
 * and whenever it finishes with tool-calls, append the mirrored tool-result
 * message and call stream() again.
 */
async function runTurn(
  engine: AgyEngine,
  base: EngineMessage[],
  extra: Partial<EngineCall> = {},
  maxHops = 12,
): Promise<{ chunks: StreamChunk[]; toolCalls: Array<{ id: string; args: MirrorArgs }>; messages: EngineMessage[] }> {
  const messages = [...base]
  const all: StreamChunk[] = []
  const toolCalls: Array<{ id: string; args: MirrorArgs }> = []
  for (let hop = 0; hop < maxHops; hop++) {
    // Pass a copy: the engine's outcome handler captures the array it was
    // given, and the watermark it records must reflect this hop's view.
    const chunks = await collect(engine.stream(call([...messages], extra)))
    all.push(...chunks)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } } | undefined
    if (finish === undefined || finish.type !== 'finish') throw new Error('span ended without a finish chunk')
    if (finish.reason.kind !== 'tool-calls') return { chunks: all, toolCalls, messages }
    const end = chunks.find(
      (c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call',
    ) as unknown as { block: { id: string; name: string; arguments: string } } | undefined
    if (end === undefined) throw new Error('tool-calls finish without a tool-call block')
    if (end.block.name !== 'agy_tool') throw new Error('tool-call block must address agy_tool, got ' + end.block.name)
    const parsed = JSON.parse(end.block.arguments) as { run: string; step: number; tool?: string }
    const args: MirrorArgs = { run: parsed.run, step: parsed.step, tool: parsed.tool ?? '' }
    toolCalls.push({ id: end.block.id, args })
    messages.push({
      role: 'tool',
      text: 'replayed',
      toolCallId: end.block.id,
    })
  }
  throw new Error('runTurn exceeded the hop budget')
}

describe('engine: ok run, mirroring, binding', () => {
  it('ok run mirrors tools natively, streams text, and persists the binding', async () => {
    const { engine, store, argsFile, runs } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    const { chunks, toolCalls } = await runTurn(engine, [msg('user', 'hello there')], { sessionKey: 'sess-1' })
    const types = chunks.map((c) => c.type)
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
    expect(types[types.length - 2]).toBe('usage')
    expect(types).toContain('reasoning-delta')
    expect(types).toContain('text-delta')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
    expect(text).not.toContain('[agy tool:')
    expect(text.endsWith('Hello from fake agy')).toBe(true)
    // the read_file step became exactly one native tool-call span; the block
    // carries only the (run, step) cursor — the tool name lives in the recording
    expect(toolCalls.length).toBe(1)
    const first = toolCalls[0] as { args: { run: string; step: number } }
    expect(first.args.run.length > 0).toBe(true)
    const t = runs.get(first.args.run)?.toolEventAt(first.args.step)
    expect(t?.name).toBe('read_file')
    // the mirror replays the recorded output for that callId
    const replayed = executeMirrorTool({ runs }, toolCalls[0]?.args)
    expect(replayed).toBe('file contents here')
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    expect(argv).toContain('--output-format')
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(argv).toContain('--mode')
    expect(argv).not.toContain('--conversation')
    const b = await waitFor(() => store.get('sess-1'))
    expect(b.conversationId).toBe('conv-fresh-1')
    expect(b.lastMessageCount).toBe(1)
  })

  it('detectContinuation keys off the trailing mirror tool-result only', () => {
    const toolResult = (callId: string): EngineMessage => ({ role: 'tool', text: '', toolCallId: callId })
    expect(detectContinuation([msg('user', 'q'), toolResult('agytc-run-1-7')])).toEqual({ runId: 'run-1', eventIndex: 7 })
    expect(detectContinuation([msg('user', 'q')])).toBeNull()
    expect(detectContinuation([msg('user', 'q'), toolResult('bash-9')])).toBeNull()
  })

  it('second turn reuses the bound conversation id', async () => {
    const { engine, store } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args2.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    await runTurn(engine, [msg('user', 'one')], { sessionKey: 'sess-2' })
    await waitFor(() => store.get('sess-2'))
    await runTurn(engine, [msg('assistant', 'one'), msg('user', 'two')], { sessionKey: 'sess-2' })
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    expect(argv[argv.indexOf('--conversation') + 1]).toBe('conv-fresh-1')
  })

  it('unbound follow-up turn gets a history digest prefix', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args3.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    await runTurn(engine, [msg('assistant', 'earlier answer'), msg('user', 'follow up')])
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('[conversation so far]')
    expect(prompt).toContain('follow up')
  })
})

describe('engine: real-shape runs and error mapping', () => {
  it('agy 1.1.15 stream mirrors tools as native cards across spans', async () => {
    const { engine, runs } = makeEngine()
    process.env.FAKE_AGY_MODE = 'real'
    const { chunks, toolCalls } = await runTurn(engine, [msg('user', 'count the files')])
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.reason.kind).toBe('stop')
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as unknown as { text: string }).text).join('')
    expect(reasoning).toContain('[agy thinking turn · 80 thinking tokens]')
    expect(reasoning).not.toContain('[agy tool:')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text).join('')
    expect(text).not.toContain('note1.txt')
    expect(text).toContain('There are 2 files, 6 words total.')
    // both tool steps became mirrored native calls, in order
    const names = toolCalls.map((t) => runs.get(t.args.run)?.toolEventAt(t.args.step)?.name)
    expect(names).toEqual(['run_command', 'find_by_name'])
    // the mirror replays run_command's recorded output and surfaces the errored tool
    const out = executeMirrorTool({ runs }, toolCalls[0]?.args)
    expect(out).toBe('note1.txt\nnote2.txt\n')
    expect(() => executeMirrorTool({ runs }, toolCalls[1]?.args)).toThrow(/Find command timed out/)
  })

  it('agy 1.1.15 result ERROR with response still finishes stop', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'real-error'
    const { chunks } = await runTurn(engine, [msg('user', 'count the files')])
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.reason.kind).toBe('stop')
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as unknown as { text: string }).text).join('')
    expect(reasoning).toContain('[agy finished with error] Find command timed out')
  })

  it('agy 1.1.15 bare result error maps to AGY_ERROR after the tool spans', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'real-fail'
    const { chunks } = await runTurn(engine, [msg('user', 'hi')])
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.AGY_ERROR)
    expect(finish.reason.failure?.message).toContain('model overloaded')
  })

  it('auth failure maps to an AUTH error finish', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'auth'
    const chunks = await collect(engine.stream(call([msg('user', 'hi')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.AUTH)
    expect(finish.reason.failure?.message).toContain('add a Google account')
  })

  it('garbage-noise run still finishes clean', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'noise'
    const { chunks } = await runTurn(engine, [msg('user', 'hi')])
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
  })

  it('nonzero exit without result maps to PROCESS_EXIT', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'exit12'
    const chunks = await collect(engine.stream(call([msg('user', 'hi')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.PROCESS_EXIT)
  })

  it('nonzero exit WITH a stdout error envelope surfaces the real cause', async () => {
    // Regression: agy exits 1 with empty stderr and puts its error in the
    // stdout result envelope. The message used to be the bare
    // "agy exited with code 1" with no cause, which is exactly what a user
    // session log showed while quota errors went unnoticed.
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'exit-error'
    const chunks = await collect(engine.stream(call([msg('user', 'hi')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string; message: string } } }
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.PROCESS_EXIT)
    expect(finish.reason.failure?.message ?? '').toContain('agy exited with code 1:')
    expect(finish.reason.failure?.message ?? '').toContain('upstream request failed while generating')
  })

  it('unspawnable binary maps to PROCESS_EXIT without hanging', async () => {
    const broken = new AgyEngine({
      getConfig: () => ({ ...defaultConfig(), permissionMode: 'plan', timeoutMs: 10_000 }),
      catalog: new ModelCatalog(async () => { throw new Error('x') }, defaultConfig().fallbackModels, 300_000),
      store: new SessionStore(join(workDir, 'sessions-x.json')),
      bin: () => '/nonexistent/agy-binary-x',
      acquire: () => Promise.resolve(() => {}),
      runs: new RunRegistry(),
      retryDelay: async () => {}, // M5: failing runs retry once — keep tests fast (timing pinned in engine-retry.test)
    })
    const chunks = await collect(broken.stream(call([msg('user', 'hi')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.PROCESS_EXIT)
  })

  it('engine spawns the bin returned by deps.bin with our argv', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    // The engine drives the fake through `node fake-agy.mjs`; a spawn failure
    // of the wrapper itself (EFTYPE on Windows when handed the .mjs directly)
    // must not silently surface as a stream error finish.
    const chunks = await collect(engine.stream(call([msg('user', 'spawn-check')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string } }
    expect(finish.reason.kind).not.toBe('error')
  })

  it('watchdog kills a hung agy run and surfaces TIMEOUT', async () => {
    const { engine } = makeEngine({ timeoutMs: 600 })
    process.env.FAKE_AGY_MODE = 'hang'
    const chunks = await collect(engine.stream(call([msg('user', 'hi')])))
    const finish = chunks[chunks.length - 1] as { type: string; reason: { kind: string; failure?: { code: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.code).toBe(Err.TIMEOUT)
  })

  it('unknown reasoning effort on known model is rejected', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    await expect(collect(engine.stream(call([msg('user', 'x')], { reasoningEffort: 'ultra' })))).rejects.toMatchObject({
      code: Err.UNSUPPORTED_REASONING_EFFORT,
    })
  })
})

describe('engine: argv assembly, digest, rate limit', () => {
  it('buildArgs assembles flags per ADR-3/8/10', () => {
    const { engine } = makeEngine()
    const args = engine.buildArgs({
      prompt: 'do it',
      model: 'gemini-3.7-flash',
      effort: 'high',
      conversationId: 'c9',
      permissionMode: 'skip',
      timeoutMs: 90_000,
      extraArgs: ['--add-dir', '/tmp'],
    })
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--mode')
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.7-flash')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
    expect(args[args.indexOf('--conversation') + 1]).toBe('c9')
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('2m')
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/tmp')
    const planArgs = engine.buildArgs({ prompt: 'p', model: 'gemini-3.5-flash', permissionMode: 'plan', timeoutMs: 60_000, extraArgs: [] })
    expect(planArgs[planArgs.indexOf('--mode') + 1]).toBe('plan')

    // Non-Gemini models (Claude, GPT-OSS) MUST strip --effort and resolve aliases
    const claudeArgs = engine.buildArgs({
      prompt: 'hello',
      model: 'claude-opus-4-6',
      effort: 'medium',
      permissionMode: 'plan',
      timeoutMs: 60_000,
      extraArgs: [],
    })
    expect(claudeArgs[claudeArgs.indexOf('--model') + 1]).toBe('claude-opus-4-6-thinking')
    expect(claudeArgs).not.toContain('--effort')
  })

  it('buildDigest bounds output and keeps newest turns', () => {
    const msgs = [msg('user', 'turn-one'), msg('assistant', 'turn-two'), msg('user', 'turn-three')]
    const d = buildDigest(msgs, 0, 25)
    expect(d).toContain('[conversation so far]')
    expect(d).toContain('turn-three')
    expect(d).not.toContain('turn-one')
    const full = buildDigest(msgs, 0, 10_000)
    expect(full).toContain('turn-one')
    expect(full).toContain('turn-three')
  })

  it('returning session digests only foreign turns since the watermark', async () => {
    const { engine, store } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-w1.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    // Turn 1 binds the session (watermark = 1 message).
    await runTurn(engine, [msg('user', 'one')], { sessionKey: 'sess-w' })
    await waitFor(() => store.get('sess-w'))
    // Turn 2: our own agy reply + a foreign (deepseek) interjection in between.
    await runTurn(engine, [
      { role: 'assistant', text: 'one', provider: 'antigravity' },
      msg('user', 'two'),
      { role: 'assistant', text: 'deepseek said Z', provider: 'deepseek-official' },
      msg('user', 'final question'),
    ], { sessionKey: 'sess-w' })
    // wait for turn 2's watermark (4 messages) before asserting/driving turn 3
    await waitFor(() => {
      const b = store.get('sess-w')
      return b !== undefined && b.lastMessageCount >= 4 ? b : undefined
    })
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('final question')
    expect(prompt).toContain('deepseek said Z')
    expect(prompt).toContain('two')
    expect(prompt).not.toContain('User: one')
    expect(argv[argv.indexOf('--conversation') + 1]).toBe('conv-fresh-1')

    // Turn 3 (clean, only our own replies since watermark): no digest at all.
    const argsFile2 = join(workDir, 'args-w2.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile2
    await runTurn(engine, [
      { role: 'assistant', text: 'one', provider: 'antigravity' },
      msg('user', 'two'),
      { role: 'assistant', text: 'deepseek said Z', provider: 'deepseek-official' },
      msg('user', 'final question'),
      { role: 'assistant', text: 'final answer', provider: 'antigravity' },
      msg('user', 'third'),
    ], { sessionKey: 'sess-w' })
    const argv2 = JSON.parse(readFileSync(argsFile2, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt2 = argv2[argv2.indexOf('-p') + 1] ?? ''
    expect(prompt2).not.toContain('[conversation so far]')
    expect(prompt2).toBe('third')
  })

  it('compaction detection clears stale binding and re-seeds with digest', async () => {
    const { engine, store } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-compact.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile

    // Turn 1: 5 messages, creates binding with watermark 5
    await runTurn(engine, [
      msg('user', 'm1'),
      msg('assistant', 'a1'),
      msg('user', 'm2'),
      msg('assistant', 'a2'),
      msg('user', 'm3'),
    ], { sessionKey: 'sess-compact' })

    await waitFor(() => store.get('sess-compact'))
    expect(store.get('sess-compact')?.lastMessageCount).toBe(5)

    // Turn 2: the client truncates history down to 2 messages
    await runTurn(engine, [
      msg('assistant', '[compacted summary of m1-m3]'),
      msg('user', 'new question after compaction'),
    ], { sessionKey: 'sess-compact' })

    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    // Because messages.length (2) < previous lastMessageCount (5), binding was reset and re-seeded with digest!
    expect(prompt).toContain('[conversation so far]')
    expect(prompt).toContain('[compacted summary of m1-m3]')
    expect(prompt).toContain('new question after compaction')
    expect(!argv.includes('--conversation') || argv[argv.indexOf('--conversation') + 1] !== 'conv-fresh-1').toBe(true)
  })

  it('model switch invalidates stale agy conversation binding', async () => {
    const { engine, store } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-modelswitch.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile

    // Turn 1: model gemini-3.7-flash
    await runTurn(engine, [msg('user', 'hello')], { sessionKey: 'sess-switch', model: 'gemini-3.7-flash' })
    await waitFor(() => store.get('sess-switch'))
    expect(store.get('sess-switch')?.model).toBe('gemini-3.7-flash')
    const conv1 = store.get('sess-switch')?.conversationId

    // Turn 2: switch to claude-sonnet-4-6
    await runTurn(engine, [msg('user', 'hello'), msg('assistant', 'hi'), msg('user', 'next')], { sessionKey: 'sess-switch', model: 'claude-sonnet-4-6' })

    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    expect(!argv.includes('--conversation') || argv[argv.indexOf('--conversation') + 1] !== conv1).toBe(true)
  })

  it('system prompt is always forwarded as system instructions', async () => {
    const { engine } = makeEngine()
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-sys.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile
    await runTurn(engine, [msg('user', 'hello')], { system: 'Be terse.' })
    const argv = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt = argv[argv.indexOf('-p') + 1] ?? ''
    expect(prompt).toContain('System instructions:\nBe terse.')
    expect(prompt).toContain('hello')
  })

  it('duplicate request with identical prompt within debounce window is rejected with BUSY', async () => {
    const { engine } = makeEngine()
    const userMsg = msg('user', 'Please perform task X')
    const sessionCall = call([userMsg], { sessionKey: 'sess-dup-test' })

    // Start first stream (pulling first chunk starts the generator body)
    const iter1 = engine.stream(sessionCall)[Symbol.asyncIterator]()
    const firstChunk = await iter1.next()
    expect(firstChunk.done).toBe(false)

    // Immediately attempt second identical stream for same session
    await expect((async () => {
      const iter2 = engine.stream(sessionCall)
      for await (const _ of iter2) { void _ }
    })()).rejects.toMatchObject({ code: Err.BUSY })

    // Drain first stream so it finishes cleanly
    while (!(await iter1.next()).done) { /* drain */ }
  })

  it('sliding-window rate limit enforces request throttling per minute', async () => {
    const { engine } = makeEngine({ rateLimitPerMinute: 2 })

    const t0 = Date.now()
    // Run 2 turns quickly
    await runTurn(engine, [msg('user', 'Req 1')], { sessionKey: 'sess-rl-1' })
    await runTurn(engine, [msg('user', 'Req 2')], { sessionKey: 'sess-rl-2' })

    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('engine: multimodal staging', () => {
  it('stages attached images and forwards path with view_file instructions', async () => {
    const pngData = Buffer.from('89504e470d0a1a0a', 'hex')
    const { engine } = makeEngine({}, {
      readImage: async () => pngData,
    })
    process.env.FAKE_AGY_MODE = 'ok'
    const argsFile = join(workDir, 'args-multimodal.json')
    process.env.FAKE_AGY_ARGS_FILE = argsFile

    // 1. Text + image
    await runTurn(engine, [{
      role: 'user',
      text: 'what is this image?',
      images: [{ mediaType: 'image/png', bytes: pngData.length, name: 'diagram.png' }],
    }], { sessionKey: 'sess-img' })
    const argv1 = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt1 = argv1[argv1.indexOf('-p') + 1] ?? ''
    expect(prompt1).toContain('what is this image?')
    expect(prompt1).toContain('[image attached: "diagram.png"')
    expect(prompt1).toContain('Inspect it using the view_file tool')
    expect(argv1).toContain('--add-dir')

    // 2. Image only (no text)
    await runTurn(engine, [{
      role: 'user',
      text: '',
      images: [{ mediaType: 'image/png', bytes: pngData.length }],
    }], { sessionKey: 'sess-img-only' })
    const argv2 = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n').at(-1) ?? '[]') as string[]
    const prompt2 = argv2[argv2.indexOf('-p') + 1] ?? ''
    expect(prompt2).toContain('[image attached: "image"')
    expect(prompt2).toContain('[Please inspect the attached image(s) using view_file and assist the user.]')
  })
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// EngineError carries the routing code (used by the service layer mapping).
describe('EngineError', () => {
  it('carries a stable code', () => {
    const e = new EngineError('boom', Err.AUTH)
    expect(e.code).toBe(Err.AUTH)
    expect(e.message).toBe('boom')
  })
})
