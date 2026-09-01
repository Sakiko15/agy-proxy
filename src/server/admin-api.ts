// Admin API (charter §5 L129 names this module; §9 gives it the WebUI in M4
// — M3 ships the JSON surface only). Guard chain per request, in order:
//   1. CIDR allowlist (cfg.adminAllowCidr, re-read per request; empty = any),
//      resolved against request.ip (Fastify's trustProxy maps TRUSTED_PROXIES
//      to the real client IP first);
//   2. session cookie (POST /admin/login exempt);
//   3. CSRF: mutating methods must carry a non-empty x-requested-with header
//      (defense-in-depth next to SameSite=Lax, per charter §10).
// All responses are plain JSON ({ok, error?}) — deliberately not
// OpenAI/Anthropic-shaped, since isAnthropicPath never matches /admin.
// Token material rules (charter §10): OAuth token files are never read here,
// key plaintext rides the create response exactly once and is never logged,
// and no route exposes key_hash or session tokens.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { Logger } from 'pino'
import type { GatewayConfig } from '../common/types.ts'
import type { ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { QuotaService } from '../host/quota.ts'
import type { PoolAuthFlow } from '../host/pool-auth.ts'
import type { ModelCatalog } from '../host/models.ts'
import type { KeyStore } from './key-store.ts'
import type { UsageLedger } from './usage-ledger.ts'
import type { AdminSessionStore } from './admin-session.ts'
import { parseCookieHeader, serializeClearCookie, serializeSetCookie } from './admin-session.ts'
import { sanitizeSettings, settingsView, writeOverridesPatch } from './settings.ts'
import { SseWriter } from './sse.ts'
import type { AdminEventBus, AdminEvent } from './events.ts'

export interface AdminDeps {
  getConfig: () => GatewayConfig
  log: Logger
  pool: AccountPoolManager
  quota: QuotaService
  poolAuth: PoolAuthFlow
  keys: KeyStore
  ledger: UsageLedger
  sessions: AdminSessionStore
  catalog: ModelCatalog
  /** M4 admin event bus; absent → the JSON-only surface (M3 shape). */
  events?: AdminEventBus
  /** argon2 verify against the stored admin hash (wired in index.ts). */
  verifyPassword: (password: string) => Promise<boolean>
}

type AdminInstance = FastifyInstance<any, any, any, Logger, any>

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MODEL_FAMILIES: ReadonlySet<string> = new Set(['google', 'anthropic', 'openai', 'unknown'])

// ---- CIDR allowlist -------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out = (out << 8) + n
  }
  return out >>> 0
}

/** Normalize ::1 and IPv4-mapped ::ffff:a.b.c.d to plain IPv4 when possible. */
export function normalizeIp(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  if (ip === '::1') return '127.0.0.1'
  return ip
}

