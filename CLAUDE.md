# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`agy-proxy` is a self-hosted LLM gateway. The **only** upstream is the official, unmodified Google Antigravity `agy` CLI, spawned per request (`agy -p --output-format stream-json`) — there is no direct API client. It exposes OpenAI Chat Completions (`/v1/chat/completions`), Anthropic Messages (`/v1/messages`), dual-shape `/v1/models` + count_tokens, per-key quotas, and an admin WebUI. TypeScript ESM, Node ≥ 24, strict mode, `.ts` import extensions, no path aliases. **npm only** (no pnpm/yarn — docs/development.md §1).

**Source-of-truth docs (Chinese; read before nontrivial work):**
- `docs/charter.md` — architecture (§3), protocol matrix (§4), porting list (§5), stability/perf design (§6–7), security (§10)
- `docs/development.md` — process: branches/commits (§2), CI gates (§3), test discipline (§5), release rules (§6), porting (§7), security red lines (§8), AI collaboration rules (§9)
- `docs/acceptance.md` — acceptance gates (§1), golden-case spec (§2), milestone DoD (§3), perf baseline (§4)
- Also: `docs/deploy.md` (runbook), `docs/verify/*.md` (drill archives), README (endpoints, full env table, request-surface semantics).

Comments carry audit IDs (`A-M1`, `S-H2`, `B-M3`, `H1`, `MA4`, …) plus failure modes, referencing these specs. They encode hard-won invariants — read the surrounding comment before changing behavior it guards.

## Commands

```bash
npm run check   # tsc --noEmit — strict, zero-tolerance (gate G3: no @ts-ignore/@ts-expect-error)
npm run build   # tsdown (src/index.ts → dist/) + web build
npm test        # vitest run (test/**/*.test.ts)
npm run dev     # tsx src/index.ts
```

- Single file: `npx vitest run test/engine.test.ts`. By name: `npx vitest run test/engine.test.ts -t "pattern"`. Golden cases are dynamic describes — filter by case name: `npx vitest run test/golden.test.ts -t "oa8"`.
- WebUI (`web/` is a separate npm project with its own lockfile): `npm run web:dev` (Vite proxies /admin,/v1 to a local gateway), `web:build`, `web:test`, `web:check`. Single web test: `npm --prefix web run test -- src/lib/csv.test.ts`.
- **No eslint/prettier/linter exists anywhere.** The only style gate is CI's `grep console.log web/src` (must be empty). Match surrounding style.
- Harnesses (fake-agy upstream only, never real endpoints): `npx tsx scripts/perf.mts` (7 perf legs, ports 18600+), `npx tsx scripts/soak.mts` (`SOAK_MINUTES`, ports 18400+), `scripts/fake-bin.mts` (materializes a real `agy.exe` on win32 via csc.exe — the runner refuses `.cmd` shims).
- CI (`.github/workflows/ci.yml`): npm ci (root + web) → check → web:check → build → test → web:test → console.log grep. **build deliberately precedes test** (integration tests may reference build artifacts).
- `tsdown.config.ts` keeps `better-sqlite3` and `@node-rs/argon2` `external` — native `.node` must never be inlined. `better-sqlite3` is exercised directly by tests and needs a build toolchain where no prebuild exists; `allowScripts: {"better-sqlite3": true}` in package.json is the npm install-script allowlist.
- Docker: 3-stage Dockerfile — build stage carries python3/make/g++ for node-gyp plus a build-time better-sqlite3 binding gate; runtime uses **tini as PID 1** and the agy CLI pinned via `ARG AGY_CLI_VERSION=1.1.22` (**never floating**; upgrading agy is its own change with full protocol regression, charter §4). `docker-compose.yml` defaults to the published ghcr image, binds 8080 loopback-only, must keep `init: false` (tini is already PID 1), mounts `/data`, and the first-boot admin password is printed once in logs.

## Architecture

Three layers (charter §3):

