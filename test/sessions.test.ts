// Ported from dsh-agy-link test/sessions.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

  it('corrupted file recovers to empty instead of throwing', () => {
    writeFileSync(file, '{not json', 'utf8')
    const s = new SessionStore(file)
    expect(Object.keys(s.all()).length).toBe(0)
    s.set('s3', { conversationId: 'c3', lastMessageCount: 0, updatedAt: 1 })
    expect(new SessionStore(file).get('s3')?.conversationId).toBe('c3')
  })

  it('all returns a readonly snapshot', () => {
    rmSync(file, { force: true })
    const s = new SessionStore(file)
    s.set('a', { conversationId: 'x', lastMessageCount: 0, updatedAt: 1 })
    expect(Object.keys(s.all()).length).toBe(1)
  })
})
