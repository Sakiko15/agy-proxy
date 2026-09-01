// UsageLedger fault tolerance (M5): a flush that hits the real disk-full
// error must never abort the process (DoD: 磁盘满 → bounded buffering, not a
// crash). SQLITE_FULL is injected with `PRAGMA max_page_count` pinned to the
// current page count — a genuine SQLite error straight from the engine, no
// mocks. Rows that must overflow to fresh pages then fail exactly as they
// would on a full volume.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/server/db.ts'
import { UsageLedger, MAX_PENDING_ROWS, type UsageRecord } from '../src/server/usage-ledger.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* open handles */ }
  }
})

/** A ledger whose inserts overflow the pinned page count → SQLITE_FULL.
 *  The 1h flush interval keeps the armed re-arm timer out of the assertions. */
function mkFaultyLedger(
  ledgerOpts: {
    now?: () => number
    log?: (msg: string) => void
    maxPendingRows?: number
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ledger-full-'))
  dirs.push(dir)
  const db = openDb(join(dir, 't.db'))
  const pageCount = db.pragma('page_count', { simple: true }) as number
  db.pragma(`max_page_count = ${pageCount}`)
  const ledger = new UsageLedger(db, { flushIntervalMs: 3_600_000, ...ledgerOpts })
  return { ledger, db, dir }
}

function listFiles(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
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

// 20 KB of model text: the row cannot fit a fresh page, so the insert must
// allocate pages past the pin — that is what turns the pragma into SQLITE_FULL.
function recFull(requestId: string): UsageRecord {
  return { ...REC_BASE, requestId, model: 'm'.repeat(20_000) }
}

async function flushAndSettle(ledger: UsageLedger): Promise<void> {
  await ledger.flush()
  await new Promise((r) => setTimeout(r, 0))
}

describe('flush fault tolerance (disk full)', () => {
  it('MAX_PENDING_ROWS is the plan-pinned 5000', () => {
    expect(MAX_PENDING_ROWS).toBe(5_000)
  })

  it('a failed transaction does not throw and requeues its rows', async () => {
    const logs: string[] = []
    const { ledger, db } = mkFaultyLedger({ log: (m) => logs.push(m) })
    ledger.record(recFull('f1'))
    ledger.record(recFull('f2'))
    ledger.record(recFull('f3'))

    await expect(ledger.flush()).resolves.toBeUndefined()

    expect(ledger.pending).toBe(3)
    expect(ledger.query({}).total).toBe(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('SQLITE_FULL')
    expect(logs[0]).toContain('requeued')
    await ledger.close()
    expect(db.open).toBe(false)
  })

  it('the failure warning is throttled to one per 60 s (injectable clock)', async () => {
    let t = 1_700_000_000_000
    const logs: string[] = []
    const { ledger, db } = mkFaultyLedger({ now: () => t, log: (m) => logs.push(m) })

    ledger.record(recFull('w1'))
    await ledger.flush()
    expect(logs).toHaveLength(1)

    // Second failure inside the 60 s window: requeued silently.
    ledger.record(recFull('w2'))
    await ledger.flush()
    expect(logs).toHaveLength(1)
    expect(ledger.pending).toBe(2)

    // Past the window the warning fires again.
    t += 60_001
    ledger.record(recFull('w3'))
    await ledger.flush()
    expect(logs).toHaveLength(2)
    await ledger.close()
  })

  it('over the cap the oldest rows are dropped, newest kept — and land once the cap is raised', async () => {
    const logs: string[] = []
    const { ledger, db } = mkFaultyLedger({ log: (m) => logs.push(m), maxPendingRows: 4 })
    for (let i = 1; i <= 10; i++) ledger.record(recFull(`cap-${i}`))

    await expect(ledger.flush()).resolves.toBeUndefined()

    expect(ledger.pending).toBe(4)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('oldest')

    // Raising the cap simulates the disk getting space back: the next window
    // drains the requeue and the surviving (newest) rows land once, in order.
    db.pragma('max_page_count = 1000000')
    await ledger.flush()
    expect(ledger.pending).toBe(0)
    expect(ledger.query({}).total).toBe(4)
    expect(ledger.query({}).rows.map((r) => r.requestId)).toEqual(['cap-10', 'cap-9', 'cap-8', 'cap-7'])
    await ledger.close()
  })

  it('close() after a failed flush never throws and still checkpoint-closes the db', async () => {
    const { ledger, db } = mkFaultyLedger()
    ledger.record(recFull('close-1'))
    await ledger.flush()
    expect(ledger.pending).toBe(1)

    await expect(ledger.close()).resolves.toBeUndefined()
    expect(db.open).toBe(false)
  })

  it('close() tolerates an already-closed db handle (double-close / shutdown ordering)', async () => {
    const { ledger, db } = mkFaultyLedger()
    ledger.record(recFull('ext-1'))
    db.close()
    await expect(ledger.close()).resolves.toBeUndefined()
    expect(db.open).toBe(false)
  })

  it('close() after failures still checkpoints cleanly (WAL sidecar removed on clean close)', async () => {
    const { ledger, db, dir } = mkFaultyLedger()
    ledger.record(recFull('wal-1'))
    await ledger.flush()
    expect(ledger.pending).toBe(1)

    await expect(ledger.close()).resolves.toBeUndefined()
    // A clean SQLite close checkpoints and removes the -wal sidecar — proof
    // the teardown ran to completion instead of escaping through the guard.
    expect(listFiles(dir).filter((f) => f.endsWith('-wal'))).toEqual([])
  })
})