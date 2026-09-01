// Engine — the heart of agy-proxy (charter §4). Translates one gateway model
// call into a short-lived `agy -p --output-format stream-json` child process,
// maps the NDJSON event stream onto StreamChunks, and binds sessions to agy
// conversations for multi-turn continuity. Only the trailing user messages
// become the prompt; earlier context rides agy-native history plus a digest
// prefix on first bind (ADR-7 discipline inherited from dsh-agy-link).
//
// Rewritten from dsh-agy-link src/host/adapter.ts @ 46984db: the dsh-llm
// LlmAdapter base class and its auxiliary-call machinery (compaction/title,
// allowAuxiliary, forwardSystemPrompt toggle) have no host in a standalone
// gateway. The public surface is a self-owned vocabulary: stream(EngineCall)
// -> AsyncIterable<StreamChunk>. Retained verbatim in behavior: ChunkQueue,
// buildArgs, buildDigest, sliding-window rate limit, account selection +
// autoFallbackModel, session binding (model switch / compaction invalidation),
// media staging, telemetry env, isolated HOMEs, per-account spawn spacing,
// settlement classification order, binding persistence/drop rules, steer
// preemption, duplicate submission debounce, and continuation spans.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PQueue from 'p-queue'
import { Err, extractValidationUrl, looksLikeAuthFailure, looksLikeHardRateLimit, looksLikeRateLimit, looksLikeValidationRequired, type GatewayConfig } from '../common/types.ts'
import { modelFamilyOf, type ModelFamily } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper, usageFromRaw } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { defaultEffortFor, findEntry, ModelCatalog, resolveModelSlug } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, type ImageRefLike } from './media.ts'
import { isolatedHomeEnv, startAgyProcess, type RunOutcome } from './runner.ts'
import { dataDir, stateDir } from '../common/config.ts'
import type { SessionStore } from './sessions.ts'
import type { StreamChunk, TokenUsage } from './stream-types.ts'

/** Engine failure with a stable routing code (maps 1:1 onto the Err table). */
export class EngineError extends Error {
  readonly code: string
  /** Seconds the client should wait before retrying (POOL_EXHAUSTED → Retry-After). */
  readonly retryAfterSec?: number
  constructor(message: string, code: string, retryAfterSec?: number) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

/** Codes the service layer may retry once (ADR-11 discipline, engine-owned). */
export const RETRYABLE_CODES: readonly string[] = [Err.TIMEOUT, Err.PROCESS_EXIT, Err.INVALID_OUTPUT]

/** Retry policy constants for the service layer (inherited from ADR-11). */
export const RETRY_POLICY = {
  maxRetries: 1,
  initialDelayMs: 2_000,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
} as const

/** Jittered backoff for one retry: base ± jitterRatio (±10% of 2s ⇒ 1.8–2.2s),
 *  capped at maxDelayMs. Pure so tests can pin the bounds without sleeping. */
export function computeRetryDelayMs(
  baseMs: number,
  rand: () => number = Math.random,
  maxMs: number = RETRY_POLICY.maxDelayMs,
): number {
  const jittered = baseMs * (1 + (2 * rand() - 1) * RETRY_POLICY.jitterRatio)
  return Math.max(0, Math.min(maxMs, Math.round(jittered)))
}

/** Default retry-delay implementation used when deps.retryDelay is absent. */
export function defaultRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, computeRetryDelayMs(ms))
    t.unref()
  })
}

export interface EngineMessageImage {
  name?: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
}

export interface EngineMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  /** Images attached to a user message (staged to disk for agy). */
  images?: EngineMessageImage[]
  /** For role='tool': callId of the mirrored agy tool call this answers. */
  toolCallId?: string
  /**
   * Provider that produced an assistant turn. Multi-model gateway sessions
   * mark foreign replies so the digest keeps their turns; unmarked assistant
   * messages are treated as foreign (agy's native history lacks them).
   */
  provider?: string
}

export interface EngineCall {
  model: string
  reasoningEffort?: string
  messages: readonly EngineMessage[]
  /** System prompt; always forwarded (prefixed as system instructions). */
  system?: string
  signal?: AbortSignal
  /** Gateway session key for binding + steer/debounce scoping. */
  sessionKey?: string
  /** JSON schema enforcing the final result (--json-schema). */
  jsonSchema?: unknown
  /** Per-call image byte reader; wins over deps.readImage (request-scoped). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /**
   * Server-provided observability passthrough (request id, key id, protocol),
   * echoed verbatim in the settle-time onRun callback so a single enriched
   * hook can write the usage ledger for every spawn without per-route wiring.
   */
  meta?: Readonly<Record<string, unknown>>
}

