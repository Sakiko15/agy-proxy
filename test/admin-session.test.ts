// ensureAdminPassword bootstrap semantics (code-review #7/#13): the B4/S3
// tolerant-failure paths must never silently rotate or advertise a password.
// - A failed SELECT must not be read as "first boot": the generate branch
//   INSERTs OR REPLACE, which would overwrite a stored hash we could not read.
// - A failed store must not print the one-shot password (it was never saved,
//   so it does not work — the print would just mislead the operator).
// Golden-file free, spawn-free: in-memory-shape SQLite via the real openDb.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { openDb, checkpointAndClose } from '../src/server/db.ts'
import { ensureAdminPassword, verifyAdminPassword } from '../src/server/admin-session.ts'
import { hash } from '@node-rs/argon2'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* open WAL handle */ }
  }
})

function tempDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'agy-adminsess-'))
  dirs.push(dir)
  return openDb(join(dir, 'a.db'))
}

function cfg(adminPassword = ''): () => GatewayConfig {
  const c = { ...defaultConfig(), adminPassword }
  return () => c
}

/** Collects warn messages so tests can assert which lines did/did not fire. */
function logSpy(): { log: { warn: (o: object, m: string) => void }; messages: string[] } {
  const messages: string[] = []
  return { log: { warn: (_o: object, m: string) => messages.push(m) }, messages }
}

/** Proxy whose prepare throws only for the matching SQL — the surrounding
 *  statements stay real so the test can observe what was (not) written. */
function dbWherePrepareFails(db: Database, matchSql: string): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes(matchSql)) throw new Error('injected storage failure')
          return (target as Database).prepare(sql)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as Database
}

describe('ensureAdminPassword bootstrap (B4/S3 tolerant ops + review #7/#13)', () => {
  it('first boot: stores a working hash and prints the one-shot password', async () => {
    const db = tempDb()
    const { log, messages } = logSpy()
    await ensureAdminPassword(db, cfg(), log)
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_password_hash') as { value: string }
    expect(row.value).toContain('$argon2')
    expect(messages.filter((m) => m.includes('shown ONCE'))).toHaveLength(1)
  })

  it('env password wins and never prints a one-shot line', async () => {
    const db = tempDb()
    const { log, messages } = logSpy()
    await ensureAdminPassword(db, cfg('env-pass'), log)
    expect(await verifyAdminPassword(db, 'env-pass')).toBe(true)
    expect(messages.some((m) => m.includes('shown ONCE'))).toBe(false)
  })

  it('stored hash is reused untouched (no silent rotation)', async () => {
    const db = tempDb()
    const stored = await hash('existing-pass')
    db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run('admin_password_hash', stored)
    const { log, messages } = logSpy()
    await ensureAdminPassword(db, cfg(), log)
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_password_hash') as { value: string }
    expect(row.value).toBe(stored)
    expect(messages.some((m) => m.includes('shown ONCE'))).toBe(false)
  })

  it('review #7: a failed lookup skips generation instead of overwriting the stored hash', async () => {
    const db = tempDb()
    const stored = await hash('existing-pass')
    db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run('admin_password_hash', stored)
    const { log, messages } = logSpy()
    // Only the SELECT blows up; a later INSERT would go through unblocked —
    // the assertion is that it never happens.
    await ensureAdminPassword(dbWherePrepareFails(db, 'SELECT'), cfg(), log)
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_password_hash') as { value: string }
    expect(row.value).toBe(stored)
    expect(messages.some((m) => m.includes('skipping first-boot generation'))).toBe(true)
    expect(messages.some((m) => m.includes('shown ONCE'))).toBe(false)
  })

  it('review #13: a failed store warns without printing the one-shot password', async () => {
    const db = tempDb()
    const { log, messages } = logSpy()
    await ensureAdminPassword(dbWherePrepareFails(db, 'INSERT'), cfg(), log)
    const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_password_hash') as { value?: string }
    expect(row?.value).toBeUndefined()
    expect(messages.some((m) => m.includes('no password was generated or stored'))).toBe(true)
    expect(messages.some((m) => m.includes('shown ONCE'))).toBe(false)
  })

  it('env rehash failure keeps its own warn and never prints a one-shot line', async () => {
    const db = tempDb()
    const { log, messages } = logSpy()
    await ensureAdminPassword(dbWherePrepareFails(db, 'INSERT'), cfg('env-pass'), log)
    expect(messages.some((m) => m.includes('rehash failed'))).toBe(true)
    expect(messages.some((m) => m.includes('shown ONCE'))).toBe(false)
  })
})