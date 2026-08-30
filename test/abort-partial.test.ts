// Ported from dsh-agy-link test/abort-partial.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect).
import { describe, it, expect } from 'vitest'
import { EventMapper } from '../src/host/mapper.ts'
import type { StreamChunk } from '../src/host/stream-types.ts'

// Regression (v0.2): aborting mid-stream must still deliver everything the
// model already produced — emitFailure closes the open block first, so
// partial text/thinking is never dropped when the caller hits stop.
describe('abort partial', () => {
  it('emitFailure(aborted) preserves already-emitted deltas', () => {
    const m = new EventMapper({ runId: 'r-abort', cutOnTool: true })
    const chunks: StreamChunk[] = []
    const feed = (ev: Parameters<EventMapper['map']>[0]): void => {
      for (const ch of m.map(ev, 0)) chunks.push(ch)
    }
    feed({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'Hello ' } as never)
    feed({ kind: 'step', stepKind: 'text', stepKey: 's1', text: 'Hello world' } as never)
    for (const ch of m.emitFailure('aborted', 'ABORTED', 'agy run aborted by caller')) chunks.push(ch)
    const deltas = chunks.filter((c) => c.type === 'text-delta') as Array<{ text: string }>
    expect(deltas.map((d) => d.text).join('')).toBe('Hello world')
    const types = chunks.map((c) => c.type)
    expect(types).toContain('block-end')
    expect(types).toContain('finish')
    const finish = chunks.find((c) => c.type === 'finish') as { reason: { kind: string; failure?: { code: string } } }
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.reason.failure?.code).toBe('ABORTED')
    expect(types[types.length - 1]).toBe('finish')
    expect([...m.emitFailure('error', 'X', 'y')].length).toBe(0)
  })
})