- **`src/common`** — shared vocabulary: `types.ts` (Err code table), error-classifier regexes (decide account cooldowns and HTTP statuses), `config.ts`, `pool-types.ts` (`modelFamilyOf`).
- **`src/host`** — engine layer, **ported** from dsh-agy-link @ `46984db` (see Porting below): `engine.ts` (`AgyEngine.stream(EngineCall) → AsyncIterable<StreamChunk>`), `runner.ts` (spawn/kill), `parser.ts` (tolerant NDJSON), `mapper.ts` (AgyEvent→StreamChunk), `recording.ts` (RunRegistry: append-only per-child event log, settled exactly once; owns the `agytc-<runId>-<eventIndex>` mirror-call ids and `parseMirrorCallId`), `mirror.ts` (`agy_tool` mirror tool name/schema/executor), `pool.ts` (account pool + per-family cooldowns), `quota.ts`/`net.ts`, `oauth.ts`/`pool-auth.ts`, `models.ts` (ModelCatalog), `sessions.ts`, `media.ts` + `media-sweeper.ts`, `discovery.ts` (conversation-id fallback), `diagnostics.ts`, `stream-types.ts`.
- **`src/server`** — service layer (mostly "new code, not a port"; the exception is `semaphore.ts`, ported from dsh-agy-link's src/index.ts): `app.ts` (`buildServer(deps)` factory), `openai-adapter.ts`/`anthropic-adapter.ts` (**pure** functions request→EngineCall, StreamChunk→response/SSE — all protocol field decisions live here), `errors.ts` (Err→HTTP tables for both shapes; `isAnthropicPath` decides the body shape for every error path incl. Fastify validation/415/500), `auth.ts`, `key-store.ts`, `usage-ledger.ts`, `admin-api.ts`/`admin-session.ts`, `sse.ts`, `semaphore.ts`, `db.ts`, `static.ts`, `settings.ts`, `shutdown.ts`.

**Startup** (`src/index.ts`): startup() probes agy (must exist, version ≥ 1.1.8, else exit 1), then wires in strict order: openDb → KeyStore/UsageLedger/AdminSessionStore → AccountPoolManager/QuotaService/PoolAuthFlow → AdminEventBus → ModelCatalog → SessionStore → RunRegistry → GatewaySemaphore → AgyEngine (with the **onRun settle hook**) → buildServer → listen → pollers → installShutdown. `runtime.enabled=false` → every `/v1/*` answers 503.

**Request flow** (spans many files; read before touching any of it):
1. Auth hook — root env key (sha256 + timingSafeEqual) or `KeyStore.verify`; then per-key RPM limiter + daily token budget, pre-engine.
2. Adapter `mapRequest` → `EngineCall`, inside `withCallMeta`. `meta.reqId` is **always** the server fastify `req.id`; the client's `x-request-id` is echoed only as `clientReqId`, never used as a DB key. Per-key tenant scoping: sessions/media/steering keyed by keyId prefix.
3. `engine.stream`: continuation detection (`parseMirrorCallId` — a trailing `role:'tool'` message replays the recording from cursor: **no new spawn, no double usage**) → prompt assembly (trailing user messages become `-p`; context rides agy-native history seeded with a bounded 8k digest; bindings invalidated on model switch/truncation) → `pool.selectAccount(family, busyAccounts)` → per-key model whitelist checked against the actually-served model post-fallback (`MODEL_NOT_ALLOWED` 403) → media staging → semaphore acquire (maxConcurrent/maxQueueDepth; overflow → BUSY 429) → dispatch loop (per-account PQueue concurrency 1, 500 ms + jitter spawn spacing).
4. Retry: **one** engine-level retry on TIMEOUT/PROCESS_EXIT/INVALID_OUTPUT, only when nothing client-visible has streamed (`shapeOnly && !rec.hasClientMappedEvents()`), never inside the per-account queue task, never booking usage per attempt. `onRun` carries `{attempt, final, failureMessage?}` — **only `final` books/publishes**.
5. Settlement classification order: aborted → timedOut → auth → VALIDATION_REQUIRED (403 + challenge URL, quarantines the account) → hard rate limit → non-consumable. **Cooldowns only for hard server-issued 429 signatures** (soft "model overloaded" never cools). An in-flight hard 429 fails that request and cools the account; the **next** request auto-switches — no in-flight transparent replay (charter §6, deliberate). Soft limits never change account state.
6. Response leg: the recording is pumped through a fresh EventMapper → ChunkQueue → non-streaming `assembleCompletion`/`assembleMessage`, or `SseWriter` (hijacks the reply, raw socket writes, backpressure pause/drain, zero-window stall watchdog; the `: ping` / `ping` heartbeat forms are injected per protocol by app.ts — sse.ts owns the timer). StopHoldback + OutputBudget run on the **streaming** legs; the non-streaming legs enforce stop/max_tokens in the adapters (OA10/AN10 truncation + `applyStopWithHit`). Disconnect guard uses `raw.writableEnded`, not `reply.sent`; raw close → abort → process-group kill.

**The onRun seam** is the only place usage + admin run events are written: `usage-ledger.record()` (buffered) + `bus.publishRun()`, which mirrors the ledger row exactly so the dashboard can never disagree with accounting. The engine knows nothing about SQLite or SSE.

**Three separate rate-limit mechanisms**: per-key RPM/day budget (auth) · global sliding window (engine) · semaphore + per-account queues (dispatch).

**Admin API** guard chain: CIDR → session cookie (DB-backed, argon2id) → CSRF (`x-requested-with` on mutating methods); per-IP login brute-force gate (5 fails / 5 min → 429 even for correct passwords) + 300 ms damping. Admin SSE: monotonic seq, 200-ring Last-Event-ID replay, snapshot XOR replay (never both), pool snapshots debounced 250 ms off `pool.onChange`; `closeAll()` in shutdown because `app.close()` cannot end hijacked connections.

**Persistence** — all state under `AGY_PROXY_DATA_DIR` (default `~/.agy-proxy`, Docker `/data`): SQLite `agy-proxy.db` (WAL + FULL + busy_timeout, schema v3, migrations guarded by PRAGMA table_info; `usage.request_id` UNIQUE → `INSERT OR IGNORE` idempotency — request id is the ledger key); usage-ledger buffered 1 s batch writes (flush failure requeues, bounded MAX_PENDING_ROWS=5000, oldest dropped); key-store stores sha256 + 8-char prefix from the SECRET part (auth material only) **plus** the plaintext as AES-256-GCM ciphertext (`keys.secret_enc`, schema v3) keyed by the volume-local sidecar `keys-enc.key` (auto-generated 0600) — that ciphertext powers admin reveal (`GET /admin/keys/:id/secret`) and rotate (`POST …/rotate`); pre-v3 rows have NULL ciphertext and can only be replaced, never recovered; plaintext itself still exists exactly once outside the cipher blob (the `create()`/`rotate()` return); `pool.json`/`sessions.json`/`runtime-overrides.json` atomic writes; per-account isolated HOMEs hold OAuth tokens (device-bound — must live on the volume; there are no system-HOME accounts); `gateway/media/` staged images TTL-swept. Everything scheduled is `unref()`'d so timers never hold the process at shutdown.

**Config layering** (`src/common/config.ts`): env `AGY_PROXY_*` (read per call — applies live) > `runtime-overrides.json` (memoized on path+mtime+size, corrupt tolerated) > defaults; floors applied after layering. `AGY_PROXY_API_KEY` is env-only by design, never from overrides. `settings.ts` PUT /admin/settings is a 9-key allowlist writer clamped line-for-line against resolveConfig; env-locked keys are reported (`envLocked`), not rejected. Full env table: README Configuration.

**Usage semantics quirk**: `input_tokens` = uncached input only (cached input rides `cached_tokens`); per-run usage takes the last per-call step sample, never the cumulative result envelope (`recording.ts` finalUsage).

**web/** — React 19 + Vite + Tailwind 4 + TanStack Router/Query + i18next (zh-CN default, en). The same process serves `web/dist` via `static.ts` (`@fastify/static` with `wildcard:false` per-file routes that can never shadow `/v1`/`/admin`; the SPA fallback lives in setNotFoundHandler so API 404s stay byte-identical); `AGY_PROXY_WEB_DIST=none` forces JSON-only. **User-facing strings live only in `web/src/i18n/{zh-CN,en}.ts`, never `.tsx`** (acceptance greps scan `.tsx`; zh/en key identity enforced by `web/src/i18n/completeness.test.ts`).

## Testing

- **fake-agy (`test/fake-agy.mjs`) is the only upstream in tests** — never real Google endpoints in CI. Modes via `FAKE_AGY_MODE`, event replay via `FAKE_AGY_EVENTS_FILE`, argv/pid recording via `FAKE_AGY_ARGS_FILE`/`FAKE_AGY_PID_FILE`, failure windows via `FAKE_AGY_MODE_FILE`, plus `FAKE_AGY_EXIT_CODE` / `FAKE_AGY_FAIL_HOME`.
- The engine takes a `bin` deps seam (process.execPath + fake script), so tests never need real agy. Unit tests use `app.inject()`; harnesses bind ports 18400+/18600+. `better-sqlite3` is exercised directly.
- `vitest.config.ts` sets `fileParallelism: false` — spawn tests share the fake-agy argv record files and kill-ladder assertions are timing-sensitive. **Do not flip casually.** testTimeout 60 s.
- **Golden cases** (`test/golden/<protocol>/<case>/`): `request.json` + `events.ndjson` (fake-agy verbatim replay; empty = no spawn) + `expected.json` (`_status`, `sse` frame array) + `PROVENANCE.md` (REQUIRED — the runner asserts it contains a source URL: OpenAI SDK path or Anthropic docs URL; acceptance.md §2 phrases the rule as an `expected.json` header — the sibling `PROVENANCE.md` files are the implemented convention) + `case.json` (optional — only some cases carry one). The runner drives the real HTTP stack, normalizes `__ID__`/`__AGYTC__`/`__UUID__` sentinels (UUID scrubbed at raw-text level pre-parse), zeroes chat `created` and heartbeats, and diffs field by field. Golden JSON is hand-authored — **no snapshot tooling** (development.md §5). Protocol changes → update/add golden cases with provenance.

## Security red lines (development.md §8)

- No keys/tokens/Bearer headers in logs. `redactLine` at free-form log sites; `scrubTokenMaterial` **only** at `EventMapper.emitFailure` (the terminal-failure funnel) — deliberately not redactLine, which mangles URLs and would destroy `validation_url` passthrough.
- No token import/export features. No runtime-telemetry dependencies. The per-key admin reveal (`GET /admin/keys/:id/secret`) is session-gated single-key retrieval, not an export path — no bulk endpoints exist.
- `permissionMode` defaults to `plan`; `skip` means `--dangerously-skip-permissions` — never flip casually; changing the default requires an independent PR.

## Porting from dsh-agy-link (engine upstream)

The `src/host` layer is ported from dsh-agy-link (MIT). Discipline (development.md §2/§7):
- Header comment: `// Ported from dsh-agy-link <path> @ <sha> (verbatim|modified: <summary>)` — standing exception: `engine.ts` says "Rewritten from dsh-agy-link src/host/adapter.ts @ 46984db".
- Verbatim-ported files stay diffable — keep functional changes out (e.g. `media-sweeper.ts` is a separate file so `media.ts` remains verbatim).
- Env prefix `DSH_AGY_*` → `AGY_PROXY_*`. Port commits cite the upstream sha. Branches `feat|fix|port/<slug>`; commits `feat(engine)` / `fix(server)` / `port: …`.

## Working rules (standing)

- **Verification-first** (development.md §9): search the codebase + `docs/` first, web-search when project-level info is insufficient, and label anything unverified as unverified instead of guessing. New knowledge of upstream behavior (event shapes, error text) must land as fake-agy modes + assertions (development.md §5) — "应该是这样" is not evidence.
- charter.md is the source of truth: on conflict, change one side and say why — never let them drift.
- **Never auto-publish**: npm publish / GitHub Release / git tags / image pushes only on the user's explicit command (`docker-release.yml` is workflow_dispatch only). Before any release: three gates green + CHANGELOG entry per release with root causes (development.md §6) + version bumped + summary presented.