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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Err, looksLikeAuthFailure, looksLikeHardRateLimit, looksLikeRateLimit, type GatewayConfig } from '../common/types.ts'
import { modelFamilyOf } from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'
import { diffConversations, snapshotConversations } from './discovery.ts'
import { EventMapper } from './mapper.ts'
import { parseMirrorCallId, type RunRecording, type RunRegistry } from './recording.ts'
import { defaultEffortFor, findEntry, ModelCatalog, resolveModelSlug } from './models.ts'
import { StreamJsonParser } from './parser.ts'
import { defaultMediaDir, stageImages, type ImageRefLike } from './media.ts'
import { isolatedHomeEnv, startAgyProcess } from './runner.ts'
import { dataDir, stateDir } from '../common/config.ts'
import type { SessionStore } from './sessions.ts'
import type { StreamChunk, TokenUsage } from './stream-types.ts'

/** Engine failure with a stable routing code (maps 1:1 onto the Err table). */
export class EngineError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
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
}

export interface EngineDeps {
  getConfig: () => GatewayConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency. */
  acquire: () => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (continuation spans). */
  runs: RunRegistry
  /** Last-run telemetry surfaced by the admin status panel. */
  onRun?: (info: { ok: boolean; code: string; durationMs: number; model: string }) => void
  /** Reads image bytes from protocol-layer attachment storage. */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
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
}

/** Width/height are unknown at the protocol boundary; agy only uses the path. */
const UNKNOWN_DIM = 0

export class AgyEngine {
  private readonly warnedKeys = new Set<string>()
  /** sessionKey -> in-flight run, for steer-time preemption. */
  private readonly activeRuns = new Map<string, RunRecording>()
  /** sessionKey -> prompt info for duplicate submission debounce */
  private readonly activeSessionPrompts = new Map<string, { prompt: string; startedAt: number }>()
  /** accountId -> timestamp of last spawn for spacing throttling */
  private readonly lastAccountSpawnTime = new Map<string, number>()
  private readonly minSpawnIntervalMs = 500
  /** Global sliding window timestamps for batch rate-limiting protection */
  private readonly requestTimestamps: number[] = []

  constructor(private readonly deps: EngineDeps) {}

