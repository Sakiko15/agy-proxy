// Usage ledger (charter §5 L129 module name; §6 crash-recovery + §7 write-path
// rows fix the shape): per-request token accounting keyed by request id with
// UNIQUE + INSERT OR IGNORE, so a replayed request id cannot double count
// (acceptance M3 DoD) and the SQLite write never blocks the stream (§7) —
// record() only appends to an in-memory buffer; a 1 s timer batches rows into
// one transaction. The 1 s window is what the perf gate measures (request
// completion → landed row, P95 < 2s, acceptance §4). Rows survive a SIGKILL
// up to one flush window thanks to WAL+FULL; per-key sums are therefore
// ±1-request accurate, matching MA5's tolerance.
//
// Flush is fault-tolerant (M5, DoD: disk-full ⇒ bounded buffering, never a
// process abort): a failed transaction requeues its batch ahead of rows that
// arrived meanwhile and the next flush window retries. The requeue is bounded
// — over MAX_PENDING_ROWS the OLDEST rows are dropped (newest survive) — and
// the accompanying warning is throttled to one per WARN_INTERVAL_MS so a
// permanently full disk cannot turn into a log flood. There are no await
// points between the buffer swap and the requeue, so the event loop makes the
// hand-back atomic (record() cannot interleave). close() follows the same
// guard: a failed insert must not throw out of the shutdown path, and
// checkpoint/close are attempted even then.
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

/** Hard cap on requeued rows across failed flushes; beyond it oldest rows go. */
export const MAX_PENDING_ROWS = 5_000
/** Minimum gap between two "flush failed" warnings (disk-full log firehose). */
export const WARN_INTERVAL_MS = 60_000

export interface UsageRecord {
  requestId: string
  /** Managed key id, or null for the bootstrap root key. */
  keyId: string | null
  accountId: string | null
  model: string
  family: string
  protocol: 'openai' | 'anthropic'
  promptTokens: number
  completionTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  /** 'OK' or an Err code / 'ABORTED'. */
  status: string
  durationMs?: number
  /** Terminal failure text (schema v2 error_text) — stored truncated to 500
   *  chars for the audit trail. DB scrubbing targets key/token material, not
   *  failure prose; a validation_url is feature data, not a secret. */
  errorText?: string
}

export interface UsageRow extends UsageRecord {
  seq: number
  totalTokens: number
  createdAt: number
}

export interface UsageQuery {
  keyId?: string
  model?: string
  family?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

/** The buffer's row shape: null-normalized optionals + the ledger columns. */
interface InsertParams {
  requestId: string
  keyId: string | null
  accountId: string | null
  model: string
  family: string
  protocol: 'openai' | 'anthropic'
  promptTokens: number
  completionTokens: number
  reasoningTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number
  status: string
  durationMs: number | null
  errorText: string | null
  createdAt: number
}

export class UsageLedger {
  private buffer: InsertParams[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private readonly flushIntervalMs: number
  private readonly maxPendingRows: number
  private readonly log?: (msg: string) => void
  private readonly now: () => number
  private readonly insertStmt: BetterSqlite3.Statement
  /** Warn once about post-close record() calls (straggler run callbacks). */
  private warnedClosed = false
  /** Timestamp of the last flush-failure warning (throttle state). */
  private lastWarnAt = 0
  /** Row cap for stored failure text (schema v2 error_text). */
  private static readonly ERROR_TEXT_MAX = 500

  constructor(
    private readonly db: BetterSqlite3.Database,
    opts: {
      flushIntervalMs?: number
      now?: () => number
      log?: (msg: string) => void
      maxPendingRows?: number
    } = {},
  ) {
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1_000)
    this.maxPendingRows = Math.max(1, opts.maxPendingRows ?? MAX_PENDING_ROWS)
    this.log = opts.log
    this.now = opts.now ?? Date.now
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO usage
        (request_id, key_id, account_id, model, family, protocol,
         prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens,
         total_tokens, status, duration_ms, error_text, created_at)
      VALUES (@requestId, @keyId, @accountId, @model, @family, @protocol,
         @promptTokens, @completionTokens, @reasoningTokens, @cacheReadTokens,
         @totalTokens, @status, @durationMs, @errorText, @createdAt)
    `)
    this.armTimer()
  }

  get pending(): number {
    return this.buffer.length
  }

  /** O(1) in-memory append — never touches the DB, never throws. */
  record(rec: UsageRecord): void {
    if (this.closed) {
      if (!this.warnedClosed) {
        this.warnedClosed = true
        this.log?.('usage ledger received a record after close — dropped')
      }
      return
    }
    this.buffer.push({
      ...rec,
      requestId: rec.requestId !== '' ? rec.requestId : randomUUID(),
      keyId: rec.keyId ?? null,
      accountId: rec.accountId ?? null,
      promptTokens: rec.promptTokens || 0,
      completionTokens: rec.completionTokens || 0,
      reasoningTokens: rec.reasoningTokens ?? null,
      cacheReadTokens: rec.cacheReadTokens ?? null,
      totalTokens: (rec.promptTokens || 0) + (rec.completionTokens || 0),
      status: rec.status,
      durationMs: rec.durationMs ?? null,
      errorText:
        rec.errorText !== undefined && rec.errorText !== ''
          ? rec.errorText.slice(0, UsageLedger.ERROR_TEXT_MAX)
          : null,
      createdAt: 0, // stamped at flush time
    })
    if (this.buffer.length >= 500) void this.flush()
  }

  /** Drain the buffer inside one transaction (idempotent per request_id).
   *  Never throws — a failed transaction is requeued for the next window. */
  async flush(): Promise<void> {
    if (this.closed || this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    const ts = this.now()
    try {
      this.insertBatch(batch, ts)
    } catch (err) {
      // No await between the swap above and this requeue: record() cannot
      // interleave, so the merged order is strictly time-ordered.
      this.buffer = [...batch, ...this.buffer]
      if (this.buffer.length > this.maxPendingRows) {
        const dropped = this.buffer.length - this.maxPendingRows
        this.buffer = this.buffer.slice(-this.maxPendingRows)
        this.warnThrottled(
          `usage ledger flush failed (${describeError(err)}) — ` +
            `${dropped} oldest row(s) dropped, keeping the newest ${this.maxPendingRows} for retry`,
        )
      } else {
        this.warnThrottled(
          `usage ledger flush failed (${describeError(err)}) — ` +
            `${this.buffer.length} row(s) requeued for the next window`,
        )
      }
    }
  }

  /** SUM(total_tokens) for one key since LOCAL midnight (MA5 daily budget). */
  tokensUsedToday(keyId: string): number {
    const midnight = startOfToday(this.now)
    const row = this.db
      .prepare('SELECT COALESCE(SUM(total_tokens), 0) AS s FROM usage WHERE key_id = ? AND created_at >= ?')
      .get(keyId, midnight) as { s: number }
    return row.s
  }

  summarizeToday(): { requests: number; promptTokens: number; completionTokens: number; totalTokens: number } {
    const midnight = startOfToday(this.now)
    return this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
                COALESCE(SUM(completion_tokens), 0) AS completionTokens,
                COALESCE(SUM(total_tokens), 0) AS totalTokens
         FROM usage WHERE created_at >= ?`,
      )
      .get(midnight) as { requests: number; promptTokens: number; completionTokens: number; totalTokens: number }
  }

