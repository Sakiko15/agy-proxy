// Admin event bus + SSE channel (M4, charter §9 设计原则「实时数据全部 SSE,
// Last-Event-ID 续传」): the server previously had no event surface — admin
// state was only observable by polling. The bus:
//   - stamps every event with a single monotonic `seq` (the SSE `id:` line);
//     a client that sends Last-Event-ID N receives exactly the events after N
//   - keeps a bounded ring (capacity 200) so reconnects replay missed events
//     without a store; out-of-range ids fall back to a full snapshot — the
//     reconnect semantics are snapshot XOR replay, never both, which removes
//     any notion of gap merging or duplicate rows on the client
//   - publishes `pool` snapshots trailing-edge-debounced (250ms): pool
//     mutations arrive in bursts (recordFailure + quota merge in one settle)
//     and each snapshot is a few KB
// `run` events carry exactly the usage-ledger fields for the same run (the
// index.ts onRun hook feeds both), so dashboard and usage accounting can
// never disagree. No timers exist while idle: the only timer is the pool
// debouncer, armed solely when a change arrives.
//
// Client lifecycle is explicit: every /admin/events connection registers its
// stream-end callback via registerClient(), and closeAll() (shutdown teardown)
// invokes those to terminate hijacked sockets — app.close() does not close
// hijacked connections on its own.
import type { AccountPoolData } from '../common/pool-types.ts'

export interface RunEventPayload {
  ok: boolean
  status: string
  durationMs: number
  model: string
  family?: string
  conversationId?: string
  accountId: string | null
  keyId: string | null
  protocol: 'openai' | 'anthropic'
  reqId: string
  usage: {
    promptTokens: number
    completionTokens: number
    reasoningTokens?: number
    cacheReadTokens?: number
  } | null
}

export type AdminEvent =
  | { type: 'snapshot'; seq: number; at: number; pool: AccountPoolData }
  | { type: 'run'; seq: number; at: number; run: RunEventPayload }
  | { type: 'pool'; seq: number; at: number; pool: AccountPoolData }

export interface AdminEventBusOptions {
  getPool: () => Readonly<AccountPoolData>
  /** Trailing-edge delay for coalescing pool-change notifications. */
  debounceMs?: number
  /** Ring capacity for Last-Event-ID replay. */
  capacity?: number
}

export class AdminEventBus {
  private readonly getPool: () => Readonly<AccountPoolData>
  private readonly debounceMs: number
  private readonly capacity: number
  private ring: AdminEvent[] = []
  private readonly subscribers = new Map<number, (ev: AdminEvent) => void>()
  private readonly clients = new Map<number, () => void>()
  private seq = 0
  private nextId = 1
  private debounceTimer: NodeJS.Timeout | null = null

  constructor(opts: AdminEventBusOptions) {
    this.getPool = opts.getPool
    this.debounceMs = opts.debounceMs ?? 250
    this.capacity = opts.capacity ?? 200
  }

  /** Monotonic sequence number of the most recent event (0 = none yet). */
  currentSeq(): number {
    return this.seq
  }

  /** True when `seq` is still within the ring so replayAfter can serve it.
   *  A client already at the newest event replays an empty list (it stays
   *  live for the next publish) instead of getting a duplicate snapshot. */
  canReplayFrom(seq: number): boolean {
    if (!Number.isInteger(seq) || seq < 0 || seq > this.seq) return false
    if (seq === this.seq) return true
    const oldest = this.ring[0]?.seq ?? -1
    return oldest !== -1 && seq >= oldest && seq < this.seq
  }

  /** Events with seq strictly greater than the given id, oldest first. */
  replayAfter(seq: number): AdminEvent[] {
    return this.ring.filter((ev) => ev.seq > seq)
  }

  /** Subscribe to live events; the returned function unregisters. */
  subscribe(emit: (ev: AdminEvent) => void): () => void {
    const id = this.nextId++
    this.subscribers.set(id, emit)
    return () => {
      this.subscribers.delete(id)
    }
  }

  /** Register one SSE connection's stream-end callback. closeAll() invokes
   *  these to end hijacked sockets; the returned function unregisters (the
   *  route calls it when the stream closes on its own first). */
  registerClient(endStream: () => void): () => void {
    const id = this.nextId++
    this.clients.set(id, endStream)
    return () => {
      this.clients.delete(id)
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  /** The per-spawn settle event (same fields as the usage-ledger row). */
  publishRun(run: RunEventPayload): void {
    this.append({ type: 'run', at: Date.now(), run })
  }

  /** Pool data changed (pool.onChange notification); publish a debounced snapshot. */
  schedulePoolChange(): void {
    if (this.debounceTimer !== null) return // a publish is already pending
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.clients.size > 0 || this.subscribers.size > 0) this.publishPoolNow()
    }, this.debounceMs)
    this.debounceTimer.unref()
  }

  publishPoolNow(): void {
    this.append({ type: 'pool', at: Date.now(), pool: this.getPool() })
  }

  /** A full pool snapshot (initial delivery or replay-out-of-range fallback).
   *  Client-local: recorded in the ring for seq monotonicity, but NOT fanned
   *  out to live subscribers — the requesting route delivers it explicitly. */
  publishSnapshot(): AdminEvent {
    return this.append({ type: 'snapshot', at: Date.now(), pool: this.getPool() }, false)
  }

  /** Shutdown: stop pending timers and end every registered stream. */
  closeAll(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    const ends = [...this.clients.values()]
    this.clients.clear()
    this.subscribers.clear()
    for (const end of ends) {
      try {
        end()
      } catch {
        // a stream refusing to end must not block the shutdown path
      }
    }
  }

  /** Distributive Omit — Omit on a union would collapse it to common keys. */
  private append(partial: WithoutSeq<AdminEvent>, broadcast = true): AdminEvent {
    this.seq += 1
    const event = { ...partial, seq: this.seq } as AdminEvent
    this.ring.push(event)
    while (this.ring.length > this.capacity) this.ring.shift()
    if (broadcast) {
      for (const emit of [...this.subscribers.values()]) {
        try {
          emit(event)
        } catch {
          // a subscriber's writer failing must not break other subscribers;
          // the route unregisters itself via its stream's close handler.
        }
      }
    }
    return event
  }
}

type WithoutSeq<T> = T extends { seq: number } ? Omit<T, 'seq'> : never