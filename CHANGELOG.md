# Changelog

All notable changes to agy-proxy are documented here. Format based on Keep a Changelog; versions follow semver.

## [Unreleased] (协议格式补齐)

Protocol-surface audit (OpenAI Chat Completions + Anthropic Messages) against the current
official specs: seven quick wins, four behavioral fixes, docs synced. Architecture
unchanged — agy still runs its own tool loop; the gateway remains a mirror.

### Added
- **Streaming `stop_sequences` enforced on both legs** (src/server/stream-guards.ts, new
  `StopHoldback`): the SSE layer withholds any text tail that could still be the prefix
  of one of the stop sequences and cuts at the first full hit — across delta boundaries,
  text stream only (reasoning deltas never cut). OpenAI answers `finish_reason:'stop'`;
  Anthropic answers `stop_reason:'stop_sequence'` with the matched sequence echoed in
  `stop_sequence` (previously always `null` in streams). A stop hit never overrides a
  `tool-calls` terminal — the tool_use block already streamed and the client must keep
  its loop. Held tails flush before the terminal events so no generated text is lost.
  Earliest match wins; exact ties keep the client's first-listed stop.
- **Streaming `max_tokens` enforced on both legs** (`OutputBudget`): output estimate
  accumulates via the same `estimateTokens` heuristic as count_tokens (text + reasoning
  deltas + tool-call arguments, delta granularity — no tokenizer), and reaching the cap
  aborts the agy process mid-generation instead of letting it run on. OpenAI answers
  `finish_reason:'length'`, Anthropic `stop_reason:'max_tokens'` (previously never
  surfaced on streaming). Budget accounting reads the RAW generated text, so held-back
  stop-prefix tails count too.
- **Anthropic trailing tool_result data preservation**: the trailing user turn collapsed
  into one tool message per-block overwrite — with multiple `tool_result` blocks only the
  LAST survived and sibling text blocks vanished silently. Now: texts merge with
  `'\n\n'`, the continuation cursor takes the largest `parseMirrorCallId` eventIndex
  (furthest replay point), and sibling text blocks ride along under a
  `[user context] ` prefix (the engine's continuation keys on the last message being
  role:'tool' and replays without a prompt, so the merged tool message is the only path
  where that data survives). Foreign ids still 400, including when mixed with valid ones.
- **`message_start.usage.input_tokens` heuristic estimate** (was hardcoded 0): the
  Anthropic streaming opener now carries `estimateInputTokens` (messages + system + tool
  definitions + tool_result contents), keeping cost-tracking clients from recording
  zero-prompt turns; real engine usage still lands in the final `message_delta`.
  Three anthropic streaming goldens re-pinned (an2/an3/an5).

### Fixed
- `response_format {"type":"text"}` — a spec-legal value — was rejected 400; now a
  no-op. Only genuinely unknown types are rejected.
- `stream_options.include_usage` intermediate chunks now carry `"usage": null` (OpenAI
  spec: the key is present-but-null until the terminal frame); goldens oa2/oa3 re-pinned.
- Silently dropped parameters now warn: OpenAI `IGNORED_PARAMS` gains
  `logit_bias/verbosity/modalities/prediction/top_k`; the `json_object` warning no longer
  claims a gateway-side parse check that never existed (prompt instruction only).
- Anthropic leg warning parity: `tool_choice/betas/mcp_servers/service_tier/output_format`
  were silently ignored; each now warns like the OpenAI leg does.
- `count_tokens` undercounted: tool definitions (JSON-serialized, per element) and
  `tool_result` contents (string or text-block array) now count toward the estimate;
  images stay flat 1000.
- Error bodies aligned with the official shapes: OpenAI errors carry `param: null`
  (goldens oa8a/oa8b/oa8c/oa9/ma3 re-pinned); Anthropic errors carry a top-level
  `request_id` (the gateway request id) on every path — shared handler, auth hook, quota
  rejections, disabled-gateway 503, 404/415/400/500 fallbacks, and in-golden 401/429/400
  bodies (an8a/an8b/an8c re-pinned).
- Whitespace-only `model` strings (`' '`) no longer silently fall back to the default
  model on the Anthropic leg — both legs answer 400 `model must be a non-empty string`.

