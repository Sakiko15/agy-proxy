# agy-proxy

Self-hosted LLM gateway: Google Antigravity (official `agy` CLI) as the upstream engine,
exposed as OpenAI Chat Completions + Anthropic Messages compatible HTTP APIs with per-key
quotas and a management WebUI. Runs in Docker on a VPS behind a reverse proxy.

**Status: M2 (dual-protocol + streaming) — under active development.** Streaming SSE, the
Anthropic Messages endpoint, models routes, count_tokens, the widened request surface and
the golden-case matrix are in; next is M3 (account pool, key management, SQLite accounting).
See [docs/charter.md](docs/charter.md) (立项文档), [docs/development.md](docs/development.md),
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

## Configuration

Layering: `AGY_PROXY_*` environment variables > `~/.agy-proxy/gateway/runtime-overrides.json`
> defaults. Environment is read per call, so changes apply without a restart.

| Variable | Default | Purpose |
|---|---|---|
| `AGY_PROXY_API_KEY` | *(unset)* | Static bearer key for `/v1/*`. Unset/empty = auth disabled (a warning is logged at boot). Environment-only by design — a plaintext key never rests in the overrides file. Accepted as `Authorization: Bearer` or `x-api-key`. |
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
