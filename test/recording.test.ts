// RunRecording unit tests (S-M6): the per-run event cap — step events stop
// being stored past MAX_EVENTS_PER_RUN while result envelopes and the
// usage/binding bookkeeping keep landing, and stored indices stay stable.
// Also: RunRegistry capacity + the A-M4 keep/forget lifecycle.
import { describe, it, expect } from 'vitest'
import { MAX_EVENTS_PER_RUN, RunRecording, RunRegistry } from '../src/host/recording.ts'
import type { AgyEvent, RawUsage } from '../src/common/types.ts'

const step = (i: number, usage?: RawUsage): AgyEvent => ({
  kind: 'step',
  stepKey: String(i),
  stepKind: 'text',
  text: 't' + i,
  ...(usage !== undefined ? { usage } : {}),
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
    rec.append({ kind: 'result', conversationId: 'conv-1', ok: true, response: 'done', usage: { total_tokens: 5 } })
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

describe('RunRegistry capacity + keep/forget lifecycle (A-M4)', () => {
  it('honors the configured capacity for concurrent in-progress runs', () => {
    const reg = new RunRegistry(4)
    const recs: RunRecording[] = []
    for (let i = 0; i < 5; i++) {
      const rec = reg.create()
      rec.append(step(i))
      recs.push(rec)
    }
    // Capacity 4: the 5th live run evicts the OLDEST one, exactly like the
    // historical fixed cap — the point of A-M4 is that callers size the cap
    // from the real concurrency ceiling so live runs are never evicted.
    expect(reg.get(recs[0]?.runId ?? '')).toBeUndefined()
    for (const rec of recs.slice(1)) expect(reg.get(rec.runId)).toBeDefined()
  })

  it('keeps the historical default capacity of 8', () => {
    const reg = new RunRegistry()
    const recs: RunRecording[] = []
    for (let i = 0; i < 9; i++) recs.push(reg.create())
    expect(reg.get(recs[0]?.runId ?? '')).toBeUndefined()
    expect(reg.get(recs[1]?.runId ?? '')).toBeDefined()
    expect(reg.get(recs[8]?.runId ?? '')).toBeDefined()
  })

  it('forget() frees capacity and is idempotent', () => {
    const reg = new RunRegistry(2)
    const a = reg.create()
    const b = reg.create()
    reg.forget(a.runId)
    reg.forget(a.runId)
    const c = reg.create()
    expect(reg.get(a.runId)).toBeUndefined()
    expect(reg.get(b.runId)).toBeDefined()
    expect(reg.get(c.runId)).toBeDefined()
  })

  it('keepForContinuation defaults to false (engine-owned lifecycle flag)', () => {
    expect(new RunRecording('r-flag').keepForContinuation).toBe(false)
  })
})