### Docs
- charter §4.2/§4.3/§4.4 + README "Request surface notes" synced: streaming
  stop/max_tokens semantics, `[user context] ` merge rule, `prompt_tokens` = uncached
  input (client conversion hint: add `cached_tokens`), `message_start` estimate,
  `reasoning_content` non-standard / no `content_filter`/`refusal`/`pause_turn`,
  `n>1` + document/citations/search_result → 400, corrected json_object wording.

## [Unreleased] (M5 加固发布)

### Added
- **Engine-level single retry** (src/host/engine.ts): `RETRYABLE_CODES`/`RETRY_POLICY` existed since the ADR-11 port with zero consumers. Now: retryable failure classes (TIMEOUT / PROCESS_EXIT / no-result INVALID_OUTPUT) get exactly one dispatch-level retry with the jittered policy delay, one recording per LOGICAL run so the span streams seamlessly across the attempt boundary and a failure frame can never reach the client before retries are exhausted. No-replay guards: any recorded step event (`hasClientMappedEvents()`, recording.ts's third documented modification) plus every finish-capable result shape (ok, error-with-response, and the #902 CANCELED empty success) block the retry. Spawn failures joined the loop (the old spawnGate throw leaked the recording unsettled) with explicit 'failed to spawn agy: …' / 'terminated (signal …)' messages; `deps.bin()` re-read per attempt. `onRun` gains `{attempt, final, failureMessage?}`.
- **Busy-aware account spread** (src/host/pool.ts + engine.ts): selection was not busy-aware — three same-family arrivals before any settle stacked onto one account's queue (measured ratio 0.9× where two-and-a-half was required). `selectAccount(family, busy?)` skips tracked accounts and recurses to unfiltered selection when the whole pool is busy; the engine tracks selected accounts until the dispatch finally block. *(M5 drill correction: the tracking first shipped as a per-stream() local Set — a no-op across concurrent requests, so spread never actually happened and the 2.7× perf reading was timing luck; the soak/perf leg-6 account diagnostics exposed the stacking. Tracking now lives at engine level (shared Set + refcount), pinned by a concurrent-arrival unit test asserting three distinct accountIds.)*
- **Per-key model whitelist enforcement** (engine + key-store + errors): `EngineDeps.getScopes(keyId)` → the engine judges the model ACTUALLY SERVED (deliberately after fallback-model resolution) pre-spawn; violations answer `Err.MODEL_NOT_ALLOWED` → 403 permission_error in both protocol tables. Root key / absent callback / cleared whitelist bypass (empty = unrestricted, not deny-all). `KeyStore.update` patches scopes; `parseKeyScopes` splits on newline/comma/semicolon.
- **Usage ledger schema v2 `error_text`** (db.ts + usage-ledger.ts): terminal failure text stored next to its row, truncated 500 chars at record(); `PRAGMA table_info`-guarded in-place migration for v1 databases (rows preserved, idempotent); first-wins request-id idempotency untouched. `GET /admin/usage` rows carry `errorText`.
- **Usage page error detail + CSV column**: failed rows expand an in-place error-detail row under the clickable status chip (aria-expanded); CSV export adds the `error_text` column (empty on OK rows).
- **Keys page scopes editor**: the "planned M5" placeholder badge became a live whitelist-size badge plus a monospace scopes input (empty IS the unrestricted affordance); `patchKey` carries `scopes: string | null`.
- **Soak harness + perf baseline** (scripts/soak.mts, scripts/perf.mts — acceptance §4): soak = mixed 3-lane load with mode-file failure windows + admin recovery + /healthz probes + RSS/handle sampling; error matrix (six modes incl. kill-early rescue and kill-mid no-replay); `taskkill /T /F` ×3 with exact ledger reconciliation. perf = 8 legs vs a bare-pipe reference — all green at the final sha (first-delta Δ13ms, non-stream Δ5ms, ledger P95 957ms, 3-account 11.7× after the busy-spread fix, flood 20k error-free, models cold 4ms, RPM 429 + Retry-After). Harness judging fixes from the drill itself (see docs/verify/m5.md): hijacked SSE streams answer 200 before the engine outcome, so stream-lane "ok" is judged from the stream body's error frames, not the HTTP status; failure-window recovery waits a 12s settle grace before clearing cooldowns (lagged in-flight settlements legitimately re-cool — the 429 was real), keeping the tail in-window; the handle verdict compares the per-bucket p50 idle floor instead of late-max-vs-early-min (active handles scale with in-flight work — a leak ratchets the floor, load only lifts the ceiling); the RSS verdict became a no-ratchet check (last bucket p50 ≤ peak earlier bucket p50 + 16MB) after a 20-minute dumped-series probe proved the back-half "slope" is a V8 heap sawtooth that contracts from its ~250M high-water; `scripts/` is now inside the typecheck gate (a harness ReferenceError had escaped it).
- **`AGY_PROXY_DEBUG_METRICS_MS`** (config `debugMetricsMs`): the gateway emits one NDJSON `{"debug":"metrics", rss, handles, uptime}` line per tick for the harness (raw stdout, not pino). Registered in README.
- **fake-agy**: `FAKE_AGY_MODE_FILE` (mode re-read per process start — the mechanism for flipping failure modes between retry attempts), `kill-early`/`kill-mid` self-SIGKILL rescue/no-replay drills (win32 documents exit 1/no-signal, POSIX signal SIGKILL — both PROCESS_EXIT), `flood` mode (20k events, no awaits).

### Fixed
- **API-key display prefix derived from the plaintext's first 8 chars = the constant marker** (M5 security-audit drill finding; latent since M3): every plaintext starts with `sk-agy-` (7 chars), so the stored/echoed 8-char "distinguishing" prefix was `sk-agy-` + 1 char — the marker string rested in the `api_keys.prefix` DB column (red line: the marker never rests in the DB) and identified nothing. Now `generateApiKey()` slices the 8 chars AFTER the marker (`KEY_MARK` shared with db.ts), the v2 migration data-fix strips the marker from legacy rows (idempotent, varying tail kept), and tests pin prefix shape + `not.toContain('sk-agy-')` on the create-response echo. Plaintext handling unchanged (shown exactly once, never logged — re-verified by a live audit probe: 18 unauthenticated-route posture checks + key lifecycle + full server-log grep = 0 hits).
- **Usage ledger flush never aborts the process**: a failed transaction escaped the throwaway `void`-flush chain as an unhandled rejection (disk full = process kill, violating the DoD). Bounded requeue (`MAX_PENDING_ROWS=5000`, oldest dropped beyond it), failure warning throttled to one per 60 s, and a fully guarded `close()`.
- **Settings overrides writer strands the .tmp on failure**: now unlinked best-effort and rethrown — a failed write leaves exactly the pre-call state.
- **Pool-auth done-reset timer unref'd** — the 30 s 'done' hold kept the event loop alive past shutdown intent.
- **Media TTL sweeper wired at boot + hourly interval** (src/host/media-sweeper.ts, new file — media.ts is a verbatim port and stays diffable): `sweepDir()` had been ported and pinned since M1 but never scheduled; staged client images accumulated without bound. `mediaTtlMs <= 0` disables; the engine's mediaDir resolution is mirrored.
- **Client-boundary token scrub**: terminal failure text crossed to clients unscrubbed; new narrow `scrubTokenMaterial()` (ya29.*/Bearer/anchored `4/` codes; URLs and prose untouched — redactLine() would destroy the validation_url feature passthrough) wired at the single funnel `EventMapper.emitFailure`.
- **Dockerfile `AGY_CLI_VERSION` pinned to 1.1.22** (m1.md record), closing the charter L148 floating-tag violation; compose + .dockerignore added. The compose `image:` reference is env-interpolated (`AGY_PROXY_IMAGE`) and `docs/deploy.md` 路径 C covers a 1Panel 编排 deployment pulling from Docker Hub (primary registry, image pushed only on the explicit release command); no-reverse-proxy posture documented as loopback bind + SSH tunnel.

### Deliberate deviations (M5)
- **`hasClientMappedEvents()` counts step events only**, not result envelopes: the mapper emits chunks from a result only for finish-capable shapes, and the retry gate excludes those independently — a passive error envelope (`!ok`, empty response) maps to zero chunks, so the plan's "任一 step/result 事件" shorthand is implemented to its stated intent (客户端可见输出) rather than its letter.
- **Retry re-selection keeps the settled failure on an empty-pool miss** instead of raising secondhand POOL_EXHAUSTED: the first attempt's outcome is the client-visible truth; pool emptiness mid-retry is only reachable via operator action, not retryable failures.
- charter "中途重放 M5 复议" (§6) **decided: maintain the M3 decision** — the new engine-level retry is orthogonal (nothing-on-the-wire failures only) and does not reintroduce transparent replay; documented in charter §6.

## [Unreleased] (M4 管理 WebUI)

### Added
- **WebUI (`web/`, React 19 + Vite 8 + Tailwind v4 + TanStack Router/Query + react-i18next)**: six pages (charter §9) riding the admin JSON + SSE surface — login; dashboard (today's stats + live run feed + recent errors); accounts (dual 5h/weekly quota bars with reset countdowns, live cooldown countdowns + reasons, health badges incl. `VALIDATION_REQUIRED` + `validation_url` surfacing, paste-URL login with same-origin QR, enable/disable/proxy/clear-cooldown/refresh); API keys (create-once plaintext dialog gated by an "I saved it" checkbox, quota edits, disable/delete); usage log (filters + 50-row pages + status chips + client-side CSV export of the filtered rows); settings (effective vs in-file values, env-locked lock hints, `permissionMode=skip` behind a consequence dialog + typed SKIP confirmation per charter §10, with an app-wide warning banner in the shell). zh-CN default with EN switch (persisted, navigator detection), light/dark/system theme (pre-paint, no FOUC), 375px-responsive layouts. i18n discipline is mechanically enforced: zh/en key-set identity is tested, and all CJK lives in `.ts` resource files (acceptance greps only `*.tsx`).
- **Admin event bus + `GET /admin/events`** (src/server/events.ts): the server had no push surface. Monotonic seq `id:`-stamped SSE events (`snapshot`/`run`/`pool`), a 200-event ring for `Last-Event-ID` reconnect replay with snapshot XOR replay semantics (never both — no gap merging, no duplicate rows), trailing-edge 250ms-debounced pool snapshots via the new pool `onChange` hook, and `run` events carrying exactly the usage-ledger fields from the same `onRun` hook. SseWriter gained optional `id` framing; hijacked streams register explicit end callbacks because `app.close()` does not close hijacked connections.
- **Settings write path** (src/server/settings.ts): `GET/PUT /admin/settings` — a 9-key allowlist (defaultModel, defaultEffort, timeoutMs, maxConcurrent, maxQueueDepth, permissionMode, enabled, autoFallbackModel, quotaPollIntervalMs) written atomically (tmp+rename) to `runtime-overrides.json`, clamps mirroring resolveConfig's env rules line-for-line, hand-edited keys preserved, `apiKey`/`adminPassword` and boot-critical keys excluded. Env-owned keys are reported per-key (`envLocked`) rather than rejected: the file stores the requested value so it becomes effective the day the variable is removed.
- **Static WebUI hosting** (src/server/static.ts, @fastify/static ^8 — charter §8 amendment): `wildcard:false` per-file routes can never shadow the /v1, /admin, /healthz literals; the SPA fallback rides in front of the single not-found handler for dot-free GET non-API paths; every cache-control decision is owned (`cacheControl:false` — send()'s default `public, max-age=0` would have overridden setHeaders), hashed assets immutable 1y, index `no-cache`. No built frontend → JSON-only no-op with one info log; a broken `AGY_PROXY_WEB_DIST` can never take the server down.
- **CI/CD**: root `build` chains `tsdown && npm --prefix web run build` (development.md §3 semantics); CI installs web deps, runs the web vitest suites and a `web/src` console.log fence (G4 parity); Dockerfile gained a web build stage finally feeding the `COPY web/dist` line it always had.

### Fixed
- **Unsupported content-type → 415** (closes the m3 drill finding): `FST_ERR_CTP_*` fell into the 500 branch; now a first-class 415 with per-surface bodies (admin `{ok:false}`, dual-protocol OpenAI/Anthropic) and the offending content-type named in the message (Fastify's own CTP message does not).
- CI push trigger corrected `main` → `master` — the default branch had never run push CI (pre-existing mismatch).

### Deliberate deviations (M4)
- **No error-text column in the usage page**: ledger schema v1 has none; the page shows status codes (chip per code) and the raw text stays in gateway logs. `errorText` is a schema-v2/M5 candidate. This deviates from charter §9 page-5 wording and is recorded here instead of faking a field. *(Landed in M5: schema v2 `error_text` + usage-page detail row + CSV column.)*
- **TanStack Virtual not introduced** (charter §9 principle): the log table is server-paginated ≤500 rows where virtualization costs a11y and bundle for no gain; charter §8 WebUI row annotated. Revisit if M5 adds an unbounded live log.
- **Per-key model whitelist (scopes)**: enforcement deliberately deferred to M5 (user decision); the keys UI shows a read-only "planned M5" badge instead of a dead edit form. *(Landed in M5: engine pre-spawn enforcement via `getScopes` + keys-page scopes editor.)*
- Dashboard "success rate" derives from two from-midnight ledger queries (all vs `status=OK`) because the day summary carries no status split.

## [Unreleased] (M3 池与记账)

### Added
- **SQLite storage** (src/server/db.ts, commit a05a56d): `openDb()` — WAL + `synchronous=FULL` + `busy_timeout=5000` + `foreign_keys=ON`, `user_version`-gated idempotent schema v1 (`api_keys`, `usage` with `request_id UNIQUE`, `admin_sessions`, `admin_settings`), `checkpointAndClose()` (`wal_checkpoint(TRUNCATE)` + close). Charter §6 崩溃恢复 row: WAL+FULL survives SIGKILL with at most the last 1s ledger buffer lost (≤ ±1 request, MA5 tolerance).
- **Key management** (src/server/key-store.ts, commit 9d9b56d): `KeyStore` — plaintext format `sk-agy-` + 24B base64url, returned **exactly once** at creation; the DB stores a sha256 hex hash (UNIQUE) plus an 8-char prefix for display (LiteLLM pattern; high-entropy keys need no slow hash). `verify()` verdicts ok/unknown/disabled; day-token budgets and RPM limits per key; `touch()` best-effort last-used refresh.
- **Usage ledger** (src/server/usage-ledger.ts, commit 85781fa): `UsageLedger` — record() is an O(1) in-memory push (never blocks the stream); 1s unref'd flush timer, 500-row opportunistic flush, transaction-batched `INSERT OR IGNORE` for **request-id idempotent replay**; `tokensUsedToday(keyId)` sums since local midnight (day-budget enforcement); `summarizeToday()`/`query()` (limit ≤ 500); `close()` = flush → checkpoint → close, post-close record() is a one-warn no-op.
- **Auth hook v2** (src/server/auth.ts, commit 5574d4a): verdict order = auth-disabled posture FIRST (no env key AND no managed keys → open) → missing header 401 (bodies byte-identical to M2) → root env key (unlimited, keyId=null) → managed keys: unknown → 401, disabled → 403 `key_disabled`, RPM over limit → 429 + `retry-after` (rate-limiter-flexible Memory, keyed `keyId:rpm`), day-token budget over → 429 with used/limit/reset message. Budget and RPM checks run **pre-engine**: a rejected request never spawns agy and never books a ledger row. `request.agyKey={id,name}` annotates the request for call meta.
- **Admin API (JSON)** (src/server/admin-api.ts + admin-session.ts, commit bf86bd9): guard chain per request — CIDR allowlist (`adminAllowCidr` re-read per request, `::ffff:`/::1 normalized) → session cookie (opaque 32B token, sha256 in `admin_sessions`, HttpOnly SameSite=Lax, TTL 7d) → CSRF (mutating methods require a non-empty `x-requested-with` header). Routes: login (300ms damping on failure)/logout/me, status, pool CRUD + cooldown-clear + quota-refresh + mode + reorder, paste-URL auth flow (begin/status/complete/cancel) + **QR PNG rendering** (qrcode; 404 unless `phase === 'waiting'`, `Cache-Control: no-store`), key lifecycle, usage query/summary. `ensureAdminPassword`: env password wins and re-hashes (argon2id, @node-rs/argon2 — **used ONLY for the admin password**) at boot; otherwise stored hash; otherwise a random password is generated and logged exactly once (`@node-rs/argon2` native dep purpose).
- **Engine hardening** (src/host/engine.ts, commit eb40fde):
  - `Err.POOL_EXHAUSTED`: an all-cooling/quarantined pool → 429 `rate_limit_error` with `Retry-After` from `earliestResetMs(family)` (min of live cooldowns and future 5h/weekly quota reset times, message carries the reset countdown). Replaces the old AGY_ERROR→502 for this case.
  - `Err.VALIDATION_REQUIRED`: narrow regex on stderr/result-error only (`/VALIDATION_REQUIRED/i`); `extractValidationUrl` appends `(validation_url: …)` to the passthrough message → 403 `permission_error`; the account is quarantined via `markAuthRequired`.
  - **Hard-rate-limit in-flight semantics (user decision, charter §6 amended)**: an in-flight hard 429 fails THAT request (real upstream error passed through, 502 family) and cools the account down; the NEXT request auto-switches accounts. No in-flight transparent replay in v1 (agy has no partial continuation; M5 revisits).
  - **Per-account serial queue** (p-queue concurrency:1): pool-selected spawns serialize per account — fixes the same-account concurrent-conversation-binding race that pool wiring would otherwise expose. Continuations (tool-result resumes) bypass the queue.
  - **Enriched `onRun` + `EngineCall.meta`**: `{…, usage, accountId, family, conversationId, meta}` where meta = `{reqId (x-request-id ?? fastify req.id), keyId, protocol}`. One hook fire per actual agy spawn (settlement; continuations bypass; pre-flight rejects never fire) → `ledger.record()`.
- **M3 wiring** (src/index.ts, commit 019ff23): openDb → keys/ledger/sessions → `ensureAdminPassword` → pool/quota/poolAuth with redacted logs → boot sweeps (`sweepStaleStaging`, `sweepOldLogs`) → engine gets the pool + ledger-writing onRun → server mounts `/admin` → 5s boot quota refresh + `setInterval(max(60s, quotaPollIntervalMs))` poller → shutdown teardown (clear timers → `poolAuth.cancel()` → `ledger.close()` flush+checkpoint).
- **Config**: `AGY_PROXY_DB_PATH` (`dbPath`, default `<dataDir>/agy-proxy.db`), `AGY_PROXY_ADMIN_SESSION_TTL_MS` (7d, clamped ≥ 60s); README config table completed (ADMIN_ALLOW_CIDR / ADMIN_PASSWORD / TRUSTED_PROXIES / QUOTA_POLL_INTERVAL_MS / LOG_RETENTION_DAYS had been parsed since M0 but undocumented).
- **fake-agy**: `rate-limit` mode (stderr `429 RESOURCE_EXHAUSTED … Resets in 21m25s` + ERROR envelope, exit 1), `validation` mode (403 VALIDATION_REQUIRED + Google challenge URL), `FAKE_AGY_FAIL_HOME` (fails only the account whose isolated HOME matches — enables switch drills).
- **Tests**: 292 total (was 249, +43): db/key-store/usage-ledger unit suites, auth-keys MA4/MA5 dual-protocol matrix (root key unchanged, disabled 403, RPM 429, day-budget 429, cross-key isolation), admin-api 12-case suite (guards/CSRF/CIDR/keys/auth-flow/QR), pool-gateway drills (DoD ③ 429-switch + exhaustion 429, DoD ④ 403 validation_url + quarantine).

### Changed
- `GatewayHttpError` carries optional `headers`; the app error handler forwards them (Retry-After now actually reaches clients).
- `tsdown.config.ts`: `better-sqlite3` / `@node-rs/argon2` externalized (native modules never inlined).
- `installShutdown` accepts `teardown?` — runs after `app.close()`, before exit; errors still exit 1.

### Deliberate semantics (M3)
- The root env key has no day budget and no RPM limit by design (bootstrap key).
- A crash loses at most the last ~1s of ledger buffer (bounded by MA5 tolerance); WAL+FULL recovers everything else.
- Key plaintext exists only in the POST /admin/keys response body; the string `sk-agy-` never appears in logs (G4-checked) or in the DB.

## [Unreleased] (M2 双协议完整)

### Added
- **Streaming SSE on both protocols**: `POST /v1/chat/completions` and `POST /v1/messages` with `stream: true` (`reply.hijack` + raw writes). OpenAI leg: first frame `delta:{role,content:""}`, `delta.reasoning_content` for thinking (industry-convention field, documented as non-official), tool_calls on block-end, `finish_reason` frame, usage-only trailing frame with `stream_options.include_usage`, `[DONE]` sentinel. Anthropic leg: `message_start` → `content_block_start/delta/stop` (thinking/text/tool_use with `input_json_delta`) → `message_delta` (stop_reason + `usage.output_tokens_details.thinking_tokens`) → `message_stop`. Terminal errors surface as in-stream error payloads per protocol.
- **`SseWriter`** (src/server/sse.ts): backpressure-aware raw writes, heartbeat comments (`: ping` OpenAI style / `ping` event Anthropic style) gated on `cfg.sseHeartbeatMs` (default 60s, `AGY_PROXY_SSE_HEARTBEAT_MS` env, 0 = off; heartbeats only fire when no real event has been written for the interval), and immediate engine abort on client disconnect (charter gap-g closure).
- **Anthropic Messages endpoint** (POST /v1/messages): system string/array equivalence, all content-block kinds (text/image data:/base64/thinking/redacted_thinking/tool_use/tool_result), `max_tokens` required (400 otherwise), `thinking` budget tiers (≤4096→low / ≤16384→medium / >16384→high), `stop_sequences` gateway-side cut with `stop_sequence` echo + `stop_reason:'stop_sequence'`, `output_config.format`/`response_format` json_schema equivalence with the OpenAI leg, `x-api-key` accepted alongside Bearer. Anthropic usage mapping: disjoint input/output, `cache_read_input_tokens`, gateway extension `output_tokens_details.thinking_tokens`. No `signature_delta` is ever emitted (agy provides no signatures; inbound signatures are not validated — AN4 tamper leg N/A, documented in charter §4.3).
- **`POST /v1/messages/count_tokens`** (AN7): deterministic heuristic (CJK chars @1 token, Latin ~4 chars/token), declared approximate via the `x-agy-proxy-token-estimate: heuristic` response header; ±30% accuracy envelope.
- **Model routes** (MA1–MA3): `GET /v1/models` OpenAI-shaped by default, Anthropic-shaped under an `anthropic-version` header; `GET /v1/anthropic/models` always Anthropic-shaped (Anthropic SDK base_url can point at the host root); `GET /v1/models/{id}` retrieve with 404 `model_not_found`. Anthropic shape carries `after_id`/`before_id`/`limit` pagination (default 20, cap 1000) with `first_id`/`last_id`/`has_more`.
- **Widened OpenAI request surface**: `tools`/`tool_choice` accepted with a warning (client tool definitions are NOT executed — M2 decision; only agy's own tool activity mirrors as round trips), assistant `tool_calls` history accepted as foreign turns into the digest, `data:`/base64 images staged to disk and passed via `--add-dir` with `view_file` prompt integration (http(s) URLs → 400; SSRF-safe fetch is an M5 candidate).
- **Gateway-side truncation** (OA10): `max_completion_tokens` cuts text proportionally (`text.length * max / usage.outputTokens`, approximate by design — no tokenizer; thinking tokens inflate outputTokens). Tool-call spans are never truncated. `finish_reason:'length'` remap.
- **Model pre-validation** (OA8): with a DISCOVERED catalog, unknown model ids → 404 `model_not_found` with the available list; the fallback catalog stays advisory (dual behavior documented in README).
- **Golden cases**: `test/golden/` directory-driven runner generalized to all three surfaces (openai/anthropic/models) with field-walk diffs, raw-text sentinels (`__ID__`/`__AGYTC__`/`__UUID__`, created→0 on chat only, MODEL_CREATED literal on listings), `_status`/`_provenance` keys, per-case `case.json` (apiKey/fakeAgyExitCode/discoveredModels). 26 cases: oa1–oa10 (OpenAI), an1–an10 (Anthropic), ma1–ma3 (models), each with PROVENANCE.md citing acceptance §2 sources.

### Changed
- `AGY_NOT_INSTALLED` → 503 is now routed through the same error table as every other engine code (no behavior change; table documented in errors.ts).
- Auth hook renders per-protocol 401 bodies: `{error:{...}}` on OpenAI paths, `{type:'error',error:{...}}` on Anthropic paths.
- fake-agy gained `FAKE_AGY_EXIT_CODE` (replay exit semantics) and `slow` mode (delayed events for heartbeat tests).
- Engine: `call.readImage ?? deps.readImage` — request-scoped image byte maps (protocol adapters decode data: URIs) instead of a single injected reader.

### Removed
- M1 restrictions lifted: `stream:true` and `tools` no longer 400 on OpenAI; images no longer 400 on either protocol (data:/base64).

## [0.1.0] - 2026-08-30 (M1 引擎移植 + M1 收尾)

### Added
- **Engine layer ported from dsh-agy-link @ 46984db** (commits 5a4ddf7, 25a3442, 716fc3f): parser, runner, recording, mapper, pool, pool-auth, quota, oauth, net, sessions, media, models, discovery, diagnostics, mirror (shrunk), engine.ts (adapter rewrite to a self-owned `EngineCall → AsyncIterable<StreamChunk>` vocabulary). 134 tests ported to vitest, fake-agy realigned + `hang` mode + argv `binArgs` seam for Windows.
- **Fastify service layer** (src/server/): app factory (`buildServer`), OpenAI Chat Completions non-streaming route, static-key auth, gateway semaphore (maxConcurrent + maxQueueDepth → 429 BUSY), pino NDJSON logging with header redaction, graceful shutdown (SIGTERM/SIGINT → 25s grace → abort in-flight agy runs → close).
- **POST /v1/chat/completions** (non-streaming): full OA1 surface — chat.completion body, model echo, finish_reason mapping, OpenAI usage details (cached/reasoning tokens). Charter §4.2 mapping: reasoning_effort folding, json_object prompt injection, native `--json-schema` passthrough, stop post-truncation, explicit 400s for streaming/tools/audio/n>1. agy's real error text always surfaces in `error.message` (v0.4.21 lesson); native agy tool activity appears as `message.tool_calls` addressing the replay tool, with `role:"tool"` continuation support.
- **Static bearer auth** via `AGY_PROXY_API_KEY` (timing-safe sha256 digest compare; empty = disabled with boot warning). Environment-only by design — never read from `runtime-overrides.json`.
- **Golden-case system** (acceptance.md §2): `test/golden/openai/oa1-basic/` with request/events/expected + PROVENANCE.md (documented deviation: provenance in a sibling file + `_provenance` key, since JSON cannot carry comments); field-walk diff runner, sentinels for id/created; fake-agy `FAKE_AGY_EVENTS_FILE` replay mode.
- README: run instructions, configuration table, M1 limitations; CHANGELOG resumed.
- OA1 acceptance run against the real agy 1.1.22 binary recorded in `docs/verify/m1.md` (acceptance.md §5 format).

### Changed
- `src/index.ts`: CLI console.log startup block replaced by the server entry (`main()`: probe → wiring → listen → shutdown hooks); startup()/compareVersions exports retained.
- `GatewayConfig` gained `apiKey` (empty default); `AGY_PROXY_API_KEY` env in config.ts.
- Dependencies: fastify ^5.12, pino ^10, @sinclair/typebox ^0.34 (undici retained).

### Deferred (documented M1 deviations)
- Streaming SSE (M2), request-side tool round trips (M2), count_tokens/models routes (M2), account pool + per-key quotas (M3), reasoning passthrough on non-streaming (M2 streaming leg), `AGY_NOT_INSTALLED` → 503 is a deliberate charter-table extension.

## [0.1.0] - 2026-08-30 (M0 skeleton)

### Added
- Project skeleton: npm + TypeScript ESM (strict, NodeNext, `.ts` import extensions), tsdown build, vitest 4.
- CI workflow with the three gates (check → build → test) on push/PR (`.github/workflows/ci.yml`).
- Dockerfile: node:24-slim + tini as PID 1 (SIGTERM forwarding + zombie reaping), official agy CLI installed at build time with `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `/data` volume for all persistent state.
- Config layer (ported from dsh-agy-link @ 46984db, env prefix `DSH_AGY_*` → `AGY_PROXY_*`): env > `runtime-overrides.json` > defaults; gateway-specific keys (port, host, dataDir, adminAllowCidr, trustedProxies, maxQueueDepth).
- Runner (ported from dsh-agy-link @ 46984db): spawn with detached process groups, activity watchdog, tree kill (`process.kill(-pid)` / `taskkill /T /F`), Windows cmd-shim handling, `isolatedHomeEnv` (USERPROFILE/HOMEDRIVE/HOMEPATH on win32), version probe returning `{ok,version,error}`.
- Shared vocabulary (`src/common/types.ts`): `GatewayConfig`, `Err` error-code table, `AgyEvent` union, `RawUsage`.
- Startup report (`src/index.ts`): agy binary discovery + version probe + dormant-reason surfacing.
- fake-agy test stub (ported; modes `ok|auth|noise|exit12|exit-error|real|real-error|real-fail`, models probe modes).
- M0 test suite (19 tests): config layering, runner helpers, version probe, line streaming, abort/watchdog kill, overrides-file robustness.
- Docs: charter.md (立项), development.md, acceptance.md; CLAUDE.md for AI sessions.
