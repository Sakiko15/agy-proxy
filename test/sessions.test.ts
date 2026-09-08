// Ported from dsh-agy-link test/sessions.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect; adapted for B2/P5 — set()
// persists on a 500ms debounce now, so cross-instance reads go through the
// new flush() seam, and corrupt files are quarantined instead of silently
// overwritten).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../src/host/sessions.ts'

const dir = mkdtempSync(join(tmpdir(), 'agy-sessions-'))
const file = join(dir, 'sessions.json')

describe('sessions', () => {
  it('set/get roundtrip and persistence across instances', () => {
    const s = new SessionStore(file)
    s.set('s1', { conversationId: 'c1', lastMessageCount: 4, updatedAt: 123, model: 'gemini-3-6-flash' })
    expect(s.get('s1')?.conversationId).toBe('c1')
    // B2/P5: the debounced write must land synchronously via flush().
    s.flush()
    const s2 = new SessionStore(file)
    expect(s2.get('s1')?.lastMessageCount).toBe(4)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect('s1' in raw).toBe(true)
  })

  it('delete removes bindings', () => {
    const s = new SessionStore(file)
    s.set('s2', { conversationId: 'c2', lastMessageCount: 1, updatedAt: 456 })
    s.delete('s2')
    expect(s.get('s2')).toBeUndefined()
  })

  it('corrupted file quarantines and recovers to empty instead of throwing', () => {
    writeFileSync(file, '{not json', 'utf8')
    const logs: string[] = []
    const s = new SessionStore(file, (m) => logs.push(m))
    // B2/P5: start empty (unchanged contract), but the unreadable original is
    // renamed aside instead of being destroyed by the next persist.
    expect(Object.keys(s.all()).length).toBe(0)
    expect(existsSync(file)).toBe(false)
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('sessions.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]!), 'utf8')).toBe('{not json')
    expect(logs.some((m) => m.includes('sessions store quarantined'))).toBe(true)
    s.set('s3', { conversationId: 'c3', lastMessageCount: 0, updatedAt: 1 })
    s.flush()
    expect(new SessionStore(file).get('s3')?.conversationId).toBe('c3')
  })

  it('all returns a readonly snapshot', () => {
    rmSync(file, { force: true })
    const s = new SessionStore(file)
    s.set('a', { conversationId: 'x', lastMessageCount: 0, updatedAt: 1 })
    expect(Object.keys(s.all()).length).toBe(1)
  })
})

describe('sessions debounced persist (B2/P5)', () => {
  it('merges a burst into one deferred write; flush lands pending state', () => {
    const f2 = join(dir, 'sessions-debounce.json')
    vi.useFakeTimers()
    try {
      const s = new SessionStore(f2)
      s.set('d1', { conversationId: 'c1', lastMessageCount: 1, updatedAt: 1 })
      s.set('d2', { conversationId: 'c2', lastMessageCount: 2, updatedAt: 2 })
      s.set('d1', { conversationId: 'c1b', lastMessageCount: 3, updatedAt: 3 })
      // Under the fake clock the 500ms window has not elapsed — nothing on
      // disk yet; the debounce is the whole point of the batching.
      expect(existsSync(f2)).toBe(false)
      vi.advanceTimersByTime(500)
      const raw = JSON.parse(readFileSync(f2, 'utf8')) as Record<string, unknown>
      expect(raw).toMatchObject({ d1: { conversationId: 'c1b' }, d2: { conversationId: 'c2' } })
      // flush() on a clean store is a no-op (idempotent teardown path).
      s.flush()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wrong-shape JSON is quarantined the same as unparseable bytes', () => {
    const f3 = join(dir, 'sessions-shape.json')
    writeFileSync(f3, '42', 'utf8')
    // Valid JSON of a non-object type fails the load guard — the store
    // rebuilds empty and keeps the original aside.
    const s = new SessionStore(f3)
    expect(Object.keys(s.all()).length).toBe(0)
    expect(existsSync(f3)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('sessions-shape.json.corrupt-'))).toBe(true)
  })
})