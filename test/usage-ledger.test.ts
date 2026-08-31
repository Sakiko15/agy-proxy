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