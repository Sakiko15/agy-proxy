// API key store (charter §5 L129 names this module; §8/§10 fix the storage
// shape): sha256 hash at rest + 8-char plaintext prefix for identification
// (LiteLLM pattern). High-entropy keys need no slow hash; argon2 is reserved
// for the admin password. Plaintext exists exactly once — in the create()
// return value — and never in a table column, a log line, or a response
// beyond that moment (acceptance M3 DoD: sha256 落库验证).
import { createHash, randomBytes } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  createdAt: number
  disabledAt: number | null
  dailyTokenLimit: number
  rpmLimit: number
  scopes: string | null
  lastUsedAt: number | null
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** The only time the plaintext key leaves this module. */
  plaintext: string
}

export type KeyVerifyResult =
  | { verdict: 'ok'; key: ApiKeyRecord }
  | { verdict: 'unknown' }
  | { verdict: 'disabled'; key: ApiKeyRecord }

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/** The constant plaintext marker — 7 chars. Never stored anywhere. */
export const KEY_MARK = 'sk-agy-'

/**
 * Parse a stored scope list (model ids separated by newline, comma or
 * semicolon) into ids. null or an empty/cleaned-out string means
 * UNRESTRICTED — a key without a configured whitelist serves every model.
 */
export function parseKeyScopes(scopes: string | null | undefined): string[] | null {
  if (scopes === null || scopes === undefined) return null
  const parts = scopes
    .split(/[\n,;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return parts.length > 0 ? parts : null
}

/** `sk-agy-` (KEY_MARK) + 24 random bytes, base64url: 32 url-safe chars of entropy. */
export function generateApiKey(): { plaintext: string; prefix: string } {
  const plaintext = KEY_MARK + randomBytes(24).toString('base64url')
  // The display prefix must come from the SECRET part: the leading `sk-agy-`
  // marker is constant, so slicing from 0 would store that marker in the DB
  // (security red line: it never rests in the DB) and leave the 8-char prefix
  // only 1 distinguishing char.
  return { plaintext, prefix: plaintext.slice(KEY_MARK.length, KEY_MARK.length + 8) }
}

/** B-M2: last_used_at is admin-UI display data, but the refresh used to be
 *  a full autocommit UPDATE (WAL fsync at synchronous=FULL) on every
 *  authenticated request. Writes are debounced to one per key per window;
 *  skipped refreshes land at flushTouch() (shutdown) so the final value is
 *  still exact. */
const TOUCH_DEBOUNCE_MS = 60_000

export class KeyStore {
  private readonly stmtCount: BetterSqlite3.Statement
  private readonly stmtList: BetterSqlite3.Statement
  private readonly stmtGet: BetterSqlite3.Statement
  private readonly stmtByHash: BetterSqlite3.Statement
  private readonly stmtInsert: BetterSqlite3.Statement
  private readonly stmtUpdate: BetterSqlite3.Statement
  private readonly stmtDelete: BetterSqlite3.Statement
  private readonly stmtTouch: BetterSqlite3.Statement
  /** B-M2: id → last written last_used_at; skipped refreshes buffer in
   *  touchPending (latest wins) for flushTouch(). remove() cleans both. */
  private readonly lastWritten = new Map<string, number>()
  private readonly touchPending = new Map<string, number>()

  constructor(private readonly db: BetterSqlite3.Database) {
    // Prepare-once (same pattern as UsageLedger.insertStmt): verify/get ride
    // every request — per-call prepare churned sqlite_stmt objects each time.
    this.stmtCount = db.prepare('SELECT COUNT(*) AS n FROM api_keys')
    this.stmtList = db.prepare('SELECT * FROM api_keys ORDER BY created_at')
    this.stmtGet = db.prepare('SELECT * FROM api_keys WHERE id = ?')
    this.stmtByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    this.stmtInsert = db.prepare(
      `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, daily_token_limit, rpm_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtUpdate = db.prepare(
      'UPDATE api_keys SET name = ?, disabled_at = ?, daily_token_limit = ?, rpm_limit = ?, scopes = ? WHERE id = ?',
    )
    this.stmtDelete = db.prepare('DELETE FROM api_keys WHERE id = ?')
    this.stmtTouch = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n
  }

  create(input: { name?: string; dailyTokenLimit?: number; rpmLimit?: number } = {}): CreatedApiKey {
    const { plaintext, prefix } = generateApiKey()
    const id = 'key_' + randomBytes(4).toString('hex')
    const dailyTokenLimit = positiveIntOrZero(input.dailyTokenLimit)
    const rpmLimit = positiveIntOrZero(input.rpmLimit)
    this.stmtInsert.run(id, input.name?.trim() || 'default', hashKey(plaintext), prefix, Date.now(), dailyTokenLimit, rpmLimit)
    return { ...(this.get(id) as ApiKeyRecord), plaintext }
  }

  list(): readonly ApiKeyRecord[] {
    return (this.stmtList.all() as RawKeyRow[]).map(fromRow)
  }

  get(id: string): ApiKeyRecord | undefined {
    const row = this.stmtGet.get(id) as RawKeyRow | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  /** Hash-lookup the plaintext; a hit with disabled_at set reports 'disabled'. */
  verify(plaintext: string): KeyVerifyResult {
    const row = this.stmtByHash.get(hashKey(plaintext)) as RawKeyRow | undefined
    if (row === undefined) return { verdict: 'unknown' }
    const key = fromRow(row)
    return key.disabledAt !== null ? { verdict: 'disabled', key } : { verdict: 'ok', key }
  }

  update(
    id: string,
    patch: { name?: string; disabled?: boolean; dailyTokenLimit?: number; rpmLimit?: number; scopes?: string | null },
  ): ApiKeyRecord | undefined {
    const current = this.get(id)
    if (current === undefined) return undefined
    const disabledAt = patch.disabled === undefined ? current.disabledAt : patch.disabled ? Date.now() : null
    // scopes: undefined = leave as is; '' or null clears the whitelist (NULL).
    const scopes = patch.scopes === undefined ? current.scopes : patch.scopes === null || patch.scopes === '' ? null : patch.scopes
    this.stmtUpdate.run(
      patch.name?.trim() || current.name,
      disabledAt,
      positiveIntOrZero(patch.dailyTokenLimit ?? current.dailyTokenLimit),
      positiveIntOrZero(patch.rpmLimit ?? current.rpmLimit),
      scopes,
      id,
    )
    return this.get(id)
  }

  remove(id: string): boolean {
    const info = this.stmtDelete.run(id)
    this.lastWritten.delete(id)
    this.touchPending.delete(id)
    return info.changes > 0
  }

  /** Best-effort last_used refresh — never throws into the request path.
   *  B-M2: at most one autocommit fsync per key per TOUCH_DEBOUNCE_MS; the
   *  first-ever touch (and touches after a window) still writes immediately. */
  touch(id: string): void {
    try {
      const now = Date.now()
      const last = this.lastWritten.get(id) ?? 0
      if (now - last < TOUCH_DEBOUNCE_MS) {
        this.touchPending.set(id, now) // latest value wins; flushTouch lands it
        return
      }
      this.writeTouch(id, now)
    } catch {
      // a closed/unavailable DB must not break an authenticated request
    }
  }

  /** Teardown: land the debounced last_used_at refreshes before the DB
   *  closes (index.ts calls it ahead of ledger.close()). Best-effort. */
  flushTouch(): void {
    if (this.touchPending.size === 0) return
    try {
      for (const [id, ts] of this.touchPending) {
        this.stmtTouch.run(ts, id)
        this.lastWritten.set(id, ts)
      }
      this.touchPending.clear()
    } catch {
      // best-effort by contract
    }
  }

  private writeTouch(id: string, ts: number): void {
    this.stmtTouch.run(ts, id)
    this.lastWritten.set(id, ts)
    this.touchPending.delete(id)
  }
}

interface RawKeyRow {
  id: string
  name: string
  key_hash: string
  prefix: string
  created_at: number
  disabled_at: number | null
  daily_token_limit: number
  rpm_limit: number
  scopes: string | null
  last_used_at: number | null
}

function fromRow(r: RawKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
    dailyTokenLimit: r.daily_token_limit,
    rpmLimit: r.rpm_limit,
    scopes: r.scopes,
    lastUsedAt: r.last_used_at,
  }
}

function positiveIntOrZero(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}