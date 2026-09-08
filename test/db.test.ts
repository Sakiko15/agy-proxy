// db.ts — SQLite bootstrap (charter §6 crash recovery): WAL + FULL durability,
// user_version-gated schema, checkpoint-on-close. New storage, golden-file free.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, checkpointAndClose, SCHEMA_VERSION } from '../src/server/db.ts'

const dirs: string[] = []
function tempDb(name: string): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-db-'))
  dirs.push(dir)
  const path = join(dir, name)
  return { db: openDb(path), path }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* open WAL handle */ }
  }
})

describe('openDb durability knobs', () => {
  it('enables WAL journal mode', () => {
    const { db } = tempDb('a.db')
    expect((db.pragma('journal_mode', { simple: true }) as string).toLowerCase()).toBe('wal')
    checkpointAndClose(db)
  })

  it('sets synchronous FULL and busy_timeout', () => {
    const { db } = tempDb('b.db')
    expect(db.pragma('synchronous', { simple: true })).toBe(2) // 2 = FULL
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    checkpointAndClose(db)
  })

  it('creates the v%d schema tables'.replace('%d', String(SCHEMA_VERSION)), () => {
    const { db } = tempDb('c.db')
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name)
    for (const t of ['api_keys', 'usage', 'admin_sessions', 'admin_settings']) expect(names).toContain(t)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    checkpointAndClose(db)
  })

  it('re-opens idempotently (user_version gate does not re-create or drop)', () => {
    const { db, path } = tempDb('d.db')
    db.prepare(`CREATE TABLE keep_me (id INTEGER)`).run()
    checkpointAndClose(db)
    const reopened = openDb(path)
    const names = (reopened.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain('keep_me')
    expect(names).toContain('api_keys')
    expect(reopened.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    checkpointAndClose(reopened)
  })

  it('checkpointAndClose truncates the WAL file', async () => {
    const { db, path } = tempDb('e.db')
    db.prepare(`INSERT INTO admin_settings (key, value) VALUES ('k', 'v')`).run()
    checkpointAndClose(db)
    // After a TRUNCATE checkpoint + close, the -wal file is gone or zero-length.
    const { statSync, existsSync } = await import('node:fs')
    const wal = path + '-wal'
    if (existsSync(wal)) expect(statSync(wal).size).toBe(0)
  })
})

describe('usage table idempotency contract', () => {
  it('UNIQUE(request_id) blocks a duplicate insert', () => {
    const { db } = tempDb('f.db')
    const ins = db.prepare(`INSERT INTO usage (request_id, model, family, protocol, status, created_at) VALUES (?, 'm', 'google', 'openai', 'OK', 1)`)
    ins.run('same-id')
    expect(() => ins.run('same-id')).toThrow()
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(1)
    checkpointAndClose(db)
  })
})

/** Build a genuine v1-shaped database by hand: v1 DDL without error_text +
 *  user_version=1 + one already-landed row to prove the upgrade preserves it.
 *  (Module scope: reused by the schema v3 migration suite below.) */
function makeV1Db(path: string): { db: Database.Database; ts: number } {
    const db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL DEFAULT 'default',
        key_hash          TEXT NOT NULL UNIQUE,
        prefix            TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        disabled_at       INTEGER,
        daily_token_limit INTEGER NOT NULL DEFAULT 0,
        rpm_limit         INTEGER NOT NULL DEFAULT 0,
        scopes            TEXT,
        last_used_at      INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage (
        seq               INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id        TEXT NOT NULL UNIQUE,
        key_id            TEXT,
        account_id        TEXT,
        model             TEXT NOT NULL,
        family            TEXT NOT NULL,
        protocol          TEXT NOT NULL CHECK (protocol IN ('openai','anthropic')),
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens  INTEGER,
        cache_read_tokens INTEGER,
        total_tokens      INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL,
        duration_ms       INTEGER,
        created_at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    db.pragma('user_version = 1')
    db.prepare(`INSERT INTO usage (request_id, model, family, protocol, status, created_at) VALUES ('v1-row', 'gemini-3.7-flash', 'google', 'openai', 'OK', 1234)`).run()
    // Legacy M3 rows (pre-M5 drill finding): the constant key marker was
    // stored as the display prefix — a shape the v2 data fix must normalize.
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('kA', 'legacy-a', 'hash-a', 'sk-agy-Qw8n', 10)`).run()
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('kB', 'clean-b', 'hash-b', 'Zx45Kq9p', 20)`).run()
  return { db, ts: 1234 }
}

describe('schema v2 migration (error_text)', () => {
  it('a hand-built v1 database upgrades in place: column attached, rows intact, user_version reaches SCHEMA_VERSION', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-db-mig-'))
    dirs.push(dir)
    const path = join(dir, 'v1.db')
    const v1 = makeV1Db(path)
    v1.db.close()
    const reopened = openDb(path)
    const cols = (reopened.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('error_text')
    expect(reopened.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    // existing rows and their projection survive the ALTER
    const row = reopened.prepare('SELECT request_id, status, error_text FROM usage').get() as { request_id: string; status: string; error_text: string | null }
    expect(row).toEqual({ request_id: 'v1-row', status: 'OK', error_text: null })
    // v2 data fix: the constant marker is stripped from legacy display
    // prefixes (red line: 'sk-agy-' never rests in the DB), clean rows keep
    // their prefix untouched.
    const keys = reopened.prepare('SELECT id, prefix FROM api_keys ORDER BY id').all() as Array<{ id: string; prefix: string }>
    expect(keys).toEqual([
      { id: 'kA', prefix: 'Qw8n' },
      { id: 'kB', prefix: 'Zx45Kq9p' },
    ])
    checkpointAndClose(reopened)
  })

  it('re-running openDb on an upgraded database never re-ALTERs (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-db-mig2-'))
    dirs.push(dir)
    const path = join(dir, 'v1b.db')
    makeV1Db(path).db.close()
    openDb(path).close()
    const third = openDb(path)
    expect(third.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const cols = (third.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols.filter((c) => c === 'error_text')).toHaveLength(1)
    checkpointAndClose(third)
  })
})

