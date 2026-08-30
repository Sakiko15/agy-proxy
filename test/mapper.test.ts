// Ported from dsh-agy-link test/mapper.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect; useCodeWrapper / run_code
// cases dropped — the gateway mapper always addresses the agy_tool mirror).
import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../src/host/stream-types.ts'
import { EventMapper, suffixDelta, usageFromRaw } from '../src/host/mapper.ts'
import { mirrorCallId, parseMirrorCallId } from '../src/host/recording.ts'
import type { RawUsage } from '../src/common/types.ts'

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>
type UsageChunk = Extract<StreamChunk, { type: 'usage' }>
type ToolCallEnd = Extract<StreamChunk, { type: 'block-end' }> & { block: { type: 'tool-call'; id: string; name: string; arguments: string } }

/** Fresh mapper for one span of run r1 (cut on completed tools, like main turns). */
function newSpan(runId = 'r1', initialSawText = false): EventMapper {
  return new EventMapper({ runId, cutOnTool: true, initialSawText })
}

function mapAll(mapper: EventMapper, events: unknown[], startIdx = 0): StreamChunk[] {
  const out: StreamChunk[] = []
  let i = startIdx
  for (const ev of events) {
    out.push(...mapper.map(ev as never, i))
    i++
    if (mapper.isFinished) break
  }
  return out
}
function lastChunk(cs: StreamChunk[]): StreamChunk {
  const c = cs[cs.length - 1]
  expect(c).toBeDefined()
  return c as StreamChunk
}
function asFinish(c: StreamChunk): FinishChunk {
  expect(c.type).toBe('finish')
  return c as FinishChunk
}
function asUsage(c: StreamChunk): UsageChunk {
  expect(c.type).toBe('usage')
  return c as UsageChunk
}
function toolCallEnd(cs: StreamChunk[]): ToolCallEnd {
  const c = cs.find((x) => x.type === 'block-end' && (x as { block: { type: string } }).block.type === 'tool-call')
  expect(c).toBeDefined()
  return c as unknown as ToolCallEnd
}

