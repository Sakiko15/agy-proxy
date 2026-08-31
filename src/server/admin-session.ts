// Admin authentication primitives (charter §8 Admin-session row, §10 rules):
// argon2id-verified admin password (the ONLY argon2 use — API keys stay
// sha256), opaque DB-backed sessions (self-made ~50 rows, per charter §8 —
// httpOnly + SameSite=Lax cookie), and the first-boot generate-and-print-once
// password posture that GatewayConfig.adminPassword has documented since M0.
// Hand-rolled cookie parsing keeps the session store dependency-free.
import { createHash, randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import type { Database } from 'better-sqlite3'
import type { GatewayConfig } from '../common/types.ts'

export const ADMIN_COOKIE = 'agy_admin_session'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export interface AdminSession {
  token: string
  expiresAt: number
}

export class AdminSessionStore {
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly db: Database, opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = Math.max(60_000, opts.ttlMs ?? 7 * 86_400_000)
    this.now = opts.now ?? Date.now
  }

  create(): AdminSession {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    // Lazy-sweep expired rows on each create.
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(this.now())
    this.db
      .prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(sha256Hex(token), this.now(), expiresAt)
    return { token, expiresAt }
  }

  verify(token: string): boolean {
    if (token === '') return false
    const tokenHash = sha256Hex(token)
    const row = this.db
      .prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(tokenHash) as { expires_at?: number } | undefined
    if (row === undefined || row.expires_at === undefined) return false
    if (row.expires_at <= this.now()) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash)
      return false
    }
    return true
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256Hex(token))
  }

  revokeAll(): void {
    this.db.prepare('DELETE FROM admin_sessions').run()
  }
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (header === undefined || header === '') return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k !== '') out[k] = decodeURIComponent(v)
  }
  return out
}

export function serializeSetCookie(token: string, expiresAt: number): string {
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`
}

export function serializeClearCookie(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

const SETTINGS_KEY = 'admin_password_hash'

/**
 * Bootstrap the admin password (charter L70 posture): env AGY_PROXY_ADMIN_PASSWORD
 * rehashes and wins on every boot; otherwise the stored hash is reused
 * (password rotation through the DB alone); on first boot with neither, a
 * random password is generated and printed ONCE to the log, stored only as
 * an argon2id hash afterwards.
 */
export async function ensureAdminPassword(
  db: Database,
  getConfig: () => GatewayConfig,
  log: { warn: (o: object, m: string) => void },
): Promise<void> {
  const envPassword = getConfig().adminPassword
  if (envPassword !== '') {
    db.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, await hash(envPassword))
    return
  }
  const existing = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get(SETTINGS_KEY) as { value?: string } | undefined
  if (existing?.value !== undefined) return
  const generated = randomBytes(12).toString('base64url')
  db.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY, await hash(generated))
  log.warn(
    { note: 'this value is shown exactly once and cannot be recovered' },
    `first boot: generated admin password (shown ONCE): ${generated}`,
  )
}

/** argon2id-verify the admin password against the stored hash. */
export async function verifyAdminPassword(db: Database, password: string): Promise<boolean> {
  const row = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get(SETTINGS_KEY) as { value?: string } | undefined
  if (row?.value === undefined) return false
  try {
    return await verify(row.value, password)
  } catch {
    return false
  }
}