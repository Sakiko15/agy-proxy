# agy-proxy

Self-hosted LLM gateway: Google Antigravity (official `agy` CLI) as the upstream engine,
exposed as OpenAI Chat Completions + Anthropic Messages compatible HTTP APIs with per-key
quotas and a management WebUI. Runs in Docker on a VPS behind a reverse proxy.

**Status: M4 (management WebUI) — under active development.** The six-page zh-CN console
(login / dashboard / accounts / keys / usage / settings) rides the same admin API, with live
updates over `/admin/events` SSE and same-process static hosting. See
[docs/charter.md](docs/charter.md) (立项文档), [docs/development.md](docs/development.md),
[docs/acceptance.md](docs/acceptance.md).

## Risk disclaimer

This project spawns only the **official, unmodified** `agy` binary. It does not reverse any
HTTP API and does not import OAuth tokens into non-Google clients. Using any wrapper may
still violate the Antigravity Terms of Service (Clause 6); use at your own risk and
preferably with a non-primary Google account. Quotas require a paid Antigravity plan
(free tier is exhausted within minutes).

## Running the gateway

```bash
npm install
npm run build
AGY_PROXY_API_KEY=change-me node dist/index.js
```

The gateway listens on `0.0.0.0:8080` by default and requires the official `agy` CLI to be
installed and signed in (`agy` on PATH, or point `AGY_PROXY_BIN` at the binary). A minimal
OpenAI-compatible request:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}]}'
```

The same upstream speaks Anthropic Messages:

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "x-api-key: change-me" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.7-flash","max_tokens":1024,"messages":[{"role":"user","content":"Reply with exactly one word: PONG"}]}'
```

`GET /healthz` is unauthenticated and returns `{"ok":true}` for orchestration probes.

When a built frontend exists (`web/dist` — `npm run web:build`, or `AGY_PROXY_WEB_DIST`),
the same process serves the management console at `/` (dot-free GET paths fall through to
the SPA; API 404 shapes stay identical). Development: `npm run web:dev` starts the Vite dev
server with `/admin` and `/v1` proxied to a local gateway.

## Endpoints

| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | OpenAI shape; `stream:true` → SSE, non-streaming → chat.completion |
| `POST /v1/messages` | Anthropic shape; `max_tokens` required; `stream:true` → message_start/…/message_stop |
| `POST /v1/messages/count_tokens` | Deterministic heuristic; `x-agy-proxy-token-estimate: heuristic` header marks it non-exact (±30%) |
| `GET /v1/models` | OpenAI shape by default; Anthropic shape when an `anthropic-version` header is present |
| `GET /v1/anthropic/models` | Always Anthropic shape (point an Anthropic SDK base_url at the host root); `limit`/`after_id`/`before_id` pagination |
| `GET /v1/models/{id}` | OpenAI retrieve; 404 `model_not_found` on unknown ids |
| `GET /healthz` | Unauthenticated probe |

Streaming details: OpenAI chunks carry `delta.reasoning_content` for thinking (industry
convention, not an official field) and a usage-only trailing frame with
`stream_options.include_usage`; `[DONE]` terminates. Anthropic streams emit the standard
`message_start → content_block_* → message_delta → message_stop` sequence. Idle heartbeats
(`: ping` / `ping` event) fire per `AGY_PROXY_SSE_HEARTBEAT_MS` when the engine is silent.

### Admin API (JSON, M3; the M4 WebUI rides on these routes)

All `/admin/*` routes sit behind the guard chain: CIDR allowlist (`AGY_PROXY_ADMIN_ALLOW_CIDR`,
re-read per request) → session cookie (`POST /admin/login` exempt) → CSRF (mutating methods
must carry a non-empty `x-requested-with` header). Session cookie: `HttpOnly; SameSite=Lax`.

