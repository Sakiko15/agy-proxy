// Ported from dsh-agy-link test/mirror-tool.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect). Shrunk scope: the
// defineAgyMirrorTool views/presenters, run_code wrapper round-trip and
// getGitHeadContent tests have no host in the gateway (mirror.ts is the
// shrunk port); what survives is recording behavior + executeMirrorTool.
import { describe, it, expect } from 'vitest'
import { RunRecording, RunRegistry } from '../src/host/recording.ts'
import { executeMirrorTool } from '../src/host/mirror.ts'

describe('recording', () => {
  it('events stream live and settle, with stable indices', async () => {
    const rec = new RunRecording('run-x')
    const seen: string[] = []
    const reader = (async () => {
      for await (const ev of rec.eventsFrom(0)) seen.push((ev as { kind: string; stepKey?: string }).stepKey ?? ev.kind)
    })()
    rec.append({ kind: 'init', conversationId: 'c' } as never)
    rec.append({ kind: 'step', stepKey: 'a', stepKind: 'text', text: 'hi' } as never)
    rec.settle(null)
    await reader
    expect(seen).toEqual(['init', 'a'])
    expect(rec.sawTextBefore(1)).toBe(false)
    expect(rec.sawTextBefore(2)).toBe(true)
    expect(rec.getResultEvent()).toBeNull()
  })

  it('result event projection and tool lookup by index', () => {
    const rec = new RunRecording('run-y')
    rec.append({ kind: 'step', stepKey: 't', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'x' } } as never)
    rec.append({ kind: 'result', conversationId: 'cy', ok: true, response: 'done', usage: {} } as never)
    expect(rec.getResultEvent()).toEqual({ ok: true, response: 'done' })
    expect(rec.toolEventAt(0)?.name).toBe('run_command')
    expect(rec.toolEventAt(1)).toBeNull()
  })

  it('registry retains bounded LRU and serves runs by id', () => {
    const reg = new RunRegistry()
    const a = reg.create()
    expect(reg.get(a.runId)).toBe(a)
    reg.forget(a.runId)
    expect(reg.get(a.runId)).toBeUndefined()
  })
})

describe('mirror (agy_tool)', () => {
  it('execute replays recorded output and errors honestly', () => {
    const reg = new RunRegistry()
    const rec = reg.create()
    rec.append({ kind: 'step', stepKey: 't1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'out-line' } } as never)
    rec.append({ kind: 'step', stepKey: 't2', stepKind: 'tool', text: '', tool: { name: 'find_by_name', args: {}, error: 'boom' } } as never)
    expect(executeMirrorTool({ runs: reg }, { run: rec.runId, step: 0, tool: 'run_command' })).toBe('out-line')
    expect(() => executeMirrorTool({ runs: reg }, { run: rec.runId, step: 1, tool: 'find_by_name' })).toThrow(/boom/)
    expect(() => executeMirrorTool({ runs: reg }, { run: 'missing', step: 0, tool: 'x' })).toThrow(/no recorded agy run/)
  })

  it('cursor-only invocations (run/step without tool/input) still replay', () => {
    // The schema marks tool/input optional; execute must resolve the step
    // from the recording alone.
    const reg = new RunRegistry()
    const rec = reg.create()
    rec.append({ kind: 'step', stepKey: 't1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: { command: 'ls -la' }, output: 'x' } } as never)
    const cursor = { run: rec.runId, step: 0 }
    expect(executeMirrorTool({ runs: reg }, cursor)).toBe('x')
  })

  it('object output serializes to pretty JSON; undefined output returns empty string', () => {
    const reg = new RunRegistry()
    const rec = reg.create()
    rec.append({ kind: 'step', stepKey: 'a', stepKind: 'tool', text: '', tool: { name: 'edit', output: { ok: true } } } as never)
    rec.append({ kind: 'step', stepKey: 'b', stepKind: 'tool', text: '', tool: { name: 'edit' } } as never)
    expect(executeMirrorTool({ runs: reg }, { run: rec.runId, step: 0 })).toBe(JSON.stringify({ ok: true }, null, 2))
    expect(executeMirrorTool({ runs: reg }, { run: rec.runId, step: 1 })).toBe('')
  })

  it('non-tool events are not executable steps', () => {
    const reg = new RunRegistry()
    const rec = reg.create()
    rec.append({ kind: 'step', stepKey: 'x', stepKind: 'text', text: 'prose' } as never)
    expect(() => executeMirrorTool({ runs: reg }, { run: rec.runId, step: 0 })).toThrow(/not a completed tool step/)
  })
})
