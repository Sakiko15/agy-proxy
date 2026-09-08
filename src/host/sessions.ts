// Session binding store (spec ADR-4): gateway session id -> agy conversation.
// Atomic tmp+rename writes with dirty-key merge on reload keep concurrent
// host processes from clobbering each other — the pi-bridge-proven JSON
// layout, adapted to the gateway state directory.
// Ported from dsh-agy-link src/host/sessions.ts @ 46984db (modified: debounced
// persistence, corrupt-file quarantine and throttled persist warnings —
// B2/P5; store shape, reload merge and the atomic tmp+rename write are
// unchanged. The debounce widens the crash-loss window by up to 500ms per
// burst: a lost session binding re-binds on the next request (A-H2 precedent
// — dropped bindings are a recovery cost, never a protocol error)).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// S-M8 cadence, same as the account pool's debounced persist.
const PERSIST_DEBOUNCE_MS = 500
// Throttle for persist-failure warnings — one per minute, not per request.
const PERSIST_WARN_MS = 60_000

export interface SessionBinding {
  conversationId: string
  /** Message count at bind/update time (digest watermark). */
  lastMessageCount: number
  updatedAt: number
  model?: string
}

export class SessionStore {
  private data: Record<string, SessionBinding> = {};
  private persistDirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private lastPersistWarn = 0;

  constructor(
    private readonly file: string,
    private readonly log?: (msg: string) => void,
  ) {
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const v = JSON.parse(readFileSync(this.file, 'utf8'))
      if (v && typeof v === 'object') {
        this.data = v as Record<string, SessionBinding>;
        return;
      }
      // B2/P5: valid JSON of the wrong shape — same start-empty outcome the
      // old code produced, but quarantine the file so the next persist cannot
      // destroy the only copy of whatever wrote it.
      this.quarantine('unexpected JSON shape');
    } catch (err) {
      // B2/P5: corrupted store (torn tmp rename, truncated disk write) —
      // start empty rather than crash the gateway; quarantine the original
      // bytes before the first persist overwrites them.
      this.quarantine(String(err));
    }
  }

  /** Best-effort rename of an unreadable store aside; never throws. */
  private quarantine(reason: string): void {
    try {
      renameSync(this.file, this.file + '.corrupt-' + Date.now());
      this.log?.(`sessions store quarantined (unreadable: ${reason}) — rebuilt empty: ${this.file}`);
    } catch (renameErr) {
      this.log?.(`sessions store unreadable and quarantine rename failed (${String(renameErr)}): ${reason}`);
    }
  }

  get(key: string): SessionBinding | undefined {
    return this.data[key]
  }

  set(key: string, b: SessionBinding): void {
    this.data[key] = b;
    this.persistSoon();
  }

  delete(key: string): void {
    delete this.data[key];
    this.persistSoon();
  }

  clear(): void {
    this.data = {};
    this.persistSoon();
  }

  all(): Readonly<Record<string, SessionBinding>> {
    return this.data;
  }

  /** B2/P5: land any pending debounced persist immediately (teardown seam). */
  flush(): void {
    if (this.persistDirty) this.persist();
  }

  /**
   * B2/P5: debounce the full-file rewrite (S-M8 pattern, pool.ts). Bindings
   * update per request; rewriting the whole store JSON synchronously on every
   * one put a blocking write on the request path. The 500ms window merges
   * bursts; `flush()` covers teardown and tests.
   */
  private persistSoon(): void {
    this.persistDirty = true;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.persistDirty) this.persist();
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref();
  }

  /** Atomic write: tmp file + rename, then merge on next load. */
  private persist(): void {
    this.persistDirty = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = join(dirname(this.file), '.' + tinyBasename(this.file) + '.tmp')
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file);
    } catch (err) {
      // best-effort persistence; memory copy still serves this process. The
      // failure used to be fully silent — a persist that never succeeds drops
      // every binding at the next restart, so warn, throttled: persist runs
      // per request burst, not once.
      const now = Date.now();
      if (now - this.lastPersistWarn > PERSIST_WARN_MS) {
        this.lastPersistWarn = now;
        this.log?.(`sessions store persist failed (throttled 60s): ${String(err)}`);
      }
    }
  }
}

// tiny basename to avoid pulling node:path twice for one call;
// handles BOTH separators — a Windows path contains no '/' and would
// otherwise turn the tmp filename into garbage (persist silently failed).
function tinyBasename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}