| Route | Notes |
|---|---|
| `POST /admin/login` | `{password}` → session cookie; wrong password answers 401 after a 300ms damping delay |
| `POST /admin/logout` · `GET /admin/me` | Drop the session · remaining TTL |
| `GET /admin/status` | Gateway posture, catalog, key count, today's usage summary, pool overview — never token/key material |
| `GET /admin/pool` | Account pool data (aliases, dirs, cooldowns, quota, auth state) |
| `POST /admin/pool/auth/begin` | `{alias?}` → paste-URL login flow state (`phase`/`url`/`mode`) |
| `GET /admin/pool/auth/status` | Current flow state |
| `GET /admin/pool/auth/qr` | PNG of the flow URL (`Cache-Control: no-store`); 404 unless `phase === 'waiting'` |
| `POST /admin/pool/auth/complete` | `{code}` — the full callback URL or a bare code |
| `POST /admin/pool/auth/cancel` | Abort the flow |
| `PATCH`/`DELETE /admin/pool/accounts/{id}` | Alias / enable / proxy changes · remove the account |
| `POST /admin/pool/accounts/{id}/clear-cooldown` · `/refresh-quota` | Manual pool maintenance |
| `POST /admin/pool/quota/refresh` · `/admin/pool/mode` · `/admin/pool/reorder` | Pool-wide refresh, selection mode, sticky order |
| `GET/POST/PATCH/DELETE /admin/keys` | Key lifecycle — `POST` returns the `sk-agy-` plaintext **exactly once**; it is never logged |
| `GET /admin/usage` · `/admin/usage/summary` | Ledger query (`keyId`,`model`,`family`,`from`,`to`,`limit`≤500,`offset`) and today's totals |
| `GET /admin/events` | **SSE** (`text/event-stream`): seq-stamped `snapshot`/`run`/`pool` events; reconnects replay from `Last-Event-ID` (snapshot XOR replay) |
| `GET /admin/settings` · `PUT /admin/settings` | Settings view `{requested, effective, envLocked}` · write the 9-key allowlist to `runtime-overrides.json` (atomically; env vars still win — locked keys are *reported*, written values land in the file) |

Usage accounting: one ledger row per actual agy spawn, keyed by the caller's `x-request-id`
header (or the request id) — replaying the same id does not double-count. Per-key day
budgets and RPM limits are enforced pre-engine; a rejected request never reaches agy and
never books a row.

## Configuration

Layering: `AGY_PROXY_*` environment variables > `~/.agy-proxy/gateway/runtime-overrides.json`
> defaults. Environment is read per call, so changes apply without a restart.

| Variable | Default | Purpose |
|---|---|---|
| `AGY_PROXY_API_KEY` | *(unset)* | Bootstrap root key for `/v1/*`. Unset/empty = auth disabled (a warning is logged at boot). Environment-only by design — a plaintext key never rests in the overrides file. Accepted as `Authorization: Bearer` or `x-api-key`. Managed keys (day budgets, RPM limits) live in SQLite and are created via `POST /admin/keys`; the root key itself is unlimited and keyless. |
| `AGY_PROXY_PORT` | `8080` | HTTP listen port. |
| `AGY_PROXY_HOST` | `0.0.0.0` | Bind address; set `127.0.0.1` when a same-host reverse proxy fronts the gateway. |
| `AGY_PROXY_LOG_LEVEL` | `info` | pino log level (`AGY_PROXY_LOG_LEVEL` is read by the logger layer). |
| `AGY_PROXY_DATA_DIR` | `~/.agy-proxy` | Root for all persistent state. |
| `AGY_PROXY_BIN` | *(PATH)* | Absolute path to the `agy` binary. |
| `AGY_PROXY_ENABLED` | `true` | Master switch; `false` makes `/v1/*` answer 503. |
| `AGY_PROXY_MODE` | `plan` | agy permission mode (`plan`/`accept-edits`/`skip`). `skip` (`--dangerously-skip-permissions`) stays off by default. |
| `AGY_PROXY_DEFAULT_MODEL` | *(empty)* | Model used when the request omits `model`. |
| `AGY_PROXY_DEFAULT_EFFORT` | *(empty)* | Default Gemini reasoning effort. |
| `AGY_PROXY_TIMEOUT_MS` | `600000` | Idle watchdog for one agy run. |
| `AGY_PROXY_MAX_CONCURRENT` | `3` | Concurrent agy processes. |
| `AGY_PROXY_MAX_QUEUE_DEPTH` | `64` | Queued requests before 429 `BUSY`. |
| `AGY_PROXY_RATE_LIMIT_PER_MINUTE` | `0` (off) | Sliding-window request throttle. |
| `AGY_PROXY_SSE_HEARTBEAT_MS` | `60000` | Idle SSE heartbeat interval; `0` disables heartbeats. |
| `AGY_PROXY_WORKSPACE_ROOT` | `<dataDir>/workspace` | Workspace agy tools operate in. |
| `AGY_PROXY_CONVERSATIONS_DIR` | *(agy default)* | Override for agy conversation discovery. |
| `AGY_PROXY_DB_PATH` | `<dataDir>/agy-proxy.db` | SQLite file for API keys, the usage ledger and admin sessions. WAL mode. |
| `AGY_PROXY_ADMIN_SESSION_TTL_MS` | `604800000` (7d) | Admin session cookie lifetime (clamped ≥ 60s). |
| `AGY_PROXY_ADMIN_ALLOW_CIDR` | *(empty = any)* | CIDR allowlist gating every `/admin/*` route, re-read per request. Comma-separated; IPv4 (v6-mapped forms normalized). Empty allows all — always narrow this on a VPS. |
| `AGY_PROXY_ADMIN_PASSWORD` | *(generated)* | Admin password; env wins over the stored hash and re-hashes (argon2id) at boot. Unset + no stored hash → a random password is generated and printed exactly once. |
| `AGY_PROXY_TRUSTED_PROXIES` | *(empty)* | Comma-separated proxy IPs/CIDRs; when the client IP is in this set, `X-Forwarded-For` decides the admin-CIDR client address. |
| `AGY_PROXY_QUOTA_POLL_INTERVAL_MS` | `900000` (15min) | Background per-account quota poll interval (clamped ≥ 60s). |
| `AGY_PROXY_LOG_RETENTION_DAYS` | `7` | Account-pool auth-log retention before the boot sweep prunes. |
| `AGY_PROXY_WEB_DIST` | *(auto)* | Static WebUI directory override. Empty = auto-detect (`web/dist` beside the entry, `AGY_PROXY_WEB_DIST` env wins); absent → JSON-only mode, `/v1`+`/admin` behave exactly as without a UI. |

