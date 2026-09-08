// UsageLedger — buffered batched writes, request-id idempotency (DoD ⑥),
// local-midnight day budget (MA5), query filters, post-close no-op.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, checkpointAndClose } from '../src/server/db.ts'
import { UsageLedger, type UsageRecord } from '../src/server/usage-ledger.ts'

const dirs: string[] = []
function mkLedger(ledgerOpts: { flushIntervalMs?: number; now?: () => number; log?: (msg: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ledger-'))
  dirs.push(dir)
  const db = openDb(join(dir, 't.db'))
  return { ledger: new UsageLedger(db, ledgerOpts), db }
}

const REC_BASE: Omit<UsageRecord, 'requestId'> = {
  keyId: null,
  accountId: null,
  model: 'gemini-3.7-flash',
  family: 'google',
  protocol: 'openai',
  promptTokens: 10,
  completionTokens: 5,
  status: 'OK',
}

function rec(requestId: string, patch: Partial<UsageRecord> = {}): UsageRecord {
  return { ...REC_BASE, requestId, ...patch }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* open handles */ }
  }
})

describe('buffer + flush', () => {
  it('record() buffers; flush() lands rows in one batch', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('r1'))
    ledger.record(rec('r2'))
    expect(ledger.pending).toBe(2)
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(0)
    await ledger.flush()
    expect(ledger.pending).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(2)
    checkpointAndClose(db)
  })

  it('total_tokens = prompt + completion in the landed row', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('r-usage', { reasoningTokens: 3, cacheReadTokens: 4 }))
    await ledger.flush()
    const row = db
      .prepare('SELECT prompt_tokens, completion_tokens, total_tokens, reasoning_tokens, cache_read_tokens FROM usage')
      .get() as {
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      reasoning_tokens: number
      cache_read_tokens: number
    }
    expect(row).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 3, cache_read_tokens: 4 })
    checkpointAndClose(db)
  })

  it('a 500-row backlog triggers an opportunistic flush', async () => {
    const { ledger } = mkLedger()
    for (let i = 0; i < 500; i++) ledger.record(rec('bulk-' + i))
    await new Promise((r) => setTimeout(r, 20))
    expect(ledger.pending).toBeLessThanOrEqual(1)
  })

  it('errorText lands in its column, truncated to 500 chars (schema v2)', async () => {
    const { ledger, db } = mkLedger()
    const long = 'x'.repeat(600)
    ledger.record(rec('err-1', { status: 'PROCESS_EXIT', errorText: long }))
    ledger.record(rec('ok-1'))
    await ledger.flush()
    const rows = db
      .prepare('SELECT request_id, error_text, LENGTH(error_text) AS n FROM usage ORDER BY request_id')
      .all() as Array<{ request_id: string; error_text: string | null; n: number | null }>
    const fail = rows.find((r) => r.request_id === 'err-1')
    const ok = rows.find((r) => r.request_id === 'ok-1')
    expect(fail?.error_text).toBe(long.slice(0, 500))
    expect(fail?.n).toBe(500)
    expect(ok?.error_text ?? null).toBe(null)
    // the query projection carries it for GET /admin/usage rows
    const q = ledger.query({}).rows.find((r) => r.requestId === 'err-1')
    expect(q?.errorText).toBe(long.slice(0, 500))
    checkpointAndClose(db)
  })
})