describe('schema v3 migration (secret_enc)', () => {
  /** A genuine v2 database: v1 tables + the v2 error_text column +
   *  user_version=2, plus one pre-v3 key row whose plaintext was never kept. */
  function makeV2Db(path: string): Database.Database {
    const { db } = makeV1Db(path)
    db.exec('ALTER TABLE usage ADD COLUMN error_text TEXT')
    db.pragma('user_version = 2')
    db.prepare(`INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES ('k-v2', 'pre-v3', 'hash-v2', 'Qq11Ww22', 30)`).run()
    return db
  }

  it('a v2 database upgrades in place: secret_enc attached, rows intact, legacy row stays NULL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-db-mig3-'))
    dirs.push(dir)
    const path = join(dir, 'v2.db')
    makeV2Db(path).close()
    const reopened = openDb(path)
    expect(reopened.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const cols = (reopened.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols.filter((c) => c === 'secret_enc')).toHaveLength(1)
    const row = reopened.prepare('SELECT id, prefix, secret_enc FROM api_keys WHERE id = ?').get('k-v2') as {
      id: string
      prefix: string
      secret_enc: string | null
    }
    expect(row).toEqual({ id: 'k-v2', prefix: 'Qq11Ww22', secret_enc: null })
    checkpointAndClose(reopened)
  })

  it('re-opening an upgraded v2 database never re-ALTERs (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-db-mig3b-'))
    dirs.push(dir)
    const path = join(dir, 'v2b.db')
    makeV2Db(path).close()
    openDb(path).close()
    const third = openDb(path)
    expect(third.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const cols = (third.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols.filter((c) => c === 'secret_enc')).toHaveLength(1)
    checkpointAndClose(third)
  })

  it('a fresh database gets secret_enc from the DDL', () => {
    const { db } = tempDb('g.db')
    const cols = (db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('secret_enc')
    checkpointAndClose(db)
  })
})