Authorization headers and cookies are never written to logs (pino redaction + metadata-only
log sites). To verify: send a request with a fake key, then grep the log output for the key.

## Request surface notes (M2 semantics)

- **Client tools are accepted, not executed.** `tools`/`tool_choice` definitions pass
  validation with a warning but never reach agy and are never invoked; only **agy's own
  tool activity** mirrors as round trips — OpenAI `delta.tool_calls` / Anthropic `tool_use`
  blocks addressing the gateway's `agy_tool` replay tool. Post a `role:"tool"` /
  `tool_result` message with the returned call id to continue the run (no new agy spawn).
- **Images are `data:`/base64 only.** http(s) URLs → 400 (SSRF-safe fetch is an M5
  candidate). Images stage to the workspace and ride `--add-dir`.
- **Unknown models**: with a *discovered* catalog, unknown ids → 404 `model_not_found` with
  the available list; when no discovery has happened (not signed in), the fallback catalog
  stays advisory and unknown ids pass through to agy (its real error text comes back as a
  502 `error.message`).
- **Truncation** (`max_completion_tokens`/`max_tokens`): proportional text cut, approximate
  by design (no tokenizer); tool-call spans are never truncated; `finish_reason:'length'`.
- **Thinking**: agy reports thinking as token-count turns, rendered as
  `[agy thinking turn · N thinking tokens]` annotations. Anthropic thinking budget tiers:
  ≤4096 → low effort, ≤16384 → medium, >16384 → high. No `signature_delta` is ever emitted
  and inbound signatures are not validated.
- Legacy OpenAI `functions`/`function_call` → 400 (use `tools`).
- Errors: OpenAI bodies `{error:{message,type,code}}`, Anthropic bodies
  `{type:'error',error:{type,message}}` — agy's real error text always passes through;
  an upstream `/overloaded/i` message maps to Anthropic 529 `overloaded_error`.

## Development quick start

```bash
npm install
npm run check   # tsc --noEmit
npm run build   # tsdown
npm test        # vitest run
```

Golden cases live under `test/golden/<protocol>/<case>/` (request + events + expected +
PROVENANCE.md); the runner in `test/golden.test.ts` replays each through the real HTTP
stack with fake-agy. Node >= 24 required.
