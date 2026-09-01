// SQLite bootstrap (charter §6 crash-recovery row, §8 tech stack): one
// better-sqlite3 database holding api_keys, usage ledger rows, admin
// sessions and admin settings. Durability knobs match the charter —
// journal_mode=WAL, synchronous=FULL, busy_timeout — so a SIGKILL'd process
// replays its WAL on the next open and loses at most the last flush window.
// Schema is versioned via PRAGMA user_version; migrations run idempotently.
// New code, not a port. node:sqlite was explicitly rejected in charter §8
// (still experimental on Node 24).
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { KEY_MARK } from './key-store.ts'

export const SCHEMA_VERSION = 2

const DDL = `
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

-- request_id UNIQUE is the ledger idempotency contract (acceptance M3 DoD:
-- a replayed request id must not double count); INSERT OR IGNORE relies on it.
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
-- v2 (M5): terminal failure text for the audit trail. The column is attached
-- by the guarded migration below (PRAGMA table_info) so a v1 database is
-- upgraded in place; fresh databases get it from the DDL only via the same
-- guard (SQLite has no ADD COLUMN IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time     ON usage(created_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  const version = db.pragma('user_version', { simple: true }) as number
  if (version < SCHEMA_VERSION) {
    db.exec(DDL)
    migrateUsageErrorText(db)
    migrateKeyPrefixMarker(db)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }
  return db
}

/** v2 migration: attach usage.error_text when the column is missing — guarded
 *  by PRAGMA table_info so v1 databases upgrade in place, fresh ones no-op,
 *  and a second restart never re-runs the ALTER (SQLite has no
 *  ADD COLUMN IF NOT EXISTS). */
function migrateUsageErrorText(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'error_text')) return
  db.exec('ALTER TABLE usage ADD COLUMN error_text TEXT')
}

/** v2 data fix (M5 drill finding): pre-fix rows stored `sk-agy-` + 1 secret
 *  char as the display prefix — the constant key marker must never rest in
 *  the DB (security red line) and left the prefix only 1 distinguishing
 *  char. Keep the varying tail as the identified prefix (idempotent: fixed
 *  rows no longer match the LIKE). */
function migrateKeyPrefixMarker(db: Database.Database): void {
  db.prepare(`UPDATE api_keys SET prefix = substr(prefix, ${KEY_MARK.length + 1}) WHERE prefix LIKE ? ESCAPE '\\'`).run(
    KEY_MARK.replace(/[-\\%_]/g, (c) => '\\' + c) + '_%',
  )
}

/** Flush the WAL back into the main file and close cleanly (shutdown path). */
export function checkpointAndClose(db: Database.Database): void {
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}