  query(q: UsageQuery): { total: number; rows: UsageRow[] } {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (q.keyId !== undefined) { where.push('key_id = @keyId'); params.keyId = q.keyId }
    if (q.model !== undefined) { where.push('model = @model'); params.model = q.model }
    if (q.family !== undefined) { where.push('family = @family'); params.family = q.family }
    if (q.from !== undefined) { where.push('created_at >= @from'); params.from = q.from }
    if (q.to !== undefined) { where.push('created_at <= @to'); params.to = q.to }
    const clause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM usage ${clause}`).get(params) as { n: number }
    ).n
    const limit = Math.min(Math.max(1, q.limit ?? 50), 500)
    const offset = Math.max(0, q.offset ?? 0)
    const rows = this.db
      .prepare(`SELECT * FROM usage ${clause} ORDER BY seq DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as RawUsageDbRow[]
    return { total, rows: rows.map(fromDbRow) }
  }

  /** flush → WAL checkpoint (TRUNCATE) → close. Further record()s are no-ops.
   *  Never throws: even with a poisoned database the shutdown path completes
   *  and does not leave the process wedged on teardown. */
  async close(): Promise<void> {
    if (this.closed) return
    this.disarmTimer()
    this.closed = true
    if (this.buffer.length > 0) {
      const batch = this.buffer
      this.buffer = [] // teardown: rows are dropped on failure, not requeued
      try {
        this.insertBatch(batch, this.now())
      } catch (err) {
        this.warnThrottled(`usage ledger close: final flush failed (${describeError(err)}) — rows dropped`)
      }
    }
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
      this.db.close()
    } catch (err) {
      this.warnThrottled(`usage ledger close: checkpoint/close failed (${describeError(err)})`)
    }
  }

  /** One transaction of INSERT OR IGNOREs — idempotent per request_id. */
  private insertBatch(rows: InsertParams[], ts: number): void {
    const tx = this.db.transaction((batch: InsertParams[]) => {
      for (const r of batch) {
        this.insertStmt.run({ ...r, createdAt: ts })
      }
    })
    tx(rows)
  }

  /** Throttled failure warning — at most one per WARN_INTERVAL_MS so a
   *  permanently full disk cannot flood the log; clock is the injectable one. */
  private warnThrottled(msg: string): void {
    if (this.now() - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = this.now()
    this.log?.(msg)
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      void this.flush().finally(() => {
        if (!this.closed) this.armTimer()
      })
    }, this.flushIntervalMs)
    this.timer.unref()
  }

  private disarmTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

function startOfToday(now: () => number): number {
  const midnight = new Date(now())
  midnight.setHours(0, 0, 0, 0)
  return midnight.getTime()
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.message} [${(err as { code?: string }).code ?? 'NO_CODE'}]` : String(err)
}

interface RawUsageDbRow {
  seq: number
  request_id: string
  key_id: string | null
  account_id: string | null
  model: string
  family: string
  protocol: string
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  total_tokens: number
  status: string
  duration_ms: number | null
  error_text: string | null
  created_at: number
}

function fromDbRow(r: RawUsageDbRow): UsageRow {
  return {
    seq: r.seq,
    requestId: r.request_id,
    keyId: r.key_id,
    accountId: r.account_id,
    model: r.model,
    family: r.family,
    protocol: r.protocol as 'openai' | 'anthropic',
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    reasoningTokens: r.reasoning_tokens ?? undefined,
    cacheReadTokens: r.cache_read_tokens ?? undefined,
    totalTokens: r.total_tokens,
    status: r.status,
    durationMs: r.duration_ms ?? undefined,
    errorText: r.error_text ?? undefined,
    createdAt: r.created_at,
  }
}