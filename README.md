# agy-proxy

Self-hosted LLM gateway: Google Antigravity (official `agy` CLI) as the upstream engine,
exposed as OpenAI Chat Completions + Anthropic Messages compatible HTTP APIs with per-key
quotas and a management WebUI. Runs in Docker on a VPS behind a reverse proxy.

**Status: M1 (engine port + OpenAI non-streaming) — under active development.** M2 (streaming,
tool round trips, models routes, error matrix) and the Anthropic Messages endpoint are next.
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

`GET /healthz` is unauthenticated and returns `{"ok":true}` for orchestration probes.

## Configuration

Layering: `AGY_PROXY_*` environment variables > `~/.agy-proxy/gateway/runtime-overrides.json`
> defaults. Environment is read per call, so changes apply without a restart.

| Variable | Default | Purpose |
|---|---|---|
| `AGY_PROXY_API_KEY` | *(unset)* | Static bearer key for `/v1/*`. Unset/empty = auth disabled (a warning is logged at boot). Environment-only by design — a plaintext key never rests in the overrides file. |
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
| `AGY_PROXY_WORKSPACE_ROOT` | `<dataDir>/workspace` | Workspace agy tools operate in. |
| `AGY_PROXY_CONVERSATIONS_DIR` | *(agy default)* | Override for agy conversation discovery. |

Authorization headers and cookies are never written to logs (pino redaction + metadata-only
log sites). To verify: send a request with a fake key, then grep the log output for the key.

## M1 limitations (M2 removes most of them)

- `stream: true` → 400 (SSE arrives in M2).
- `tools` / `tool_choice` / legacy `functions` → 400. However, **agy's own tool activity** is
  surfaced as `message.tool_calls` entries addressing the gateway's replay tool; posting a
  `role: "tool"` message with the returned call id continues the run.
- Images and audio → 400 (multimodal staging arrives in M2).
- Reasoning/thinking content is counted in usage but not returned (non-streaming OpenAI has
  no standard field; the M2 streaming leg carries it).
- `response_format: json_object` is enforced by prompt injection + tolerant parse (documented
  non-hard guarantee); `json_schema` passes through to agy's native `--json-schema`.
- `max_tokens` / `max_completion_tokens` are validated and recorded but do not truncate (OA10, M2).
- Unknown model ids are accepted and forwarded (the catalog is advisory); agy's real error
  text comes back as a 502 `error.message`.
- No account pool, no per-key quotas yet (M3): requests run as the single logged-in system
  account.

## Development quick start

```bash
npm install
npm run check   # tsc --noEmit
npm run build   # tsdown
npm test        # vitest run
```

Node >= 24 required.
