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