// API key store (charter §5 L129 names this module; §8/§10 fix the storage
// shape): sha256 hash at rest + 8-char plaintext prefix for identification
// (LiteLLM pattern). High-entropy keys need no slow hash; argon2 is reserved
// for the admin password. Since schema v3 the plaintext additionally rests as
// AES-256-GCM ciphertext (keys.secret_enc), keyed by a volume-local sidecar
// master key (keys-enc.key, auto-generated) so the admin WebUI can copy or
// rotate a key on demand; the hash stays the ONLY auth material and the
// plaintext never reaches a log line (acceptance M3 DoD: sqlite3 查库确认无
// 明文 — ciphertext is not plaintext).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** The moment the plaintext key leaves this module (create / rotate). */
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

const MASTER_KEY_FILE = 'keys-enc.key'

/**
 * Volume-local sidecar master key (32 random bytes, hex) for the reversible
 * secret storage: auto-generated on first use, mode 0600 where the OS honors
 * it (win32 ignores the mode flag and chmod is a no-op — the file still lives
 * on the protected /data volume next to the DB, same backup lifecycle). A DB
 * restored without its sidecar file (or vice versa) makes the stored
 * ciphertext unreadable — deploy.md §5 backs the whole volume for exactly
 * this reason.
 */
export function loadOrCreateMasterKey(dataDir: string): Buffer {
  const file = join(dataDir, MASTER_KEY_FILE)
  try {
    const hex = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex')
  } catch {
    // ENOENT (or unreadable) → generate below
  }
  const hex = randomBytes(32).toString('hex')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(file, hex + '\n', { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // win32: the mode flag above is already a hint; never fail startup here
  }
  return Buffer.from(hex, 'hex')
}

/** iv.ciphertext.authTag — three base64 segments (base64 never contains '.'). */
function sealSecret(master: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', master, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${ct.toString('base64')}.${cipher.getAuthTag().toString('base64')}`
}

/** GCM decrypt; a wrong master key or tampered ciphertext fails the auth tag
 *  and reports null — the caller treats it as "not recoverable". */
function openSecret(master: Buffer, blob: string): string | null {
  const [ivB64, ctB64, tagB64] = blob.split('.')
  if (ivB64 === undefined || ctB64 === undefined || tagB64 === undefined) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
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
  private readonly stmtRotate: BetterSqlite3.Statement
  private readonly stmtUpdate: BetterSqlite3.Statement
  private readonly stmtDelete: BetterSqlite3.Statement
  private readonly stmtTouch: BetterSqlite3.Statement
  /** B-M2: id → last written last_used_at; skipped refreshes buffer in
   *  touchPending (latest wins) for flushTouch(). remove() cleans both. */
  private readonly lastWritten = new Map<string, number>()
  private readonly touchPending = new Map<string, number>()

  /** masterKey (when wired, see loadOrCreateMasterKey) enables the reversible
   *  secret storage; absent → create/rotate store NULL and reveal() reports
   *  null (tests and read-only data dirs keep the legacy show-once behavior). */
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly masterKey?: Buffer,
  ) {
    // Prepare-once (same pattern as UsageLedger.insertStmt): verify/get ride
    // every request — per-call prepare churned sqlite_stmt objects each time.
    this.stmtCount = db.prepare('SELECT COUNT(*) AS n FROM api_keys')
    this.stmtList = db.prepare('SELECT * FROM api_keys ORDER BY created_at')
    this.stmtGet = db.prepare('SELECT * FROM api_keys WHERE id = ?')
    this.stmtByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
    this.stmtInsert = db.prepare(
      `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, daily_token_limit, rpm_limit, secret_enc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtRotate = db.prepare('UPDATE api_keys SET key_hash = ?, prefix = ?, secret_enc = ? WHERE id = ?')
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
    this.stmtInsert.run(
      id,
      input.name?.trim() || 'default',
      hashKey(plaintext),
      prefix,
      Date.now(),
      dailyTokenLimit,
      rpmLimit,
      this.masterKey === undefined ? null : sealSecret(this.masterKey, plaintext),
    )
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

  /** Plaintext for the admin copy affordance — AES-256-GCM decrypt of
   *  secret_enc. null for keys created before reversible storage (legacy
   *  rows, never NULL-sealed), without a wired master key, or on an auth
   *  failure (wrong/tampered) — the WebUI answers with the "regenerate"
   *  hint in all three cases. Never logs. */
  reveal(id: string): string | null {
    const row = this.stmtGet.get(id) as RawKeyRow | undefined
    if (row === undefined || row.secret_enc === null || this.masterKey === undefined) return null
    return openSecret(this.masterKey, row.secret_enc)
  }

  /** Issue a fresh plaintext for an existing key: hash/prefix/secret_enc are
   *  swapped in place, so the OLD value stops verifying immediately while
   *  name/limits/disabled state survive. The new plaintext rides this return
   *  value exactly once. */
  rotate(id: string): CreatedApiKey | undefined {
    const current = this.get(id)
    if (current === undefined) return undefined
    const { plaintext, prefix } = generateApiKey()
    this.stmtRotate.run(
      hashKey(plaintext),
      prefix,
      this.masterKey === undefined ? null : sealSecret(this.masterKey, plaintext),
      id,
    )
    return { ...(this.get(id) as ApiKeyRecord), plaintext }
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
  secret_enc: string | null
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