// RunRecording unit tests (S-M6): the per-run event cap — step events stop
// being stored past MAX_EVENTS_PER_RUN while result envelopes and the
// usage/binding bookkeeping keep landing, and stored indices stay stable.
import { describe, it, expect } from 'vitest'
import { MAX_EVENTS_PER_RUN, RunRecording } from '../src/host/recording.ts'
import type { AgyEvent, RawUsage } from '../src/common/types.ts'

const step = (i: number, usage?: RawUsage): AgyEvent => ({
  kind: 'step',
  stepKey: String(i),
  stepKind: 'text',
  text: 't' + i,
  ...(usage !== undefined ? { usage } : {}),
  raw: {},
})

describe('RunRecording event cap (S-M6)', () => {
  it('caps step storage but always keeps result events and their bookkeeping', () => {
    const rec = new RunRecording('r-cap')
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 3; i++) rec.append(step(i))
    expect(rec.length).toBe(MAX_EVENTS_PER_RUN)
    expect(rec.droppedEvents).toBe(3)
    // Stored indices stay stable (continuation callIds stay valid).
    expect(rec.eventAt(0)?.kind).toBe('step')
    // A result event after the cap is still stored and books the binding.
    rec.append({ kind: 'result', conversationId: 'conv-1', ok: true, response: 'done', usage: { total_tokens: 5 }, raw: {} })
    expect(rec.eventAt(rec.length - 1)?.kind).toBe('result')
    expect(rec.conversationId).toBe('conv-1')
    expect(rec.getResultEvent()).toEqual({ ok: true, response: 'done' })
    expect(rec.hasResult).toBe(true)
  })

  it('step usage survives the cap for the final-usage preference', () => {
    const rec = new RunRecording('r-cap2')
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 1; i++) {
      rec.append(step(i, { total_tokens: 100 + i }))
    }
    expect(rec.droppedEvents).toBe(1)
    // The last appended step's per-call sample was noted despite the drop
    // (append() does the bookkeeping before the cap check).
    expect(rec.finalUsage({ total_tokens: 999_999 })).toEqual({ total_tokens: 100 + MAX_EVENTS_PER_RUN })
  })

  it('append after settle is still a no-op', () => {
    const rec = new RunRecording('r-settled')
    rec.append(step(0))
    rec.settle(null)
    rec.append(step(1))
    expect(rec.length).toBe(1)
    expect(rec.droppedEvents).toBe(0)
  })
})