/**
 * IPv4 CIDR match for the admin allowlist. IPv6 literals other than the two
 * normalized aliases above never match (conservative); an allowlist of only
 * IPv6 entries would deny all IPv4 traffic — documented in README.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/')
  const bits = bitsRaw !== undefined && bitsRaw !== '' ? Number(bitsRaw) : 32
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range ?? '')
  if (ipInt === null || rangeInt === null) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return ((ipInt & mask) >>> 0) === ((rangeInt & mask) >>> 0)
}

function ipAllowed(ip: string, allowlist: string): boolean {
  const entries = allowlist.split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (entries.length === 0) return true
  const normalized = normalizeIp(ip)
  return entries.some((cidr) => ipInCidr(normalized, cidr))
}

// ---- route registration -----------------------------------------------------------

export function registerAdminApi(app: AdminInstance, deps: AdminDeps): void {
  const guarded = (opts: { mutating?: boolean; skipSession?: boolean } = {}) => ({
    preHandler: async (request: FastifyRequest<any>, reply: FastifyReply) => {
      const cfg = deps.getConfig()
      if (!ipAllowed(request.ip, cfg.adminAllowCidr)) {
        await reply.code(403).send({ ok: false, error: 'forbidden by admin allowlist' })
        return
      }
      if (!opts.skipSession) {
        const cookies = parseCookieHeader(request.headers.cookie)
        if (!deps.sessions.verify(cookies['agy_admin_session'] ?? '')) {
          await reply.code(401).send({ ok: false, error: 'unauthorized — POST /admin/login first' })
          return
        }
      }
      if (opts.mutating === true && MUTATING.has(request.method) && request.headers['x-requested-with'] === undefined) {
        await reply.code(403).send({ ok: false, error: 'missing x-requested-with header (CSRF guard)' })
      }
    },
  })

  // ---- session ----
  app.post('/admin/login', guarded({ skipSession: true, mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { password?: unknown }
    const ok = typeof body.password === 'string' && body.password !== '' && (await deps.verifyPassword(body.password))
    if (!ok) {
      await new Promise((r) => setTimeout(r, 300)) // brute-force damping (deliberately capped)
      await reply.code(401).send({ ok: false, error: 'invalid password' })
      return reply
    }
    const session = deps.sessions.create()
    await reply
      .code(200)
      .header('set-cookie', serializeSetCookie(session.token, session.expiresAt))
      .send({ ok: true, expiresAt: session.expiresAt })
    return reply
  })

  app.post('/admin/logout', guarded({ mutating: true }), async (request, reply) => {
    const cookies = parseCookieHeader(request.headers.cookie)
    deps.sessions.revoke(cookies['agy_admin_session'] ?? '')
    await reply.code(200).header('set-cookie', serializeClearCookie()).send({ ok: true })
    return reply
  })

  app.get('/admin/me', guarded(), async (_request, reply) => {
    await reply.code(200).send({ ok: true })
    return reply
  })

  // ---- SSE event stream (M4; charter §9: 实时数据全部 SSE + Last-Event-ID
  // 续传). EventSource rides the session cookie same-origin; GET needs no
  // CSRF header. Reconnect semantics are snapshot XOR replay — never both. ----
  app.get('/admin/events', guarded(), async (request, reply) => {
    const bus = deps.events
    if (bus === undefined) {
      await reply.code(404).send({ ok: false, error: 'event stream is not wired up (no event bus)' })
      return reply
    }
    const cfg = deps.getConfig()
    const sse = new SseWriter(reply, { heartbeatMs: cfg.sseHeartbeatMs, keepalive: () => ': ping\n\n' })
    await sse.open()

    // Idempotent teardown in both orders: the socket closes first (raw 'close'
    // resolves sse.done) or closeAll() fires the registered end callback.
    const unsubscribe = bus.subscribe((ev: AdminEvent) => {
      void sse.event(ev.type, ev, ev.seq).catch(() => undefined)
    })
    const registerRef = bus.registerClient(() => end())
    let ended = false
    function end(): void {
      if (ended) return
      ended = true
      registerRef()
      unsubscribe()
      void sse.close().catch(() => undefined)
    }
    void sse.done.then(end, end)

    // Initial delivery: replay what the client missed, otherwise a snapshot.
    const header = request.headers['last-event-id']
    const lastRaw = Array.isArray(header) ? header[0] : header
    const last = typeof lastRaw === 'string' && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null
    if (last === null || !bus.canReplayFrom(last)) {
      const snap = bus.publishSnapshot()
      await sse.event('snapshot', snap, snap.seq).catch(() => undefined)
    } else {
      for (const ev of bus.replayAfter(last)) await sse.event(ev.type, ev, ev.seq).catch(() => undefined)
    }
    return reply
  })

  // ---- status snapshot (the M4 dashboard feeds on this; never includes
  // token/key material — see docs/SECURITY posture in charter §10) ----
  app.get('/admin/status', guarded(), async (_request, reply) => {
    const cfg = deps.getConfig()
    const poolData = deps.pool.getPoolData()
    const catalog = deps.catalog.get()
    await reply.code(200).send({
      ok: true,
      gateway: { enabled: cfg.enabled, permissionMode: cfg.permissionMode, maxConcurrent: cfg.maxConcurrent, maxQueueDepth: cfg.maxQueueDepth },
      pool: {
        mode: poolData.mode,
        accounts: poolData.accounts.map((a) => ({
          id: a.id,
          alias: a.alias,
          email: a.email ?? null,
          enabled: a.enabled,
          lastUsedAt: a.lastUsedAt ?? null,
          authRequired: a.authRequired ?? null,
          cooldowns: a.cooldowns ?? {},
          quotas: a.quotas ?? {},
        })),
      },
      poolAuth: deps.poolAuth.status(),
      catalog: { source: catalog.source, count: catalog.models.length },
      keys: { count: deps.keys.count() },
      usage: { today: deps.ledger.summarizeToday() },
    })
    return reply
  })

  // ---- pool ----
  app.get('/admin/pool', guarded(), async (_request, reply) => {
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  app.post('/admin/pool/auth/begin', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { alias?: unknown; proxyUrl?: unknown }
    const status = await deps.poolAuth.begin(
      typeof body.alias === 'string' && body.alias !== '' ? body.alias : undefined,
      typeof body.proxyUrl === 'string' && body.proxyUrl !== '' ? body.proxyUrl : undefined,
    )
    const code = status.phase === 'failed' ? 500 : 200
    await reply.code(code).send({ ...status, ok: status.phase !== 'failed' })
    return reply
  })

  app.get('/admin/pool/auth/status', guarded(), async (_request, reply) => {
    await reply.code(200).send({ ...deps.poolAuth.status(), ok: deps.poolAuth.status().phase !== 'failed' })
    return reply
  })

  app.post('/admin/pool/auth/complete', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { code?: unknown }
    if (typeof body.code !== 'string' || body.code.trim() === '') {
      await reply.code(400).send({ ok: false, error: 'code is required (paste the full callback URL or the bare authorization code)' })
      return reply
    }
    const status = await deps.poolAuth.submitCode(body.code.trim())
    const code = status.phase === 'done' ? 200 : status.ok === false ? 400 : 200
    await reply.code(code).send({ pool: deps.pool.getPoolData(), ...status, ok: status.phase === 'done' })
    return reply
  })

  app.post('/admin/pool/auth/cancel', guarded({ mutating: true }), async (_request, reply) => {
    await deps.poolAuth.cancel()
    await reply.code(200).send({ ok: true, ...deps.poolAuth.status() })
    return reply
  })

  app.get('/admin/pool/auth/qr', guarded(), async (_request, reply) => {
    const status = deps.poolAuth.status()
    // Gate on the WAITING phase, not just a url: a cancelled flow resets the
    // phase via a merge (status.url can linger stale until the next begin).
    if (status.phase !== 'waiting' || status.url === undefined || status.url === '') {
      await reply.code(404).send({ ok: false, error: 'no login flow is waiting — POST /admin/pool/auth/begin first' })
      return reply
    }
    const png = await QRCode.toBuffer(status.url, { type: 'png', width: 320 })
    await reply.code(200).header('content-type', 'image/png').header('cache-control', 'no-store').send(png)
    return reply
  })

  // ---- pool accounts ----
  app.patch('/admin/pool/accounts/:id', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { alias?: unknown; enabled?: unknown; proxyUrl?: unknown }
    if (deps.pool.getAccount(id) === undefined) {
      await reply.code(404).send({ ok: false, error: 'unknown account id' })
      return reply
    }
    if (typeof body.alias === 'string' && body.alias !== '') deps.pool.setAccountAlias(id, body.alias)
    if (body.proxyUrl === null || typeof body.proxyUrl === 'string') {
      deps.pool.setAccountProxy(id, body.proxyUrl === null ? undefined : body.proxyUrl)
    }
    if (typeof body.enabled === 'boolean') deps.pool.setAccountEnabled(id, body.enabled)
    await reply.code(200).send({ ok: true, account: deps.pool.getAccount(id) })
    return reply
  })

  app.delete('/admin/pool/accounts/:id', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!deps.pool.deleteAccount(id)) {
      await reply.code(404).send({ ok: false, error: 'unknown account id' })
      return reply
    }
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  app.post('/admin/pool/accounts/:id/clear-cooldown', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { family?: unknown }
    const family = typeof body.family === 'string' && MODEL_FAMILIES.has(body.family) ? (body.family as ModelFamily) : undefined
    deps.pool.clearCooldown(id, family)
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  // M5: undo an auth/VALIDATION_REQUIRED quarantine once the account actually
  // re-logged (or the quarantine was a misfire) — without this, isolation is
  // one-way: recordSuccess can never reach an unselectable account.
  app.post('/admin/pool/accounts/:id/clear-auth', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    if (deps.pool.getAccount(id) === undefined) {
      await reply.code(404).send({ ok: false, error: 'unknown account id' })
      return reply
    }
    deps.pool.clearAuthRequired(id)
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  app.post('/admin/pool/accounts/:id/refresh-quota', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    const account = deps.pool.getAccount(id)
    if (account === undefined) {
      await reply.code(404).send({ ok: false, error: 'unknown account id' })
      return reply
    }
    await deps.quota.refreshAccountQuota(account, true)
    void deps.catalog.forceRefresh().catch(() => undefined)
    await reply.code(200).send({ ok: true, account: deps.pool.getAccount(id) })
    return reply
  })

  app.post('/admin/pool/quota/refresh', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { force?: unknown }
    await deps.quota.refreshAllQuotas(body.force !== false)
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  app.post('/admin/pool/mode', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { mode?: unknown }
    if (body.mode !== 'sequential' && body.mode !== 'round-robin') {
      await reply.code(400).send({ ok: false, error: "mode must be 'sequential' or 'round-robin'" })
      return reply
    }
    deps.pool.setMode(body.mode)
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  app.post('/admin/pool/reorder', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown }
    if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      await reply.code(400).send({ ok: false, error: 'ids must be a string array' })
      return reply
    }
    if (!deps.pool.reorderAccounts(body.ids as string[])) {
      await reply.code(400).send({ ok: false, error: 'ids must reference existing accounts exactly' })
      return reply
    }
    await reply.code(200).send({ ok: true, pool: deps.pool.getPoolData() })
    return reply
  })

  // ---- keys ----
  app.get('/admin/keys', guarded(), async (_request, reply) => {
    await reply.code(200).send({
      ok: true,
      keys: deps.keys.list().map((k) => ({ ...k, tokensToday: deps.ledger.tokensUsedToday(k.id) })),
    })
    return reply
  })

  app.post('/admin/keys', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; dailyTokenLimit?: unknown; rpmLimit?: unknown }
    const created = deps.keys.create({
      ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
      ...(typeof body.dailyTokenLimit === 'number' && Number.isFinite(body.dailyTokenLimit) ? { dailyTokenLimit: body.dailyTokenLimit } : {}),
      ...(typeof body.rpmLimit === 'number' && Number.isFinite(body.rpmLimit) ? { rpmLimit: body.rpmLimit } : {}),
    })
    // plaintext rides this response exactly once; it is never logged anywhere.
    await reply.code(201).send({ ok: true, key: { ...keyWithoutPlaintext(created) }, plaintext: created.plaintext })
    return reply
  })

  app.patch('/admin/keys/:id', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { name?: unknown; disabled?: unknown; dailyTokenLimit?: unknown; rpmLimit?: unknown; scopes?: unknown }
    const updated = deps.keys.update(id, {
      ...(typeof body.name === 'string' && body.name !== '' ? { name: body.name } : {}),
      ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
      ...(typeof body.dailyTokenLimit === 'number' && Number.isFinite(body.dailyTokenLimit) ? { dailyTokenLimit: body.dailyTokenLimit } : {}),
      ...(typeof body.rpmLimit === 'number' && Number.isFinite(body.rpmLimit) ? { rpmLimit: body.rpmLimit } : {}),
      // M5 scopes: string sets the model whitelist ('' clears it → NULL),
      // explicit null also clears; absent/other types leave it untouched.
      ...(typeof body.scopes === 'string' ? { scopes: body.scopes } : {}),
      ...(body.scopes === null ? { scopes: null } : {}),
    })
    if (updated === undefined) {
      await reply.code(404).send({ ok: false, error: 'not found' })
      return reply
    }
    await reply.code(200).send({ ok: true, key: updated })
    return reply
  })

  app.delete('/admin/keys/:id', guarded({ mutating: true }), async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!deps.keys.remove(id)) {
      await reply.code(404).send({ ok: false, error: 'not found' })
      return reply
    }
    await reply.code(200).send({ ok: true })
    return reply
  })

  // ---- usage ----
  app.get('/admin/usage', guarded(), async (request, reply) => {
    const q = request.query as Record<string, string | string[] | undefined>
    const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)
    const num = (v: string | string[] | undefined): number | undefined => {
      const s = one(v)
      if (s === undefined || s === '') return undefined
      const n = Number(s)
      return Number.isFinite(n) ? n : undefined
    }
    const keyId = one(q.keyId)
    const model = one(q.model)
    const family = one(q.family)
    const from = num(q.from)
    const to = num(q.to)
    const limit = num(q.limit)
    const offset = num(q.offset)
    const res = deps.ledger.query({
      ...(keyId !== undefined && keyId !== '' ? { keyId } : {}),
      ...(model !== undefined && model !== '' ? { model } : {}),
      ...(family !== undefined && family !== '' ? { family } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    })
    await reply.code(200).send({ ok: true, total: res.total, rows: res.rows })
    return reply
  })

  app.get('/admin/usage/summary', guarded(), async (_request, reply) => {
    await reply.code(200).send({ ok: true, today: deps.ledger.summarizeToday() })
    return reply
  })

  // ---- settings (M4: the WebUI settings page writes runtime-overrides.json;
  // env vars always win per resolveConfig, so a locked key is reported in
  // envLocked rather than rejected — see settings.ts) ----
  app.get('/admin/settings', guarded(), async (_request, reply) => {
    await reply.code(200).send({ ok: true, ...settingsView() })
    return reply
  })

  app.put('/admin/settings', guarded({ mutating: true }), async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const parsed = sanitizeSettings(body)
    if (!parsed.ok) {
      await reply.code(400).send({ ok: false, error: parsed.error })
      return reply
    }
    writeOverridesPatch(parsed.patch)
    await reply.code(200).send({ ok: true, ...settingsView() })
    return reply
  })
}

/**
 * Strip the one-time plaintext from a created key record before echoing it
 * back inside the `key` field (only the sibling `plaintext` field carries it).
 */
function keyWithoutPlaintext<T extends { plaintext?: string }>(created: T): Omit<T, 'plaintext'> {
  const out = { ...created } as Record<string, unknown>
  delete out.plaintext
  return out as Omit<T, 'plaintext'>
}