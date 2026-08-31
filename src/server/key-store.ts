// API key store (charter §5 L129 names this module; §8/§10 fix the storage
// shape): sha256 hash at rest + 8-char plaintext prefix for identification
// (LiteLLM pattern). High-entropy keys need no slow hash; argon2 is reserved
// for the admin password. Plaintext exists exactly once — in the create()
// return value — and never in a table column, a log line, or a response
// beyond that moment (acceptance M3 DoD: sha256 落库验证).
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'

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

/** `sk-agy-` + 24 random bytes, base64url: 32 url-safe chars of entropy. */
export function generateApiKey(): { plaintext: string; prefix: string } {
  const plaintext = 'sk-agy-' + randomBytes(24).toString('base64url')
  return { plaintext, prefix: plaintext.slice(0, 8) }
}

export class KeyStore {
  constructor(private readonly db: Database) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n
  }

  create(input: { name?: string; dailyTokenLimit?: number; rpmLimit?: number } = {}): CreatedApiKey {
    const { plaintext, prefix } = generateApiKey()
    const id = 'key_' + randomBytes(4).toString('hex')
    const dailyTokenLimit = positiveIntOrZero(input.dailyTokenLimit)
    const rpmLimit = positiveIntOrZero(input.rpmLimit)
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, prefix, created_at, daily_token_limit, rpm_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name?.trim() || 'default', hashKey(plaintext), prefix, Date.now(), dailyTokenLimit, rpmLimit)
    return { ...(this.get(id) as ApiKeyRecord), plaintext }
  }

  list(): readonly ApiKeyRecord[] {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as RawKeyRow[]).map(fromRow)
  }

  get(id: string): ApiKeyRecord | undefined {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as RawKeyRow | undefined
    return row === undefined ? undefined : fromRow(row)
  }

  /** Hash-lookup the plaintext; a hit with disabled_at set reports 'disabled'. */
  verify(plaintext: string): KeyVerifyResult {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(plaintext)) as RawKeyRow | undefined
    if (row === undefined) return { verdict: 'unknown' }
    const key = fromRow(row)
    return key.disabledAt !== null ? { verdict: 'disabled', key } : { verdict: 'ok', key }
  }

  update(
    id: string,
    patch: { name?: string; disabled?: boolean; dailyTokenLimit?: number; rpmLimit?: number },
  ): ApiKeyRecord | undefined {
    const current = this.get(id)
    if (current === undefined) return undefined
    const disabledAt = patch.disabled === undefined ? current.disabledAt : patch.disabled ? Date.now() : null
    this.db
      .prepare(`UPDATE api_keys SET name = ?, disabled_at = ?, daily_token_limit = ?, rpm_limit = ? WHERE id = ?`)
      .run(
        patch.name?.trim() || current.name,
        disabledAt,
        positiveIntOrZero(patch.dailyTokenLimit ?? current.dailyTokenLimit),
        positiveIntOrZero(patch.rpmLimit ?? current.rpmLimit),
        id,
      )
    return this.get(id)
  }

  remove(id: string): boolean {
    const info = this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
    return info.changes > 0
  }

  /** Best-effort last_used refresh — never throws into the request path. */
  touch(id: string): void {
    try {
      this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id)
    } catch {
      // a closed/unavailable DB must not break an authenticated request
    }
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