describe('mapper', () => {
  it('suffixDelta grows by suffix and falls back to newline+full', () => {
    expect(suffixDelta('', 'abc')).toBe('abc')
    expect(suffixDelta('abc', 'abcdef')).toBe('def')
    expect(suffixDelta('abc', 'abc')).toBe('')
    expect(suffixDelta('abc', 'xyz')).toBe('\nxyz')
  })

  it('ok run without tools emits ordered protocol: blocks, usage, finish last', () => {
    const m = newSpan()
    const chunks = mapAll(m, [
      { kind: 'init', conversationId: 'c1' },
      { kind: 'step', stepKey: '1', stepKind: 'thinking', text: 'Think' },
      { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Hi there' },
      { kind: 'result', conversationId: 'c1', ok: true, response: 'Hi there', usage: { input_tokens: 7, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 1 } },
    ])
    const types = chunks.map((c) => c.type)
    expect(types).toEqual([
      'block-start', 'reasoning-delta', 'block-end',
      'block-start', 'text-delta', 'block-end',
      'usage', 'finish',
    ])
    const finish = asFinish(lastChunk(chunks))
    expect(finish.reason.kind).toBe('stop')
    const usage = asUsage(chunks[chunks.length - 2] as StreamChunk)
    expect(usage.usage.inputTokens).toBe(7)
    expect(usage.usage.reasoningTokens).toBe(2)
    expect((finish.replayState as { response?: { conversationId?: string } } | undefined)?.response?.conversationId).toBe('c1')
    expect(m.isFinished).toBe(true)
  })

  it('result usage reports the last PER-CALL step sample, never the cumulative envelope', () => {
    // Verified against agy 1.1.16: step_update usage is per-call (current
    // context), result usage is conversation-cumulative. Forwarding the
    // envelope made token meters see 76M tokens against a 1M window and
    // fire compaction every few turns.
    const tracker = {
      last: null as RawUsage | null,
      noteStepUsage(raw: RawUsage) {
        this.last = raw
      },
      finalUsage(resultRaw: RawUsage) {
        return this.last ?? resultRaw
      },
    }
    const m = new EventMapper({ runId: 'ru1', cutOnTool: true, usage: tracker })
    const chunks = mapAll(m, [
      { kind: 'init', conversationId: 'c1' },
      { kind: 'step', stepKey: '1', stepKind: 'text', text: 'part one', usage: { input_tokens: 15_000, output_tokens: 100 } },
      { kind: 'step', stepKey: '2', stepKind: 'text', text: 'part two', usage: { input_tokens: 16_800, output_tokens: 160 } },
      { kind: 'result', conversationId: 'c1', ok: true, response: 'part one part two', usage: { input_tokens: 31_800, output_tokens: 260 } },
    ])
    const usageChunks = chunks.filter((c) => c.type === 'usage')
    const finalUsage = asUsage(usageChunks[usageChunks.length - 1] as StreamChunk)
    // last per-call step sample (16.8k), NOT the cumulative 31.8k
    expect(finalUsage.usage.inputTokens).toBe(16_800)
    expect(finalUsage.usage.outputTokens).toBe(160)
  })

  it('result usage falls back to the envelope when no step carried usage', () => {
    const tracker = {
      last: null as RawUsage | null,
      noteStepUsage(raw: RawUsage) {
        this.last = raw
      },
      finalUsage(resultRaw: RawUsage) {
        return this.last ?? resultRaw
      },
    }
    const m = new EventMapper({ runId: 'ru2', cutOnTool: true, usage: tracker })
    const chunks = mapAll(m, [
      { kind: 'init', conversationId: 'c1' },
      { kind: 'step', stepKey: '1', stepKind: 'text', text: 'hi' },
      { kind: 'result', conversationId: 'c1', ok: true, response: 'hi', usage: { input_tokens: 14_726, output_tokens: 166 } },
    ])
    const usageChunks = chunks.filter((c) => c.type === 'usage')
    const finalUsage = asUsage(usageChunks[usageChunks.length - 1] as StreamChunk)
    expect(finalUsage.usage.inputTokens).toBe(14_726)
  })

  it('snapshot-style repeated steps stream as suffix deltas', () => {
    const m = newSpan()
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello' },
      { kind: 'step', stepKey: '1', stepKind: 'text', text: 'Hello world' },
    ])
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('completed tool step cuts the span into a native agy_tool call', () => {
    const m = newSpan('run-abc')
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '2', stepKind: 'text', text: 'Working on it' },
      // ACTIVE has no payload yet: no cut
      { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
      { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'a.txt' } },
      // later events must not map: the span already finished
      { kind: 'step', stepKey: '9', stepKind: 'text', text: 'after the cut' },
    ])
    const end = toolCallEnd(chunks)
    expect(end.block.name).toBe('agy_tool')
    expect(end.block.id).toBe(mirrorCallId('run-abc', 2))
    const args = JSON.parse(end.block.arguments) as { run: string; step: number; tool: string; input: Record<string, unknown> }
    expect(args.run).toBe('run-abc')
    expect(args.step).toBe(2)
    expect(args.tool).toBe('run_command')
    expect(args.input).toEqual({ command: 'ls' })
    const finish = asFinish(lastChunk(chunks))
    expect(finish.reason.kind).toBe('tool-calls')
    expect(m.isFinished).toBe(true)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('Working on it')
  })

  it('erroring tool step cuts exactly like a successful one', () => {
    const m = newSpan('r1')
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'timed out' } },
    ])
    const end = toolCallEnd(chunks)
    expect(end.block.name).toBe('agy_tool')
    expect(asFinish(lastChunk(chunks)).reason.kind).toBe('tool-calls')
  })

  it('auxiliary spans never cut on tools', () => {
    const m = new EventMapper({ runId: 'r2', cutOnTool: false })
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '1', stepKind: 'tool', text: '', tool: { name: 'run_command', args: {}, output: 'x' } },
      { kind: 'result', conversationId: 'c', ok: true, response: 'done', usage: {} },
    ])
    expect(chunks.some((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')).toBe(false)
    expect(asFinish(lastChunk(chunks)).reason.kind).toBe('stop')
  })

  it('result text used when no text step streamed anywhere in the run', () => {
    const m = newSpan('r3')
    const chunks = mapAll(m, [
      { kind: 'result', conversationId: 'c2', ok: true, response: 'only final', usage: {} },
    ])
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as unknown as { text: string }).text)
    expect(deltas).toEqual(['only final'])
  })

  it('result fallback suppressed when an earlier span already streamed the text', () => {
    // Final span of a run whose text streamed in span 1: the result response
    // must NOT be duplicated as a fresh text block.
    const m = newSpan('r4', true)
    const chunks = mapAll(m, [
      { kind: 'result', conversationId: 'c4', ok: true, response: 'already streamed', usage: {} },
    ], 5)
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(false)
    expect(asFinish(lastChunk(chunks)).reason.kind).toBe('stop')
  })

  it('agy 1.1.15 stream maps onto spans: thinking turn, tool cuts, fragments, result', () => {
    const events: unknown[] = [
      { kind: 'init', conversationId: 'c15' },
      // thinking-only turn (usage, no text)
      { kind: 'step', stepKey: '2', stepKind: 'text', text: '', usage: { thinking_tokens: 80 } },
      // tool call with output
      { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'ACTIVE', text: '', tool: { name: 'run_command', args: { command: 'ls' } } },
      { kind: 'step', stepKey: '3', stepKind: 'tool', state: 'DONE', text: '', tool: { name: 'run_command', args: { command: 'ls' }, output: 'note1.txt' } },
      // failed tool call
      { kind: 'step', stepKey: '4', stepKind: 'tool', state: 'ERROR', text: '', tool: { name: 'find_by_name', args: { pattern: 'x' }, error: 'Find command timed out.' } },
      // streamed answer fragments
      { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
      { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true },
      { kind: 'result', conversationId: 'c15', ok: true, response: 'There are 2 files.', usage: { input_tokens: 9, output_tokens: 8, thinking_tokens: 95 } },
    ]
    // Span 1: thinking annotation + first tool cut
    const s1 = newSpan('run15')
    const c1 = mapAll(s1, events, 0)
    const reasoning1 = c1.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning1).toContain('[agy thinking turn · 80 thinking tokens]')
    expect(toolCallEnd(c1).block.id).toBe(mirrorCallId('run15', 3))
    expect(asFinish(lastChunk(c1)).reason.kind).toBe('tool-calls')
    // Span 2: second tool cut (the errored one)
    const s2 = newSpan('run15')
    const c2 = mapAll(s2, events.slice(4), 4)
    expect(toolCallEnd(c2).block.id).toBe(mirrorCallId('run15', 4))
    expect(asFinish(lastChunk(c2)).reason.kind).toBe('tool-calls')
    // Span 3: fragments + result → stop
    const s3 = newSpan('run15', false)
    const c3 = mapAll(s3, events.slice(5), 5)
    const text3 = c3.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text3).toBe('There are 2 files.')
    expect(asFinish(lastChunk(c3)).reason.kind).toBe('stop')
  })

  it('one-shot answer step (text + usage together) still annotates thinking', () => {
    // agy answers trivial questions in a single DONE envelope: no separate
    // thinking-only step ever arrives. Regression (v0.3.2): these turns used
    // to show no thinking at all.
    const m = newSpan('r-oneshot')
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '2', stepKind: 'text', text: '1 + 1 等于 2。', usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 154 } },
      { kind: 'result', conversationId: 'c9', ok: true, response: '1 + 1 等于 2。', usage: {} },
    ])
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning).toContain('[agy thinking turn · 154 thinking tokens]')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('1 + 1 等于 2。')
    // protocol order: the reasoning annotation precedes the answer text
    const types = chunks.map((c) => c.type)
    const rIdx = types.indexOf('reasoning-delta')
    const tIdx = types.indexOf('text-delta')
    expect(rIdx >= 0 && tIdx > rIdx).toBe(true)
  })

  it('streamed answer: DONE-tail usage annotates AFTER the complete text', () => {
    // v0.3.2 wedged the chip mid-sentence (annotated at DONE arrival, between
    // fragments); v0.3.3 then dropped it entirely (first turn showed no
    // thinking). Now the annotation is deferred to the step's text completion:
    // present, but strictly after the last fragment.
    const m = newSpan('r-tail')
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are ', fragment: true },
      { kind: 'step', stepKey: '5', stepKind: 'text', text: '2 files.', fragment: true, usage: { thinking_tokens: 15 } },
      { kind: 'result', conversationId: 'c9', ok: true, response: 'There are 2 files.', usage: {} },
    ])
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning).toContain('[agy thinking turn · 15 thinking tokens]')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('There are 2 files.')
    // the annotation trails the LAST text delta — never between fragments
    const types = chunks.map((c) => c.type)
    const lastTextIdx = types.lastIndexOf('text-delta')
    const reasoningIdx = types.indexOf('reasoning-delta')
    expect(lastTextIdx >= 0 && reasoningIdx > lastTextIdx).toBe(true)
    expect(asFinish(lastChunk(chunks)).reason.kind).toBe('stop')
  })

  it('DONE tail with usage but no text still annotates after streamed text', () => {
    const m = newSpan('r-tail2')
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '7', stepKind: 'text', text: 'Answer.', fragment: true },
      { kind: 'step', stepKey: '7', stepKind: 'text', text: '', usage: { thinking_tokens: 9 } },
      { kind: 'result', conversationId: 'c9', ok: true, response: 'Answer.', usage: {} },
    ])
    const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
    expect(reasoning).toContain('[agy thinking turn · 9 thinking tokens]')
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('Answer.')
  })

  it('emitFailure closes blocks and finishes with error', () => {
    const m = newSpan()
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '1', stepKind: 'text', text: 'partial' },
    ])
    chunks.push(...[...m.emitFailure('error', 'AUTH', 'not signed in')])
    const finish = asFinish(lastChunk(chunks))
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('AUTH')
    } else {
      expect.unreachable('expected error finish')
    }
    const endIdx = chunks.map((c) => c.type).lastIndexOf('block-end')
    expect(endIdx).toBeGreaterThanOrEqual(0)
    expect(chunks.slice(endIdx + 1).every((d) => d.type === 'usage' || d.type === 'finish')).toBe(true)
  })

  it('result ERROR with usable response soft-finishes and annotates the error', () => {
    const m = newSpan()
    const chunks = mapAll(m, [
      { kind: 'step', stepKey: '5', stepKind: 'text', text: 'There are 2 files.', fragment: true },
      { kind: 'result', conversationId: 'c15', ok: false, response: 'There are 2 files.', error: 'find timed out', usage: { input_tokens: 9, output_tokens: 8 } },
    ])
    const reasoning = chunks
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => (c as { text: string }).text)
      .join('')
    expect(reasoning).toContain('[agy finished with error] find timed out')
    const finish = asFinish(lastChunk(chunks))
    expect(finish.reason.kind).toBe('stop')
    expect(m.isFinished).toBe(true)
  })

  it('result ERROR without response stays passive for the adapter', () => {
    const m = newSpan()
    const chunks = mapAll(m, [
      { kind: 'result', conversationId: 'c15', ok: false, response: '', error: 'explosion', usage: {} },
    ])
    expect(chunks.length).toBe(0)
    expect(m.isFinished).toBe(false)
  })

  it('mirrorCallId round-trips through parseMirrorCallId', () => {
    const id = mirrorCallId('0f1e2d3c-4b5a-6789-9abc-def012345678', 42)
    expect(id).toBe('agytc-0f1e2d3c-4b5a-6789-9abc-def012345678-42')
    expect(parseMirrorCallId(id)).toEqual({ runId: '0f1e2d3c-4b5a-6789-9abc-def012345678', eventIndex: 42 })
    expect(parseMirrorCallId('other-1')).toBeNull()
    expect(parseMirrorCallId('agytc-x')).toBeNull()
  })

  it('usageFromRaw maps snake_case fields', () => {
    const u = usageFromRaw({ input_tokens: 1, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 4, cache_write_tokens: 5 })
    expect(u.inputTokens).toBe(1)
    expect(u.outputTokens).toBe(2)
    expect(u.reasoningTokens).toBe(3)
    expect(u.cacheReadTokens).toBe(4)
    expect(u.cacheWriteTokens).toBe(5)
  })
})
