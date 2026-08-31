// KeyStore — sha256-at-rest + prefix identification, verify verdicts (ok /
// unknown / disabled), lifecycle. Maps to acceptance M3 DoD ⑤ (key lifecycle,
// plaintext-once, sha256 落库验证) and MA4's disabled→403 leg.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb, checkpointAndClose } from '../src/server/db.ts'
import { KeyStore, hashKey, generateApiKey } from '../src/server/key-store.ts'

const dirs: string[] = []
function mkStore(): { store: KeyStore; db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-keys-'))
  dirs.push(dir)
  const path = join(dir, 't.db')
  const db = openDb(path)
  return { store: new KeyStore(db), db, path }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* WAL handles */ }
  }
})

describe('KeyStore create', () => {
  it('generates sk-agy- plaintext and stores ONLY the sha256 hash + 8-char prefix', () => {
    const { store, db, path } = mkStore()
    const created = store.create({ name: 'ci' })
    expect(created.plaintext).toMatch(/^sk-agy-[A-Za-z0-9_-]{32}$/)
    expect(created.prefix).toBe(created.plaintext.slice(0, 8))
    expect(created.name).toBe('ci')
    expect(created.dailyTokenLimit).toBe(0)
    expect(created.disabledAt).toBeNull()

    // sha256-at-rest: the raw file must not contain any part of the plaintext.
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain(created.plaintext)
    expect(raw).not.toContain(created.prefix)
    const row = db.prepare('SELECT key_hash, prefix FROM api_keys WHERE id = ?').get(created.id) as { key_hash: string; prefix: string }
    expect(row.key_hash).toBe(hashKey(created.plaintext))
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/)
    checkpointAndClose(db)
  })

  it('enforces UNIQUE(key_hash): the same plaintext cannot be stored twice', () => {
    const { store, db } = mkStore()
    const { plaintext } = generateApiKey()
    const hash = hashKey(plaintext)
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k1', 'a', ?, 'sk-agy-xx', 1)`).run(hash)
    expect(() => db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k2', 'b', ?, 'sk-agy-yy', 2)`).run(hash)).toThrow()
    expect(store.count()).toBe(1)
    checkpointAndClose(db)
  })

  it('defaults limits to 0 (off) and clamps negative inputs to 0', () => {
    const { store, db } = mkStore()
    const created = store.create({ dailyTokenLimit: -5, rpmLimit: 12 })
    expect(created.dailyTokenLimit).toBe(0)
    expect(created.rpmLimit).toBe(12)
    checkpointAndClose(db)
  })
})

describe('KeyStore verify verdicts', () => {
  it('ok / unknown / disabled', () => {
    const { store, db } = mkStore()
    const created = store.create()
    expect(store.verify(created.plaintext)).toEqual({ verdict: 'ok', key: expect.objectContaining({ id: created.id }) })
    expect(store.verify('sk-agy-not-the-right-key-at-all-00000000')).toEqual({ verdict: 'unknown' })
    store.update(created.id, { disabled: true })
    const disabled = store.verify(created.plaintext)
    expect(disabled.verdict).toBe('disabled')
    if (disabled.verdict === 'disabled') expect(disabled.key.prefix).toBe(created.prefix)
    // Re-enable returns to ok.
    store.update(created.id, { disabled: false })
    expect(store.verify(created.plaintext).verdict).toBe('ok')
    checkpointAndClose(db)
  })
})

describe('KeyStore lifecycle', () => {
  it('list / get / update / remove / touch / count', () => {
    const { store, db } = mkStore()
    const a = store.create({ name: 'one', dailyTokenLimit: 100, rpmLimit: 10 })
    store.create({ name: 'two' })
    expect(store.count()).toBe(2)
    expect(store.list().map((k) => k.name)).toEqual(['one', 'two'])
    expect(store.get('nope')).toBeUndefined()

    const patched = store.update(a.id, { name: 'one-rename', dailyTokenLimit: 200 })
    expect(patched).toMatchObject({ name: 'one-rename', dailyTokenLimit: 200, rpmLimit: 10 })
    // A later patch can change rpmLimit without touching the rest.
    const patched2 = store.update(a.id, { rpmLimit: 30 })
    expect(patched2).toMatchObject({ name: 'one-rename', dailyTokenLimit: 200, rpmLimit: 30 })

    store.touch(a.id)
    expect(store.get(a.id)?.lastUsedAt).not.toBeNull()

    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(store.count()).toBe(1)
    // touch on a removed key is a silent no-op (best-effort contract)
    expect(() => store.touch(a.id)).not.toThrow()
    checkpointAndClose(db)
  })
})