describe('request-id idempotency (DoD ⑥)', () => {
  it('the same requestId recorded twice lands exactly one row', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('replay-1', { promptTokens: 10 }))
    ledger.record(rec('replay-1', { promptTokens: 10 }))
    await ledger.flush()
    expect((db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE request_id = 'replay-1'`).get() as { n: number }).n).toBe(1)
    checkpointAndClose(db)
  })

  it('a missing requestId is filled with a random UUID (never empty)', async () => {
    const { ledger, db } = mkLedger()
    ledger.record({ ...rec(''), requestId: '' })
    await ledger.flush()
    const row = db.prepare('SELECT request_id FROM usage').get() as { request_id: string }
    expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/)
    checkpointAndClose(db)
  })
})

describe('day budget (MA5)', () => {
  it('tokensUsedToday sums only since local midnight for the given key', async () => {
    // Freeze "now" at a known local time; seed rows today and yesterday.
    const now = new Date()
    now.setHours(15, 0, 0, 0)
    const nowMs = now.getTime()
    const yesterdayMs = nowMs - 24 * 3600 * 1000
    const { ledger, db } = mkLedger({ now: () => nowMs })
    ledger.record(rec('today-1', { keyId: 'key_a', promptTokens: 100, completionTokens: 40 }))
    ledger.record(rec('today-2', { keyId: 'key_a', promptTokens: 30, completionTokens: 2 }))
    ledger.record(rec('today-other', { keyId: 'key_b', promptTokens: 999 }))
    await ledger.flush()
    // Backdate one row to "yesterday": it must drop out of today's budget.
    // today-1 = 140 (dropped), today-2 = 30 + 2 = 32 remains today.
    db.prepare('UPDATE usage SET created_at = ? WHERE request_id = ?').run(yesterdayMs, 'today-1')
    expect(ledger.tokensUsedToday('key_a')).toBe(32)
    // today-other = 999 prompt + default 5 completion.
    expect(ledger.tokensUsedToday('key_b')).toBe(1004)
    expect(ledger.tokensUsedToday('key_missing')).toBe(0)
    checkpointAndClose(db)
  })

  it('summarizeToday aggregates across keys', async () => {
    const { ledger } = mkLedger()
    ledger.record(rec('s1', { keyId: 'k', promptTokens: 4, completionTokens: 6 }))
    ledger.record(rec('s2', { keyId: 'other', promptTokens: 1, completionTokens: 1 }))
    await ledger.flush()
    const s = ledger.summarizeToday()
    expect(s.requests).toBe(2)
    expect(s.totalTokens).toBe(12)
  })
})

describe('day budget cache (B3/P2-svc)', () => {
  const NOW = new Date().setHours(15, 0, 0, 0)

  it('record() advances a seeded entry without a flush; the seed includes buffered rows', () => {
    const { ledger, db } = mkLedger({ now: () => NOW })
    // No flush yet — the row is still in the buffer. The seed must count it
    // (it is today's by construction: created_at is stamped at flush time).
    ledger.record(rec('b1', { keyId: 'k', promptTokens: 10, completionTokens: 5 }))
    expect(ledger.tokensUsedToday('k')).toBe(15)
    // A seeded entry accumulates O(1) on record — still nothing in the DB.
    ledger.record(rec('b2', { keyId: 'k', promptTokens: 7, completionTokens: 3 }))
    expect(ledger.tokensUsedToday('k')).toBe(25)
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(0)
    checkpointAndClose(db)
  })

  it('seed and accumulate agree whichever path runs first', () => {
    const { ledger, db } = mkLedger({ now: () => NOW })
    ledger.record(rec('c1', { keyId: 'k', promptTokens: 10, completionTokens: 5 }))
    ledger.record(rec('c2', { keyId: 'k', promptTokens: 7, completionTokens: 3 }))
    // No seed was requested between the two records — the re-seed path must
    // reach the same total the accumulate path would have.
    expect(ledger.tokensUsedToday('k')).toBe(25)
    checkpointAndClose(db)
  })

  it('a flush lands the buffered rows and the cache stays consistent', async () => {
    const { ledger, db } = mkLedger({ now: () => NOW })
    ledger.record(rec('f1', { keyId: 'k', promptTokens: 100, completionTokens: 50 }))
    expect(ledger.tokensUsedToday('k')).toBe(150)
    await ledger.flush()
    // Cache hit returns the same number the DB now holds.
    expect(ledger.tokensUsedToday('k')).toBe(150)
    expect(
      (db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS s FROM usage WHERE key_id = ?').get('k') as { s: number }).s,
    ).toBe(150)
    checkpointAndClose(db)
  })

  it('a cross-midnight entry is re-seeded from the new day, not accumulated into', async () => {
    let nowMs = new Date().setHours(23, 59, 0, 0)
    const { ledger, db } = mkLedger({ now: () => nowMs })
    ledger.record(rec('pre', { keyId: 'k', promptTokens: 100 }))
    await ledger.flush()
    expect(ledger.tokensUsedToday('k')).toBe(105)
    nowMs += 2 * 60_000 // 00:01 next day
    // The stale day entry is skipped by record(); the new day re-seeds.
    ledger.record(rec('post', { keyId: 'k', promptTokens: 10 }))
    expect(ledger.tokensUsedToday('k')).toBe(15)
    // After the flush the new day's DB sum holds only the post-midnight row:
    // created_at is stamped at flush time (now in the new day), so 'pre'
    // stays in yesterday.
    await ledger.flush()
    const midnight = new Date(nowMs)
    midnight.setHours(0, 0, 0, 0)
    expect(
      (db.prepare('SELECT COALESCE(SUM(total_tokens), 0) AS s FROM usage WHERE key_id = ? AND created_at >= ?').get('k', midnight.getTime()) as { s: number }).s,
    ).toBe(15)
    checkpointAndClose(db)
  })

  it('a replayed request id still advances the cache (documented ±1-row drift)', async () => {
    const { ledger, db } = mkLedger({ now: () => NOW })
    ledger.record(rec('seeded', { keyId: 'k', promptTokens: 10 }))
    await ledger.flush()
    expect(ledger.tokensUsedToday('k')).toBe(15) // seed
    // Same request id twice: the cache advances per record, the DB keeps one
    // row (INSERT OR IGNORE). Drift = one row — the tolerance the ledger
    // header declares for per-key sums.
    ledger.record(rec('dup', { keyId: 'k', promptTokens: 10 }))
    ledger.record(rec('dup', { keyId: 'k', promptTokens: 10 }))
    await ledger.flush()
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage WHERE request_id = ?').get('dup') as { n: number }).n).toBe(1)
    expect(ledger.tokensUsedToday('k')).toBe(45)
    checkpointAndClose(db)
  })
})

describe('retention prune (B4/S8)', () => {
  it('deletes rows older than N full days, keeping newer ones', async () => {
    const nowMs = new Date().setHours(15, 0, 0, 0)
    const { ledger, db } = mkLedger({ now: () => nowMs })
    ledger.record(rec('fresh', { promptTokens: 1 }))
    await ledger.flush()
    // Two legacy rows: 3 days ago and 10 days ago.
    db.prepare('UPDATE usage SET created_at = ? WHERE request_id = ?').run(nowMs - 3 * 86_400_000, 'fresh')
    ledger.record(rec('legacy', { promptTokens: 1 }))
    await ledger.flush()
    db.prepare('UPDATE usage SET created_at = ? WHERE request_id = ?').run(nowMs - 10 * 86_400_000, 'legacy')
    // days=7: cutoff = local midnight 7 days ago → 10-day-old row goes,
    // 3-day-old row stays.
    expect(ledger.pruneOlderThan(7)).toBe(1)
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }
    expect(remaining.n).toBe(1)
    expect(ledger.query({}).rows.map((r) => r.requestId)).toEqual(['fresh'])
    checkpointAndClose(db)
  })

  it('a zero/negative retention is a no-op (default keeps current behavior)', async () => {
    const { ledger } = mkLedger()
    ledger.record(rec('kept'))
    await ledger.flush()
    expect(ledger.pruneOlderThan(0)).toBe(0)
    expect(ledger.pruneOlderThan(-3)).toBe(0)
    expect(ledger.pruneOlderThan(Number.NaN)).toBe(0)
    expect(ledger.query({}).total).toBe(1)
  })
})

describe('query', () => {
  it('filters by keyId/model and paginates newest-first', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('q1', { keyId: 'ka', model: 'gemini-3.7-flash' }))
    ledger.record(rec('q2', { keyId: 'kb', model: 'claude-sonnet-4-6', protocol: 'anthropic' }))
    ledger.record(rec('q3', { keyId: 'ka', model: 'gemini-3.7-flash' }))
    await ledger.flush()

    const byKey = ledger.query({ keyId: 'ka' })
    expect(byKey.total).toBe(2)
    expect(byKey.rows.map((r) => r.requestId)).toEqual(['q3', 'q1'])

    const byModel = ledger.query({ model: 'claude-sonnet-4-6' })
    expect(byModel.total).toBe(1)
    expect(byModel.rows[0]?.protocol).toBe('anthropic')

    const paged = ledger.query({ limit: 1, offset: 1 })
    expect(paged.total).toBe(3)
    expect(paged.rows).toHaveLength(1)
    checkpointAndClose(db)
  })

  it('filters by accountId (exact match on account_id)', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('a1', { accountId: 'acc_1' }))
    ledger.record(rec('a2', { accountId: 'acc_2' }))
    ledger.record(rec('a3'))
    await ledger.flush()
    const byAccount = ledger.query({ accountId: 'acc_1' })
    expect(byAccount.total).toBe(1)
    expect(byAccount.rows.map((r) => r.requestId)).toEqual(['a1'])
    // Combined with another filter, both clauses AND together.
    const combo = ledger.query({ accountId: 'acc_1', keyId: 'ka' })
    expect(combo.total).toBe(0)
    checkpointAndClose(db)
  })

  it('filters by protocol and status (WebUI filters + dashboard success rate, audit M1)', async () => {
    const { ledger, db } = mkLedger()
    ledger.record(rec('p1', { protocol: 'anthropic' }))
    ledger.record(rec('p2', { protocol: 'openai' }))
    ledger.record(rec('f1', { status: 'TIMEOUT' }))
    await ledger.flush()

    const byProtocol = ledger.query({ protocol: 'anthropic' })
    expect(byProtocol.total).toBe(1)
    expect(byProtocol.rows.map((r) => r.requestId)).toEqual(['p1'])

    // The dashboard success-rate shape: ?status=OK must exclude failures.
    const okOnly = ledger.query({ status: 'OK' })
    expect(okOnly.total).toBe(2)
    const failed = ledger.query({ status: 'TIMEOUT' })
    expect(failed.total).toBe(1)

    // Combined with a window clause, clauses AND together.
    const windowed = ledger.query({ from: 0, status: 'OK', limit: 1 })
    expect(windowed.total).toBe(2)
    checkpointAndClose(db)
  })
})

describe('close semantics', () => {
  it('close() flushes pending rows and record() afterwards is a logged no-op', async () => {
    const logs: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'agy-ledger-'))
    dirs.push(dir)
    const path = join(dir, 't.db')
    const db = openDb(path)
    const ledger = new UsageLedger(db, { log: (m) => logs.push(m) })
    ledger.record(rec('pre-close'))
    await ledger.close()
    // The ledger owns the connection (close() closed it) — reopen to verify.
    const reopened = openDb(path)
    expect((reopened.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(1)
    reopened.close()
    ledger.record(rec('post-close'))
    expect(logs.length).toBe(1)
    expect(ledger.pending).toBe(0)
  })

  it('close() is idempotent', async () => {
    const { ledger } = mkLedger()
    await ledger.close()
    await expect(ledger.close()).resolves.toBeUndefined()
  })
})