export interface EngineDeps {
  getConfig: () => GatewayConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /**
   * Fixed argv prefix inserted before the call's own arguments (after them
   * nothing is appended by the engine). Test harnesses point `bin` at the
   * node executable and pass the fake CLI script here; production leaves it
   * empty (the real agy binary takes the args directly).
   */
  binArgs?: readonly string[]
  /** Shared semaphore for cross-session concurrency. */
  acquire: () => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (continuation spans). */
  runs: RunRegistry
  /** Last-run telemetry + usage-ledger input, fired once per actual agy
   *  spawn attempt (settle time — never for continuation spans, so tool
   *  round trips do not double count). With dispatch-level retries (M5) an
   *  attempt that will be retried fires with final=false; the host gates
   *  ledger/push bookkeeping on final=true because the ledger's
   *  INSERT OR IGNORE is first-wins — a failed attempt's row would otherwise
   *  swallow the retry's successful usage. Pre-flight throws
   *  (POOL_EXHAUSTED/BUSY/…) never fire it: no upstream consumption.
   *  failureMessage carries the terminal error text (schema v2 error_text). */
  onRun?: (info: {
    ok: boolean
    code: string
    /** 0-based spawn attempt within the logical run. */
    attempt: number
    /** true for the one attempt whose outcome settles the run. */
    final: boolean
    failureMessage?: string
    durationMs: number
    model: string
    /** Model slug actually driven (after fallback-model resolution). */
    providerModel: string
    usage: TokenUsage | null
    accountId?: string
    family?: string
    conversationId?: string
    meta?: Readonly<Record<string, unknown>>
  }) => void
  /** Retry backoff seam for dispatch-level retries (M5); tests inject a
   *  resolved promise to keep failing-run suites fast. Absent = the
   *  RETRY_POLICY jittered delay. */
  retryDelay?: (ms: number) => Promise<void>
  /**
   * Per-key model whitelist (M5): resolve a managed key id to its allowed
   * model ids, or null when the key has no whitelist (unrestricted). Absent
   * callback = the feature is off. The engine checks the model actually
   * SERVED (post-fallback resolution) and rejects with Err.MODEL_NOT_ALLOWED
   * (403, both protocols). The root key (keyId=null) must resolve null —
   * charter red line: the bootstrap key is unrestricted.
   */
  getScopes?: (keyId: string | null) => string[] | null
  /** Reads image bytes from protocol-layer attachment storage. */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /**
   * Call-level override for readImage (see EngineCall.readImage): protocol
   * adapters stage request-scoped byte buffers without shared mutable state.
   */
  /** Called with each run's parser so the host keeps the last stdout ring for the doctor report. */
  onParser?: (parser: StreamJsonParser) => void
}

// ---- stream() -------------------------------------------------------------

class ChunkQueue {
  private chunks: StreamChunk[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(ch: StreamChunk): void {
    this.chunks.push(ch)
    this.wake?.()
    this.wake = null
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
  }

  async *drain(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.chunks.length > 0) {
        const ch = this.chunks.shift()
        if (ch !== undefined) yield ch
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      });
    }
  }
}

function brief(s: string): string {
  const flat = s.trim().replace(/\s+/g, ' ')
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat
}

/** Gateway provider id; assistant turns marked with it rode OUR agy history. */
const PROVIDER_ID = 'antigravity'

function isForeignAssistant(m: EngineMessage): boolean {
  if (m.role !== 'assistant') return false
  return m.provider !== PROVIDER_ID
}

function sawAuthFailure(parser: StreamJsonParser, outcome: { stderrTail: string; stdout: string }): boolean {
  if (parser.stats.sawAuthFailure) return true
  return looksLikeAuthFailure(outcome.stderrTail) || looksLikeAuthFailure(outcome.stdout.slice(0, 4000))
}

