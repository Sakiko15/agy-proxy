# Changelog

All notable changes to agy-proxy are documented here. Format based on Keep a Changelog; versions follow semver.

## [Unreleased] (M1 引擎移植 + M1 收尾)

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