  private warnOnce(key: string, msg: string): void {
    if (this.warnedKeys.has(key)) return
    this.warnedKeys.add(key)
    this.deps.log?.('WARNING: ' + msg)
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
      mkdirWarnOnce(this.deps, workspaceRoot)
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
      if (prev !== undefined && !prev.isSettled) prev.requestAbort?.()
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
    let account = this.deps.pool ? this.deps.pool.selectAccount(family) : undefined
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
        const countdown = this.deps.pool.getEarliestResetCountdown(family)
        const waitStr = countdown ? ` (earliest reset in ${Math.ceil(countdown / 1000)}s)` : ''
        throw new EngineError(`All Antigravity accounts in pool are in cooldown for ${family}${waitStr}. Add an account or wait for reset.`, Err.AGY_ERROR)
      }
    }

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
        .filter((m) => m.role !== 'assistant')
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
    if (imageRefs.length > 0 && this.deps.readImage) {
      const dir = cfg.mediaDir !== '' ? cfg.mediaDir : defaultMediaDir(stateDir())
      const key = (sessionKey !== '' ? sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_') : 'anon') + '-' + messages.length
      const res = await stageImages({
        dir,
        key,
        images: imageRefs,
        readImage: this.deps.readImage,
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

    // ---- spawn + record (spans consume a shared recording) ----
    // Conversation-id discovery is per-ACCOUNT: pool accounts run with an
    // isolated HOME, so the conversations directory lives under account.dir,
    // never the gateway process's real HOME.
    const before = snapshotConversations(account?.dir || undefined)
    const rec = this.deps.runs.create()
    const parser = new StreamJsonParser()
    this.deps.onParser?.(parser)
    let streamCid: string | null = null
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
    // hide its agy login.
    const env = {
      ...process.env,
      ...(cfg.disableTelemetry
        ? {
            DO_NOT_TRACK: '1',
            DISABLE_TELEMETRY: '1',
            GOOGLE_CLOUD_DISABLE_TELEMETRY: '1',
            ANTIGRAVITY_DISABLE_TELEMETRY: '1',
          }
        : {}),
      ...(account && account.dir ? isolatedHomeEnv(account.dir) : {}),
      ...(account?.proxyUrl
        ? {
            ALL_PROXY: account.proxyUrl,
            HTTPS_PROXY: account.proxyUrl,
            HTTP_PROXY: account.proxyUrl,
            all_proxy: account.proxyUrl,
            https_proxy: account.proxyUrl,
            http_proxy: account.proxyUrl,
          }
        : {}),
    }

    // Per-account burst spacing throttle with randomized jitter (prevents high-frequency flood to Google endpoints)
    if (account) {
      const lastSpawn = this.lastAccountSpawnTime.get(account.id) ?? 0
      const elapsed = Date.now() - lastSpawn
      const jitter = Math.floor(Math.random() * 300) // 100~400ms organic jitter
      const targetInterval = this.minSpawnIntervalMs + jitter
      if (elapsed < targetInterval) {
        await new Promise((r) => setTimeout(r, targetInterval - elapsed))
      }
      this.lastAccountSpawnTime.set(account.id, Date.now())
    }

    let proc: ReturnType<typeof startAgyProcess>
    try {
      proc = startAgyProcess({
      bin,
      args,
      cwd: workspaceRoot,
      timeoutMs: cfg.timeoutMs,
      signal: call.signal,
      env,
      onLine: (line) => {
        for (const ev of parser.feed(line + '\n')) {
          if (ev.kind === 'init' && ev.conversationId) streamCid = ev.conversationId
          if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
          rec.append(ev)
        }
      },
      })
      if (sessionKey !== '') {
        rec.requestAbort = () => proc.kill('abort')
        this.activeRuns.set(sessionKey, rec)
      }
    } catch (e) {
      releaseOnce()
      throw new EngineError('failed to spawn agy: ' + brief(String(e)), Err.PROCESS_EXIT)
    }

    void (async () => {
      const outcome = await proc.outcome
      releaseOnce()
      if (this.activeRuns.get(sessionKey) === rec) this.activeRuns.delete(sessionKey)
      if (sessionKey !== '') this.activeSessionPrompts.delete(sessionKey)
      for (const ev of parser.flush()) {
        if (ev.kind === 'result' && ev.conversationId !== '') streamCid = ev.conversationId
        rec.append(ev)
      }
      const diffed = diffConversations(before, account?.dir || undefined).conversationId
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
      } else if (isRateLimit) {
        const bestMsg = parser.stats.lastResultError || (outcome.stderrTail ? brief(outcome.stderrTail) : 'Rate limit or quota reached')
        failure = { kind: 'error', code: Err.AGY_ERROR, message: 'Google Antigravity quota / rate limit reached: ' + bestMsg }
      } else if (!consumable) {
        if (outcome.code !== 0) {
          // agy reports its failure on STDOUT as a result envelope and often
          // exits 1 with EMPTY stderr; dropping the envelope here used to
          // leave users with a bare "agy exited with code 1" and no cause.
          // Prefer the envelope's error text, then the stderr tail.
          const detail = parser.stats.lastResultError ?? (outcome.stderrTail !== '' ? brief(outcome.stderrTail) : '')
          failure = { kind: 'error', code: Err.PROCESS_EXIT, message: 'agy exited with code ' + outcome.code + (detail !== '' ? ': ' + detail : '') }
        } else if (canceledEmpty) {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy ended with an empty response (CANCELED, google antigravity #902)' }
        } else if (parser.stats.lastResultError) {
          failure = { kind: 'error', code: Err.AGY_ERROR, message: 'agy reported an error: ' + parser.stats.lastResultError }
        } else {
          failure = { kind: 'error', code: Err.INVALID_OUTPUT, message: 'agy produced no result event (' + parser.stats.garbage + ' unparseable lines)' }
        }
      }
      rec.settle(failure)
      if (failure === null) {
        if (account) this.deps.pool?.recordSuccess(account.id, family)
        if (sessionAccountKey !== '') {
          const finalId = binding !== undefined ? binding.conversationId : conversationId
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
        const effectiveRateLimit = isRateLimit || looksLikeRateLimit(failure.message)
        // Cooldown is a costly local penalty (account leaves rotation): only
        // HARD server-issued signatures may trigger it. Soft signals (model
        // overloaded) shape the message above but never cool the account.
        if (account && looksLikeHardRateLimit(rawErrText)) {
          this.deps.pool?.recordFailure(account.id, family, failure.message)
        }
        if (account && (failure.code === Err.AUTH || /invalid_grant|not signed in|auth/i.test(failure.message))) {
          this.deps.pool?.markAuthRequired(account.id, failure.message)
        }
        if (sessionAccountKey !== '') {
          if (
            failure.code === Err.AUTH ||
            effectiveRateLimit ||
            (failure.message && /conversation.*(not found|invalid|not recognized|expired|does not exist)|session.*(expired|invalid)/i.test(failure.message))
          ) {
            // If auth expired or rate limit hit or conversation rejected, drop stale binding
            this.deps.store.delete(sessionAccountKey)
          }
        }
      }
      this.deps.onRun?.({
        ok: failure === null,
        code: failure !== null ? failure.code : 'OK',
        durationMs: outcome.durationMs,
        model,
      })
    })().catch((err) => {
      releaseOnce()
      rec.settle({ kind: 'error', code: Err.PROCESS_EXIT, message: 'internal error: ' + brief(String(err)) })
    })

    // First span of the run: stream recorded events until the first
    // completed tool step cuts it (or the result finishes it).
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
 * (read-only volume) is reported once per directory instead of failing the
 * spawn — startAgyProcess will surface the real spawn error anyway.
 */
function mkdirWarnOnce(deps: EngineDeps, dir: string): void {
  void import('node:fs').then(({ mkdirSync }) => {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      deps.log?.('WARNING: workspace dir could not be created (' + dir + '): ' + brief(String(err)))
    }
  })
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