/** Rolling digest of turns this agy conversation has not seen (ADR-7). */
export function buildDigest(messages: readonly EngineMessage[], fromIdx: number, maxChars: number): string {
  const parts: string[] = []
  let budget = maxChars
  for (let i = messages.length - 1; i >= fromIdx; i--) {
    const m = messages[i]
    if (m === undefined || m.role === 'system') continue
    if (m.text === '') continue
    const line = (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.text
    if (line.length > budget) {
      parts.unshift(line.slice(0, Math.max(0, budget)))
      break
    }
    budget -= line.length
    parts.unshift(line)
  }
  if (parts.length === 0) return ''
  return '[conversation so far]\n' + parts.join('\n\n') + '\n[end of conversation so far]\n\n'
}/** Width/height are unknown at the protocol boundary; agy only uses the path. */
const UNKNOWN_DIM = 0

export class AgyEngine {
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /** sessionKey -> prompt info for duplicate submission debounce */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  /** Global sliding window timestamps for batch rate-limiting protection */
  private readonly requestTimestamps: number[] = []
  /** accountId -> serial queue (concurrency:1, charter §6) around the agy
   *  spawn→outcome segment: two concurrent requests on the same sticky account
   *  must not interleave on one conversation binding. Continuations bypass the
   *  queue (no spawn). Inactive without a pool. */
  private readonly accountQueues = new Map<string, PQueue>()

  constructor(private readonly deps: EngineDeps) {}

  /**
   * Earliest reset signal for a family across the pool: min over live cooldown
   * clocks and future quota reset times (5h + weekly). Feeds the
   * POOL_EXHAUSTED message and its Retry-After; null = every clock unknown.
   */
  private earliestResetMs(family: ModelFamily): number | null {
    const pool = this.deps.pool
    if (!pool) return null
    let earliest: number | null = null
    const consider = (isoMs: number | null): void => {
      if (isoMs !== null && (earliest === null || isoMs < earliest)) earliest = isoMs
    }
    const countdown = pool.getEarliestResetCountdown(family)
    if (countdown !== null) consider(Date.now() + countdown)
    for (const acc of pool.getAccounts()) {
      if (!acc.enabled) continue
      const fq = acc.quotas?.[family]
      if (fq?.resetTime) {
        const t = Date.parse(fq.resetTime)
        if (Number.isFinite(t) && t > Date.now()) consider(t)
      }
      if (fq?.weeklyResetTime) {
        const t = Date.parse(fq.weeklyResetTime)
        if (Number.isFinite(t) && t > Date.now()) consider(t)
      }
    }
    return earliest !== null ? Math.max(0, earliest - Date.now()) : null
  }

  /** Build the agy argv for one call. Exported for tests. */
  buildArgs(opts: {
    prompt: string
    model: string
    effort?: string
    conversationId?: string
    permissionMode: GatewayConfig['permissionMode']
    timeoutMs: number
    extraArgs: readonly string[]
    addDirs?: readonly string[]
    printTimeoutMinutes?: number
  }): string[] {
    const ptMins = opts.printTimeoutMinutes ?? Math.max(1, Math.ceil(opts.timeoutMs / 60_000))
    const args: string[] = ['--output-format', 'stream-json', '--print-timeout', ptMins + 'm']
    if (opts.permissionMode === 'skip') args.push('--dangerously-skip-permissions')
    else args.push('--mode', opts.permissionMode)
    const effectiveModel = resolveModelSlug(opts.model)
    if (effectiveModel !== '') args.push('--model', effectiveModel)
    const isGemini = effectiveModel === '' || effectiveModel.toLowerCase().startsWith('gemini')
    if (isGemini && opts.effort && opts.effort !== '') args.push('--effort', opts.effort)
    if (opts.conversationId) args.push('--conversation', opts.conversationId)
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d)
    args.push(...opts.extraArgs)
    args.push('-p', opts.prompt)
    return args
  }

  async *stream(call: EngineCall): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    const bin = this.deps.bin()
    if (!bin) throw new EngineError('agy binary not found on PATH — install it via https://antigravity.google/docs/cli/install', Err.AGY_NOT_INSTALLED)
    const sessionKey = call.sessionKey !== undefined ? String(call.sessionKey) : ''

    // Workspace precedence: explicit config > <dataDir>/workspace. Unlike the
    // upstream adapter there is no process.cwd() fallback — a gateway has no
    // meaningful cwd, and silently running agy in the server's install
    // directory would be a wrong-workspace write path.
    let workspaceRoot = cfg.workspaceRoot
    if (workspaceRoot === '') {
      workspaceRoot = join(dataDir(), 'workspace')
      ensureWorkspaceDir(this.deps.log, workspaceRoot)
    }

    // ---- native tool mirroring: continuation spans (v1) ----
    // When the previous span cut on a completed agy tool step, the client
    // received the mirror tool call (and its replayed output); it is now
    // calling us again to continue the SAME run. Resume the recording from
    // the cursor encoded in the trailing tool-result callId — no new process,
    // no prompt assembly, no digest.
    const continuation = detectContinuation(call.messages)
    if (continuation !== null) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec === undefined) {
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'agy run ' + continuation.runId + ' is no longer available (server restarted?) — please resend your message',
              code: Err.AGY_ERROR,
            },
          },
        }
        return
      }
      yield* this.driveSpan(rec, continuation.eventIndex + 1, true)
      return
    }
    // Mid-turn steer preemption: the session sends a new prompt while a run
    // is still alive (a NEW run, not a continuation). The previous run's agy
    // process would keep appending to the SAME conversation concurrently —
    // abort it first.
    if (sessionKey !== '') {
      const prev = this.activeRuns.get(sessionKey)
      if (prev !== undefined && !prev.isSettled) {
        if (prev.requestAbort != null) prev.requestAbort()
        // A queued (not yet spawned) run has no process to abort — settle it
        // so the per-account queue task skips the spawn entirely.
        else prev.settle({ kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' })
      }
    }
    const catalog = this.deps.catalog.get()
    const rawModel = call.model
    const model = resolveModelSlug(rawModel)
    const entry = findEntry(catalog, model)
    const isGemini = (model === '' ? cfg.defaultModel : model).toLowerCase().startsWith('gemini')
    // The catalog is advisory (the fallback list may be stale): accept unknown
    // ids, but validate explicit reasoning efforts against known entries.
    let effort: string | undefined
    if (isGemini) {
      if (call.reasoningEffort !== undefined) {
        const wanted = String(call.reasoningEffort)
        if (entry && entry.efforts === null) {
          throw new EngineError('model ' + model + ' has no selectable reasoning efforts', Err.UNSUPPORTED_REASONING_EFFORT)
        }
        if (entry && entry.efforts && !entry.efforts.includes(wanted)) {
          throw new EngineError('reasoning effort ' + wanted + ' is not supported by ' + model, Err.UNSUPPORTED_REASONING_EFFORT)
        }
        effort = wanted
      } else if (entry && entry.efforts) {
        effort = defaultEffortFor(entry, cfg)
      }
    }

    // ---- prompt assembly (digest discipline, upstream ADR-7) ----
    const messages = call.messages
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const mm = messages[i]
      if (mm !== undefined && mm.role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    const trailingUser = messages.slice(lastAssistantIdx + 1).filter((m) => m.role === 'user')

    // Sliding-window rate limit protection per minute (gateway batch stability)
    if (cfg.rateLimitPerMinute > 0) {
      const now = Date.now()
      const windowStart = now - 60_000
      while (this.requestTimestamps.length > 0 && this.requestTimestamps[0]! < windowStart) {
        this.requestTimestamps.shift()
      }
      if (this.requestTimestamps.length >= cfg.rateLimitPerMinute) {
        const delayMs = this.requestTimestamps[0]! + 60_000 - now
        if (delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs))
        }
      }
      this.requestTimestamps.push(Date.now())
    }

    let activeModel = model === '' ? cfg.defaultModel : model
    let family = modelFamilyOf(activeModel)
    // Accounts with in-flight spawns (tracked by THIS engine until settle) are
    // skipped by selectAccount so concurrent requests spread across the pool
    // (M5: acceptance §4 互不阻塞 / ≥2.5× throughput). Busy-but-healthy pools
    // fall through to the unfiltered selection inside the pool.
    const busyAccounts = new Set<string>()
    const inFlightCount = new Map<string, number>()
    const trackBusy = (id: string | undefined): void => {
      if (id === undefined) return
      inFlightCount.set(id, (inFlightCount.get(id) ?? 0) + 1)
      busyAccounts.add(id)
    }
    const untrackBusy = (id: string | undefined): void => {
      if (id === undefined) return
      const left = (inFlightCount.get(id) ?? 1) - 1
      if (left <= 0) {
        inFlightCount.delete(id)
        busyAccounts.delete(id)
      } else {
        inFlightCount.set(id, left)
      }
    }
    let account = this.deps.pool ? this.deps.pool.selectAccount(family, busyAccounts) : undefined
    if (this.deps.pool && this.deps.pool.getAccounts().length > 0 && !account) {
      if (cfg.autoFallbackModel) {
        const fallbackSlugs = ['gemini-3.5-flash', 'gemini-3.6-flash']
        for (const fb of fallbackSlugs) {
          const fbFam = modelFamilyOf(fb)
          const fbAcc = this.deps.pool.selectAccount(fbFam)
          if (fbAcc) {
            account = fbAcc
            family = fbFam
            activeModel = fb
            break
          }
        }
      }
      if (!account) {
        // MA4 / M3 DoD: an exhausted pool is a rate-limit condition (429 +
        // Retry-After), not an upstream failure (502). The countdown covers
        // both cooldown clocks and future quota reset times.
        const countdownMs = this.earliestResetMs(family)
        const waitStr = countdownMs !== null ? ` (earliest reset in ${Math.ceil(countdownMs / 1000)}s)` : ''
        throw new EngineError(
          `All Antigravity accounts in pool are in cooldown for ${family}${waitStr}. Add an account or wait for reset.`,
          Err.POOL_EXHAUSTED,
          countdownMs !== null ? Math.max(1, Math.ceil(countdownMs / 1000)) : undefined,
        )
      }
    }

    // ---- per-key model whitelist (M5): the key's scopes constraint applies
    // to the model ACTUALLY SERVED — after fallback resolution, since the
    // fallback switch silently redirects the request — not to the request's
    // model label. Root (keyless) requests and an absent callback bypass. ----
    const getScopes = this.deps.getScopes
    if (getScopes !== undefined) {
      const metaScopes = (call.meta ?? {}) as { keyId?: unknown }
      const scopesKey = typeof metaScopes.keyId === 'string' && metaScopes.keyId !== '' ? metaScopes.keyId : null
      const allowedModels = getScopes(scopesKey)
      const servingModel = activeModel === '' ? cfg.defaultModel : activeModel
      if (allowedModels !== null && allowedModels.length > 0 && !allowedModels.includes(servingModel)) {
        throw new EngineError(
          `model ${servingModel} is not in this key's allowed model list — patch the key scopes in the admin UI (MODEL_NOT_ALLOWED)`,
          Err.MODEL_NOT_ALLOWED,
        )
      }
    }

    trackBusy(account?.id)
    const sessionAccountKey = account ? `${sessionKey}:${account.id}` : sessionKey
    let binding = sessionAccountKey !== '' ? this.deps.store.get(sessionAccountKey) : undefined

    // Model switch detection: If model changed in the session, drop stale agy conversation binding
    const currentModel = activeModel === '' ? cfg.defaultModel : activeModel
    if (binding !== undefined && binding.model && binding.model !== currentModel) {
      if (sessionAccountKey !== '') this.deps.store.delete(sessionAccountKey)
      binding = undefined
    }

    // Compaction detection: If the client truncated history or cleared earlier
    // turns, messages.length drops below the recorded watermark. Invalidate the
    // stale agy conversation binding so a clean agy session is started and
    // seeded with a digest of the truncated history.
    if (binding !== undefined && messages.length < binding.lastMessageCount) {
      if (sessionAccountKey !== '') this.deps.store.delete(sessionAccountKey)
      binding = undefined
    }

    let prompt = ''
    const trailingText = trailingUser.map((m) => m.text).filter((s) => s !== '')
    prompt = trailingText.join('\n\n')
    // Digest budget (upstream default; the gateway config surface has no
    // dedicated knob — 8k chars covers ~4k tokens of context preamble).
    const digestMaxChars = 8_000
    if (binding === undefined && lastAssistantIdx >= 0) {
      // First contact: bring agy up to speed with a bounded digest.
      prompt = buildDigest(messages, 0, digestMaxChars) + prompt
    } else if (binding !== undefined) {
      // Returning session: digest only the foreign turns since our
      // watermark (the client may have talked to another model in between).
      // Our own agy replies ride the native conversation history, and the
      // trailing user run is already the live prompt above.
      const from = Math.min(binding.lastMessageCount, messages.length)
      const end = Math.max(from, lastAssistantIdx + 1)
      const span = messages
        .slice(from, end)
        .filter((m) => m.role !== 'assistant' || isForeignAssistant(m))
      if (span.some((m) => m.role === 'assistant')) {
        prompt = buildDigest(span, 0, digestMaxChars) + prompt
      }
    }
    if (call.system) {
      // The gateway ALWAYS forwards system prompts (no host-level toggle).
      prompt = 'System instructions:\n' + call.system + '\n\n' + prompt;
    }

    // ---- multimodal staging: images ride as staged files ----
    let stagedDirs: string[] = []
    const imageRefs: ImageRefLike[] = []
    for (const m of trailingUser) {
      for (const img of m.images ?? []) {
        // width/height are not carried over the wire; agy only reads the file.
        imageRefs.push({
          attachmentId: img.name ?? 'image',
          mediaType: img.mediaType,
          bytes: img.bytes,
          width: UNKNOWN_DIM,
          height: UNKNOWN_DIM,
          ...(img.name !== undefined ? { name: img.name } : {}),
        })
      }
    }
    if (imageRefs.length > 0) {
      // Call-level reader wins: protocol adapters stage request-scoped
      // byte buffers (data: URLs) without shared mutable state.
      const readImage = call.readImage ?? this.deps.readImage
      if (readImage) {
        const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
        const key = (sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon') + '-' + messages.length
        const res = await stageImages({
          dir,
          key,
          images: imageRefs,
          readImage,
          maxImages: cfg.mediaMaxImages,
          maxBytes: cfg.mediaMaxBytes,
        })
        if (res.promptSuffix !== '') {
          prompt = prompt === ''
            ? (res.promptSuffix + '\n\n[Please inspect the attached image(s) using view_file and assist the user.]')
            : (prompt + '\n\n' + res.promptSuffix)
        }
        if (res.staged.length > 0) stagedDirs = [dir]
      }
    }
    if (prompt.trim() === '') {
      throw new EngineError('request carries no user text or images to forward to agy', Err.AGY_ERROR)
    }

    // In-flight duplicate submission debounce (prevents double-clicks / network repeat loops)
    if (sessionKey !== '') {
      const activePrompt = this.activeSessionPrompts.get(sessionKey)
      if (activePrompt !== undefined && activePrompt.prompt === prompt && Date.now() - activePrompt.startedAt < 3000) {
        throw new EngineError(
          'Duplicate request ignored: an identical request is already running for this session.',
          Err.BUSY,
        )
      }
      this.activeSessionPrompts.set(sessionKey, { prompt, startedAt: Date.now() })
    }

    // ---- dispatch with a single engine-level retry (M5) ----
    // One recording per LOGICAL run: every spawn attempt appends into it in
    // order, so the span consumer sees one seamless event stream and a
    // retried spawn adds no visible seam. The recording is settled exactly
    // once — after the retry loop — which is what guarantees a failure frame
    // can never reach the client before the retries are exhausted.
    const rec = this.deps.runs.create()
    const args = this.buildArgs({
      prompt,
      model: activeModel === '' ? cfg.defaultModel : activeModel,
      effort,
      conversationId: binding !== undefined ? binding.conversationId : undefined,
      permissionMode: cfg.permissionMode,
      timeoutMs: cfg.timeoutMs,
      printTimeoutMinutes: Math.max(240, Math.ceil(cfg.timeoutMs / 60_000)),
      extraArgs: cfg.extraArgs,
      addDirs: stagedDirs,
    })
    // --json-schema: write the schema to a temp file and append the argv tail
    // (absorbed from upstream oneshot.ts schemaArgs so /v1 endpoints can use
    // structured output without the oneshot machinery).
    let schemaCleanup: (() => Promise<void>) | null = null
    if (call.jsonSchema !== undefined && call.jsonSchema !== null) {
      const dir = await mkdtemp(join(tmpdir(), 'agy-schema-'))
      const file = join(dir, 'schema.json')
      await writeFile(file, JSON.stringify(call.jsonSchema), 'utf8')
      args.push('--json-schema', file)
      schemaCleanup = () => rm(dir, { recursive: true, force: true })
    }
    const release = await this.deps.acquire()
    let released = false
    const releaseOnce = (): void => {
      if (released) return
      released = true
      release()
      if (schemaCleanup) void schemaCleanup().catch(() => undefined)
    }

    // Only pool accounts run with an isolated HOME (their token file lives in
    // account.dir/.gemini); injecting HOME for the real user profile would
    // hide its agy login. Attempt-scoped: a retry may re-select the account.
    const envFor = (acc: typeof account): NodeJS.ProcessEnv => ({
      ...process.env,
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(acc && acc.dir ? isolatedHomeEnv(acc.dir) : {}),
      ...(acc?.proxyUrl
        ? {
            ALL_PROXY: acc.proxyUrl,
            HTTPS_PROXY: acc.proxyUrl,
            HTTP_PROXY: acc.proxyUrl,
            all_proxy: acc.proxyUrl,
            https_proxy: acc.proxyUrl,
            http_proxy: acc.proxyUrl,
          }
        : {}),
    })

    // Steer preemption lives on the recording, but the abort now has to
    // survive beyond the current process (a kill between retry attempts must
    // not be followed by a fresh spawn), so it flips a flag as well.
    let proc: ReturnType<typeof startAgyProcess> | undefined
    let steerAborted = false
    rec.requestAbort = () => {
      steerAborted = true
      proc?.kill('abort')
    }

    /** What one spawn attempt concluded. */
    interface AttemptResult {
      failure: { kind: 'error' | 'aborted'; code: string; message: string } | null
      outcome: RunOutcome
      rawErrText: string
      conversationId: string | null
      resultEvent: { ok: boolean; response: string } | null
      account: typeof account
    }

    const spawnFailed = (msg: string, acc: typeof account): AttemptResult => ({
      failure: { kind: 'error', code: Err.PROCESS_EXIT, message: msg },
      outcome: { code: null, signal: null, timedOut: false, aborted: false, stdout: '', stderrTail: '', durationMs: 0 },
      rawErrText: '',
      conversationId: null,
      resultEvent: null,
      account: acc,
    })

    const runOnce = async (index: number, attemptAcc: typeof account): Promise<AttemptResult> => {
      const task = async (): Promise<AttemptResult> => {
        // Superseded while queued (steer/abort) — don't spawn.
        if (rec.isSettled || steerAborted) {
          return spawnFailedAbort(attemptAcc)
        }
        // Per-account burst spacing throttle with randomized jitter (prevents high-frequency flood to Google endpoints)
        if (attemptAcc) {
          const lastSpawn = this.lastAccountSpawnTime.get(attemptAcc.id) ?? 0
          const elapsed = Date.now() - lastSpawn
          const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
          const targetInterval = this.minSpawnIntervalMs + jitter
          if (elapsed < targetInterval) {
            await new Promise((r) => setTimeout(r, targetInterval - elapsed))
          }
          this.lastAccountSpawnTime.set(attemptAcc.id, Date.now())
        }
        const parser = new StreamJsonParser()
        this.deps.onParser?.(parser)
        const before = snapshotConversations(attemptAcc?.dir || undefined)
        let streamCid: string | null = null
        // The binary seam is re-read per attempt: a retry may find a
        // (re)installed binary even when attempt 0 failed to spawn.
        const attemptBin = this.deps.bin() ?? bin
        try {
          proc = startAgyProcess({
            bin: attemptBin,
            args: [...(this.deps.binArgs ?? []), ...args],
            cwd: workspaceRoot,
            timeoutMs: cfg.timeoutMs,
            signal: call.signal,
            env: envFor(attemptAcc),
            onLine: (line) => {
              for (const ev of parser.feed(line + '\n')) {
                if (ev.kind === 'init' && ev.conversationId) streamCid = ev.conversationId
                if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
                rec.append(ev)
              }
            },
          })
        } catch (e) {
          // startAgyProcess funnels spawn errors into the outcome promise
          // (child 'error' → code null); a synchronous throw is exceptional —
          // but it used to leave the recording unsettled forever. Normalize.
          return spawnFailed('failed to spawn agy: ' + brief(String(e)), attemptAcc)
        }
        if (sessionKey !== '') this.activeRuns.set(sessionKey, rec)
        const outcome = await proc.outcome
        if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
        if (sessionKey !== '') this.activeSessionPrompts.delete(sessionKey)
        for (const ev of parser.flush()) {
          if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
          rec.append(ev)
        }
        const diffed = diffConversations(before, attemptAcc?.dir || undefined).conversationId
        const conversationId = streamCid ?? diffed
        // A result envelope the mapper will finish on: ok, or an error that
        // still carries a usable response. Anything else leaves the live span
        // un-finished, so the failure below reaches it through the recording.
        const r = rec.getResultEvent()
        // CANCELED-with-empty-response guard (Google issue #902, ~10% of long
        // tool turns): agy ends with status=CANCELED / empty response yet exits
        // 0, and the parser classifies it ok. The client would see an empty
        // success; intercept it as a retryable INVALID_OUTPUT failure instead.
        const canceledEmpty = r !== null && r.ok && r.response === '' && !rec.sawTextBefore(rec.length)
        const consumable = r !== null && (r.ok || r.response !== '') && !canceledEmpty
        // Error classification scans ONLY stderr and the result envelope's
        // error field. stdout is model prose + event JSON: a run whose streamed
        // text merely MENTIONED "rate limit"/"quota" (or contained a hash with
        // "429") used to be misclassified as a quota failure, masking the real
        // error and slapping a ghost cooldown on a healthy account.
        const rawErrText = [outcome.stderrTail, parser.stats.lastResultError].filter(Boolean).join(' ')
        const isRateLimit = looksLikeRateLimit(rawErrText)
        let failure: { kind: 'error' | 'aborted'; code: string; message: string } | null = null
        if (outcome.aborted) {
          failure = { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' }
        } else if (outcome.timedOut) {
          failure = { kind: 'error', code: Err.TIMEOUT, message: 'agy run was idle for ' + cfg.timeoutMs + 'ms without output' }
        } else if (sawAuthFailure(parser, outcome)) {
          failure = { kind: 'error', code: Err.AUTH, message: 'agy is not signed in — add a Google account to the pool (admin UI) to login' }
        } else if (looksLikeValidationRequired(rawErrText)) {
          // Google 403 re-validation: surface the challenge URL verbatim
          // (M3 DoD) and quarantine the account like an expired login.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : 'upstream requires re-validation (VALIDATION_REQUIRED)')
          const url = extractValidationUrl(detail)
          failure = { kind: 'error', code: Err.VALIDATION_REQUIRED, message: url !== undefined ? detail + ' (validation_url: ' + url + ')' : detail }
        } else if (isRateLimit) {
          const bestMsg = parser.stats.lastResultError || (outcome.stderrTail ? brief(outcome.stderrTail) : 'Rate limit or quota reached')
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'Google Antigravity quota / rate limit reached: ' + bestMsg }
        } else if (!consumable) {
          if (outcome.code !== 0) {
            // agy reports its failure on STDOUT as a result envelope and often
            // exits 1 with EMPTY stderr; dropping the envelope here used to
            // leave users with a bare "agy exited with code 1" and no cause.
            // Prefer the envelope's error text, then the stderr tail. A null
            // code separates the two no-envelope hazards (M5): a killed
            // process (signal present) and a spawn failure (runner sinks the
            // child 'error' string into stderrTail).
            const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
            const suffix = detail !== '' ? ': ' + detail : ''
            if (outcome.code === null) {
              failure = {
                kind: 'error',
                code: Err.PROCESS_EXIT,
                message: outcome.signal !== null
                  ? 'agy process was terminated (signal ' + outcome.signal + ')' + suffix
                  : 'failed to spawn agy: ' + (detail !== '' ? detail : 'unknown spawn error (binary missing or not executable?)'),
              }
            } else {
              failure = { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + suffix }
            }
          } else if (canceledEmpty) {
            failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy ended with an empty response (CANCELED, google antigravity #902)' }
          } else if (parser.stats.lastResultError) {
            failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
          } else {
            failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
          }
        }
        return { failure, outcome, rawErrText, conversationId, resultEvent: r, account: attemptAcc }
      }

      // ---- per-account serial queue (charter §6, p-queue concurrency:1) ----
      // One agy process per account at a time: two concurrent requests on the
      // same sticky account would race the per-HOME conversation discovery
      // (two fresh .db files → ambiguous diff) and interleave on one session
      // binding. The queue task spans the whole spawn→outcome window, so the
      // next same-account spawn waits for the previous process to exit.
      // Pool-off behavior is unchanged (the task runs immediately). Each
      // retry attempt queues independently — a retry NEVER awaits inside
      // attempt A's queue for account B's queue (concurrency:1 deadlock).
      if (attemptAcc != null) {
        let q = this.accountQueues.get(attemptAcc.id)
        if (q === undefined) {
          q = new PQueue({ concurrency: 1 })
          this.accountQueues.set(attemptAcc.id, q)
        }
        return await q.add(task)
      }
      return await task()
    }

    function spawnFailedAbort(acc: typeof account): AttemptResult {
      return {
        failure: { kind: 'aborted', code: 'ABORTED', message: 'agy run aborted by caller' },
        outcome: { code: null, signal: null, timedOut: false, aborted: true, stdout: '', stderrTail: '', durationMs: 0 },
        rawErrText: '',
        conversationId: null,
        resultEvent: null,
        account: acc,
      }
    }

    void (async () => {
      let attempt = 0
      let attemptAccount = account
      const fireRun = (r: AttemptResult, idx: number, final: boolean): void => {
        const rawUsage = rec.getResultRawUsage()
        this.deps.onRun?.({
          ok: r.failure === null,
          code: r.failure !== null ? r.failure.code : 'OK',
          attempt: idx,
          final,
          ...(r.failure !== null ? { failureMessage: r.failure.message } : {}),
          durationMs: r.outcome.durationMs,
          model,
          providerModel: activeModel === '' ? cfg.defaultModel : activeModel,
          usage: rawUsage !== null ? usageFromRaw(rec.finalUsage(rawUsage)) : null,
          ...(r.account != null ? { accountId: r.account.id } : {}),
          ...(family !== undefined ? { family } : {}),
          ...(r.conversationId != null && r.conversationId !== '' ? { conversationId: r.conversationId } : {}),
          ...(call.meta !== undefined ? { meta: call.meta } : {}),
        })
      }
      let last: AttemptResult
      try {
        for (;;) {
          if (rec.isSettled) return // steer settled the whole run as superseded
          last = await runOnce(attempt, attemptAccount)
          // Retry gate (M5): only outcome-level failures with nothing on the
          // wire. A result-shaped failure never emits span chunks (the mapper
          // returns passively on !ok with an empty response); the #902
          // CANCELED shape (ok + empty response) DOES ship a success finish,
          // so it is excluded — retrying behind an already-served client
          // would double-run. Any recorded step (text/reasoning/tool) may
          // have streamed to the client: no replay.
          const shapeOnly = last.resultEvent === null || (!last.resultEvent.ok && last.resultEvent.response === '')
          const canRetry =
            last.failure !== null &&
            shapeOnly &&
            RETRYABLE_CODES.includes(last.failure.code) &&
            !rec.hasClientMappedEvents()
          const final = !canRetry || attempt >= RETRY_POLICY.maxRetries || steerAborted || (call.signal?.aborted ?? false)
          fireRun(last, attempt, final)
          if (final) break
          attempt++
          await (this.deps.retryDelay ?? defaultRetryDelay)(RETRY_POLICY.initialDelayMs)
          if (rec.isSettled || steerAborted || (call.signal?.aborted ?? false)) {
            last = spawnFailedAbort(attemptAccount)
            fireRun(last, attempt, true) // the aborted settle still books exactly one final event
            break
          }
          // Same sticky selection as the first spawn, for the fixed family.
          // A retryable failure never touches account state, so this normally
          // returns the same account (now un-busy); an operator disable
          // mid-flight keeps the settled failure instead of a secondhand
          // POOL_EXHAUSTED.
          if ((this.deps.pool?.getAccounts().length ?? 0) > 0) {
            untrackBusy(attemptAccount?.id)
            const next = this.deps.pool?.selectAccount(family, busyAccounts) ?? undefined
            if (next === undefined) {
              trackBusy(attemptAccount?.id)
              break
            }
            attemptAccount = next
            trackBusy(next.id)
          }
        }
        releaseOnce()
        rec.settle(last.failure)
        if (last.failure === null) {
          if (last.account) this.deps.pool?.recordSuccess(last.account.id, family)
          if (sessionAccountKey !== '') {
            const finalId = binding !== undefined ? binding.conversationId : last.conversationId
            if (finalId) {
              this.deps.store.set(sessionAccountKey, {
                conversationId: finalId,
                lastMessageCount: messages.length,
                updatedAt: Date.now(),
                model: activeModel,
              })
            }
          }
        } else {
          const effectiveRateLimit = looksLikeRateLimit(last.rawErrText) || looksLikeRateLimit(last.failure.message)
          // Cooldown is a costly local penalty (account leaves rotation): only
          // HARD server-issued signatures may trigger it. Soft signals (model
          // overloaded) shape the message above but never cool the account.
          if (last.account && looksLikeHardRateLimit(last.rawErrText)) {
            this.deps.pool?.recordFailure(last.account.id, family, last.failure.message)
          }
          if (last.account && (last.failure.code === Err.AUTH || last.failure.code === Err.VALIDATION_REQUIRED || /invalid_grant|not signed in|auth/i.test(last.failure.message))) {
            this.deps.pool?.markAuthRequired(last.account.id, last.failure.message)
          }
          if (sessionAccountKey !== '') {
            if (
              last.failure.code === Err.AUTH ||
              effectiveRateLimit ||
              (last.failure.message && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(last.failure.message))
            ) {
              // If auth expired or rate limit hit or conversation rejected, drop stale binding
              this.deps.store.delete(sessionAccountKey)
            }
          }
        }
      } catch (err) {
        releaseOnce()
        rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
      } finally {
        untrackBusy(attemptAccount?.id)
      }
    })()

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it). The dispatch
    // loop above keeps the recording unsettled until the final attempt, so
    // this span simply never sees a failure frame until retries are done.
    yield* this.driveSpan(rec, 0, true)
  }

  /**
   * Stream one span of a recording: map events from `from` until the mapper
   * finishes (tool-calls cut or result stop), then let the queue drain. When
   * the recording settles without a consumable result, surface its failure
   * as this span's terminal chunk — the turn ends exactly like a native
   * provider error.
   */
  private async *driveSpan(
    rec: RunRecording,
    from: number,
    cutOnTool: boolean,
  ): AsyncIterable<StreamChunk> {
    const queue = new ChunkQueue()
    void (async () => {
      const mapper = new EventMapper({
        runId: rec.runId,
        cutOnTool,
        initialSawText: rec.sawTextBefore(from),
        usage: rec,
      })
      let i = from
      try {
        for await (const ev of rec.eventsFrom(from)) {
          for (const ch of mapper.map(ev, i)) queue.push(ch)
          i++
          if (mapper.isFinished) break
        }
        if (!mapper.isFinished) {
          const f = rec.failureInfo
          if (f !== null) {
            for (const ch of mapper.emitFailure(f.kind, f.code, f.message)) queue.push(ch)
          } else {
            for (const ch of mapper.emitFailure('error', Err.INVALID_OUTPUT, 'agy stream ended without a result event')) queue.push(ch)
          }
        }
      } catch (err) {
        for (const ch of mapper.emitFailure('error', Err.PROCESS_EXIT, 'internal error: ' + brief(String(err)))) queue.push(ch)
      }
      queue.close()
    })()
    yield* queue.drain()
  }
}

/**
 * Roll a workspace directory into existence lazily; a failure to create it
 * (read-only volume) is logged instead of failing the spawn —
 * startAgyProcess will surface the real spawn error anyway.
 */
function ensureWorkspaceDir(log: ((msg: string) => void) | undefined, dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    log?.('WARNING: workspace dir could not be created (' + dir + '): ' + brief(String(err)))
  }
}

/**
 * Detect a continuation span: the request's LAST message is the tool result
 * of one of our mirrored agy tool calls. Its callId encodes the recording
 * run and the event index to resume after.
 */
export function detectContinuation(messages: readonly EngineMessage[]): { runId: string; eventIndex: number } | null {
  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'tool') return null
  const callId = last.toolCallId
  if (typeof callId !== 'string' || callId === '') return null
  return parseMirrorCallId(callId)
}

// TokenUsage is re-exported so protocol layers depend on a single engine
// surface rather than importing stream-types separately.
export type { StreamChunk, TokenUsage } from './stream-types.ts'
