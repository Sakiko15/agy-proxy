// KeyStore — sha256-at-rest + prefix identification, verify verdicts (ok /
// unknown / disabled), lifecycle. Maps to acceptance M3 DoD ⑤ (key lifecycle,
// plaintext-once, sha256 落库验证) and MA4's disabled→403 leg.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb, checkpointAndClose } from '../src/server/db.ts'
import { KeyStore, hashKey, generateApiKey, loadOrCreateMasterKey } from '../src/server/key-store.ts'

const dirs: string[] = []
function mkStore(opts: { master?: boolean } = {}): { store: KeyStore; db: Database; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-keys-'))
  dirs.push(dir)
  const path = join(dir, 't.db')
  const db = openDb(path)
  // master: true → production wiring (the temp dir doubles as the data dir,
  // so keys-enc.key is generated exactly like index.ts does).
  return { store: new KeyStore(db, opts.master === true ? loadOrCreateMasterKey(dir) : undefined), db, path, dir }
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
    // M5 red-line fix: the prefix derives from the SECRET part (after the
    // constant 'sk-agy-' marker) — the marker itself never rests in the DB
    // and the prefix stays 8 distinguishing chars.
    expect(created.prefix).toBe(created.plaintext.slice(7, 15))
    expect(created.prefix).toMatch(/^[A-Za-z0-9_-]{8}$/)
    expect(created.prefix).not.toContain('sk-agy-')
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
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k1', 'a', ?, 'legacy-fix', 1)`).run(hash)
    expect(() => db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k2', 'b', ?, 'legacy-fix2', 2)`).run(hash)).toThrow()
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

describe('KeyStore touch debounce (B-M2)', () => {
  it('the first touch writes immediately; repeats inside the window only buffer', () => {
    const { store } = mkStore()
    const a = store.create({ name: 'deb' })
    store.touch(a.id)
    const first = store.get(a.id)?.lastUsedAt ?? null
    expect(first).not.toBeNull()

    // A repeat inside the 60s window must NOT fire the autocommit UPDATE.
    // Fast CI runners land the two touches inside one wall-clock millisecond,
    // which would buffer the SAME timestamp the first touch wrote and turn
    // the flush assertion below into a coin flip — pin the second touch 1s
    // later (still inside the window, so the debounce branch is exercised).
    const realNow = Date.now
    Date.now = () => (first ?? 0) + 1000
    try {
      store.touch(a.id) // debounced → pending
    } finally {
      Date.now = realNow
    }
    expect(store.get(a.id)?.lastUsedAt).toBe(first)

    // The skipped refresh still lands at flushTouch (teardown contract) with
    // the latest observed timestamp.
    store.flushTouch()
    expect(store.get(a.id)?.lastUsedAt).not.toBe(first)
  })

  it('remove() drops the touch bookkeeping so a later flush writes nothing stale', () => {
    const { store, db } = mkStore()
    const a = store.create({ name: 'gone' })
    store.touch(a.id) // writes + starts the window
    store.touch(a.id) // debounced → pending
    expect(store.remove(a.id)).toBe(true)
    store.flushTouch() // must be a silent no-op, not resurrect the row
    const rows = (db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n
    expect(rows).toBe(0)
    checkpointAndClose(db)
  })
})

describe('KeyStore reversible storage (schema v3 secret_enc)', () => {
  it('create → reveal round-trips; the raw DB file never carries the plaintext', () => {
    const { store, db, path } = mkStore({ master: true })
    const created = store.create({ name: 'rev' })
    expect(store.reveal(created.id)).toBe(created.plaintext)

    // The ciphertext is three dot-separated base64 segments (iv.ct.authTag —
    // '.' never appears inside base64, so the split is unambiguous).
    const row = db.prepare('SELECT secret_enc FROM api_keys WHERE id = ?').get(created.id) as { secret_enc: string | null }
    expect(row.secret_enc).not.toBeNull()
    expect(row.secret_enc?.split('.')).toHaveLength(3)

    // Reversible storage keeps the M3 DoD intact: cipher ≠ plaintext, so a
    // raw sqlite3 dump still shows no key material (only the ciphertext).
    checkpointAndClose(db) // WAL → main file so the file scan is meaningful
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain(created.plaintext)
  })

  it('loadOrCreateMasterKey generates once per data dir and reuses the same key', () => {
    const { dir } = mkStore({ master: true })
    const first = loadOrCreateMasterKey(dir)
    const again = loadOrCreateMasterKey(dir)
    expect(again.equals(first)).toBe(true)
    expect(first).toHaveLength(32) // 32 bytes → AES-256
    // A different data dir gets an independent key (volume-local trust).
    const other = mkStore({ master: true })
    expect(loadOrCreateMasterKey(other.dir).equals(first)).toBe(false)
    // The sidecar file holds 64 hex chars + newline, readable as-is.
    const file = readFileSync(join(dir, 'keys-enc.key'), 'utf8').trim()
    expect(file).toMatch(/^[0-9a-f]{64}$/)
  })

  it('code-review #3: a missing sidecar is generated and lands on disk atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-mk-'))
    dirs.push(dir)
    const key = loadOrCreateMasterKey(dir)
    expect(key).toHaveLength(32)
    const raw = readFileSync(join(dir, 'keys-enc.key'), 'utf8')
    expect(raw.trim()).toMatch(/^[0-9a-f]{64}$/)
    // tmp+rename: the staging file is gone after the rename.
    expect(existsSync(join(dir, 'keys-enc.key.tmp'))).toBe(false)
  })

  it('code-review #3: a corrupt sidecar throws instead of regenerating (loud-fail contract)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-mk-'))
    dirs.push(dir)
    const file = join(dir, 'keys-enc.key')
    writeFileSync(file, 'deadbeef-not-hex\n')
    expect(() => loadOrCreateMasterKey(dir)).toThrow(/refusing to regenerate/)
    // The corrupt file is left exactly as-is — a silent regeneration would
    // orphan every AES ciphertext in the DB.
    expect(readFileSync(file, 'utf8')).toBe('deadbeef-not-hex\n')
  })

  it('code-review #3: an unreadable (non-ENOENT) sidecar throws too — never regenerate over it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-mk-'))
    dirs.push(dir)
    // A directory where the sidecar should be: readFileSync fails with
    // EISDIR — not ENOENT — so generation must be refused, not bulldozed.
    mkdirSync(join(dir, 'keys-enc.key'))
    expect(() => loadOrCreateMasterKey(dir)).toThrow()
    // The impostor entry is untouched.
    expect(existsSync(join(dir, 'keys-enc.key'))).toBe(true)
  })

  it('a store without a master key keeps legacy semantics: secret_enc NULL, reveal null', () => {
    const { store, db } = mkStore()
    const created = store.create({ name: 'legacy-wiring' })
    const row = db.prepare('SELECT secret_enc FROM api_keys WHERE id = ?').get(created.id) as { secret_enc: string | null }
    expect(row.secret_enc).toBeNull()
    expect(store.reveal(created.id)).toBeNull()
    checkpointAndClose(db)
  })

  it('a legacy row (secret_enc NULL) reveals null even with a master key', () => {
    const { store, db } = mkStore({ master: true })
    // Hand-built pre-v3 row: the plaintext was never stored, so there is
    // nothing to decrypt — the WebUI points these at "Regenerate".
    const { plaintext, prefix } = generateApiKey()
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k-legacy', 'pre-v3', ?, ?, 1)`).run(hashKey(plaintext), prefix)
    expect(store.verify(plaintext).verdict).toBe('ok') // the row is a real, working key
    expect(store.reveal('k-legacy')).toBeNull()
    checkpointAndClose(db)
  })

  it('a wrong master key fails GCM auth → reveal null (never garbage plaintext)', () => {
    const { store, db } = mkStore({ master: true })
    const created = store.create({ name: 'wrong-key' })
    const wrongStore = new KeyStore(db, randomBytes(32))
    expect(wrongStore.reveal(created.id)).toBeNull()
    checkpointAndClose(db)
  })

  it('tampering with the ciphertext fails GCM auth → reveal null', () => {
    const { store, db } = mkStore({ master: true })
    const created = store.create({ name: 'tamper' })
    // Corrupt the IV segment: identical key + broken ciphertext must not
    // decrypt to anything (auth tag mismatch).
    db.prepare(`UPDATE api_keys SET secret_enc = 'AAAA.' || secret_enc WHERE id = ?`).run(created.id)
    expect(store.reveal(created.id)).toBeNull()
    checkpointAndClose(db)
  })

  it('rotate invalidates the old plaintext and re-arms reversible storage', () => {
    const { store, db } = mkStore({ master: true })
    const created = store.create({ name: 'rot', dailyTokenLimit: 100, rpmLimit: 10 })
    const rotated = store.rotate(created.id)
    expect(rotated).toBeDefined()
    const { plaintext, prefix } = rotated as { plaintext: string; prefix: string }
    expect(plaintext).not.toBe(created.plaintext)
    expect(plaintext).toMatch(/^sk-agy-[A-Za-z0-9_-]{32}$/)
    expect(prefix).toBe(plaintext.slice(7, 15))
    expect(prefix).not.toBe(created.prefix)

    // Auth material swaps atomically: old → unknown, new → ok.
    expect(store.verify(created.plaintext).verdict).toBe('unknown')
    expect(store.verify(plaintext).verdict).toBe('ok')
    // The fresh copy is revealable; limits untouched by the rotation.
    expect(store.reveal(created.id)).toBe(plaintext)
    expect(store.get(created.id)).toMatchObject({ dailyTokenLimit: 100, rpmLimit: 10 })
    checkpointAndClose(db)
  })

  it('rotate on an unknown id → undefined', () => {
    const { store, db } = mkStore({ master: true })
    expect(store.rotate('key_nope')).toBeUndefined()
    checkpointAndClose(db)
  })
})