# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`agy-proxy` is a self-hosted LLM gateway: it spawns the **official, unmodified** Google Antigravity `agy` CLI (`agy -p --output-format stream-json`) as the upstream engine and exposes **OpenAI Chat Completions** + **Anthropic Messages** compatible HTTP APIs with per-key quotas and a management WebUI. Runs in Docker on a VPS behind a reverse proxy. TypeScript ESM, Node ≥ 24, strict mode with `.ts` import extensions.

**The three source-of-truth documents — read them before any work:**
- `docs/charter.md` — 立项文档: architecture, protocol support matrix (§4), module porting list (§5), stability/perf design, tech stack (§8), security rules (§10)
- `docs/development.md` — dev process: porting discipline, PR DoD, release rules, security red lines
- `docs/acceptance.md` — per-milestone acceptance criteria (M0–M5) + golden test case spec (§2)

## Commands

```bash
npm run check   # tsc --noEmit (strict, zero-tolerance)
npm run build   # tsdown → dist/
npm test        # vitest run
npm run dev     # tsx src/index.ts
```

- CI gates run check → build → test **in that order** (`.github/workflows/ci.yml`).
- Single test file: `npx vitest run test/m0.test.ts`; by name: `npx vitest run -t "pattern"`.
- WebUI lives in `web/` (separate npm project): `npm run web:dev` / `npm run web:build`.

## Porting from dsh-agy-link (the engine upstream)

The engine layer is ported from `D:\prj_test\dsh-agy-link` (MIT). Discipline (development.md §2/§7):
- Ported files carry a header comment: `// Ported from dsh-agy-link <path> @ <sha> (verbatim|modified: <summary>)`
- Verbatim-ported files must not mix in functional changes — keep them diffable against upstream
- `dsh-agy-link` env prefix `DSH_AGY_*` became `AGY_PROXY_*` here

Already ported: M0 brought `src/host/runner.ts`, `src/common/config.ts` + `types.ts`, `test/fake-agy.mjs`. M1 brought the full engine (parser/recording/mapper/pool/pool-auth/quota/oauth/net/sessions/media/models/discovery/diagnostics + `engine.ts` rewritten from adapter.ts — dsh-llm vocabulary replaced by the self-owned `EngineCall → AsyncIterable<StreamChunk>` surface in `src/host/stream-types.ts`). Server layer (new code, charter §3): `src/server/` — `app.ts` (buildServer factory, /healthz, /v1/chat/completions, /v1/messages, count_tokens), `openai-adapter.ts` + `anthropic-adapter.ts` (pure request/response/stream mapping), `sse.ts` (hijack writer + heartbeat + backpressure), `errors.ts` (Err→HTTP tables, per-protocol bodies, 529 overloaded on /overloaded/i), `auth.ts` (static bearer + x-api-key), `tokens.ts` (count_tokens heuristic), `models-routes.ts` (dual-shape + pagination), `semaphore.ts`, `logger.ts` (pino), `shutdown.ts`. `auth.ts` deliberately never reads the key from runtime-overrides.json.

## Key facts that shape the code

- **Config layering** (`src/common/config.ts`): env (`AGY_PROXY_*`, read per call) > `~/.agy-proxy/gateway/runtime-overrides.json` (or `$AGY_PROXY_DATA_DIR`) > defaults. `permissionMode` default is **`plan`** — `skip` means `--dangerously-skip-permissions` (arbitrary shell in container); its default must never be flipped casually (development.md §8).
- **agy quirks already handled in runner.ts**: stdin closed immediately (agy hangs forever on open pipe stdin), activity-based watchdog re-armed on every stdout/stderr chunk, whole-process-group kill (`process.kill(-pid)` on POSIX, `taskkill /T /F` on Windows), Windows cmd-shim re-spawn through `cmd.exe` with verbatim args, `isolatedHomeEnv` sets `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` (not just `HOME`) on Windows.
- **Engine error codes** (`src/common/types.ts` `Err`): AUTH / AGY_NOT_INSTALLED / TIMEOUT / PROCESS_EXIT / INVALID_OUTPUT / AGY_ERROR / BUSY / … — protocol adapters map these onto OpenAI (`{error:{message,type,code}}`) and Anthropic (`{type:'error',error:{type,message}}`) bodies. Real agy error text is always surfaced verbatim, never replaced by generic "exited with code 1".
- **Stream protocol**: agy NDJSON (init → step_update* → result) is parsed into `AgyEvent`s, then mapped to StreamChunks (block-start/text-delta/reasoning-delta/tool-call/usage/finish), then translated per-protocol. Usage fields from agy: `input_tokens/output_tokens/thinking_tokens/cache_read_tokens/total_tokens` — mapping table in charter §4.3.
- **All persistent state under `dataDir()`** (`AGY_PROXY_DATA_DIR`, default `~/.agy-proxy`): pool, sessions, per-account isolated HOMEs, media, SQLite. Account credentials are device-bound — everything must live on the Docker volume.
- **No systemHome accounts**: unlike dsh-agy-link, every pool account uses an isolated HOME (VPS has no desktop login).

## Testing

- Golden-case system (acceptance.md §2): `test/golden/<protocol>/<case>/` (openai/, anthropic/, models/) with `request.json` (raw body = legacy /v1/chat/completions POST, or `{method,url,query,headers,body}`) + `events.ndjson` (fake-agy `FAKE_AGY_EVENTS_FILE` verbatim replay; empty = no spawn) + `expected.json` (`_status` pins HTTP status; `sse` array for streaming cases) + `PROVENANCE.md`; every case must cite its source (OpenAI SDK path / Anthropic docs URL — the runner asserts a URL is present). Provenance convention: JSON cannot carry comments, so the citation lives in a sibling `PROVENANCE.md` plus an `_provenance` key in expected.json (stripped by the runner). Dynamic fields use sentinels: `chatcmpl-/msg_ ids → __ID__` (shape-regex checked), `agytc- mirror ids → __AGYTC__`, embedded run UUIDs → `__UUID__` (scrubbed at RAW text level pre-parse — they live inside JSON strings), `created → 0` on chat surfaces only, MODEL_CREATED (1767225600) compared literally on model listings. Per-case `case.json`: `apiKey`, `fakeAgyExitCode`, `discoveredModels`. `sseHeartbeatMs: 0` in the runner keeps SSE deterministic. Windows: temp-dir cleanup after each case is best-effort (fake-agy child can hold a handle a beat past exit).
- fake-agy is the only upstream for tests — never hit real Google endpoints in CI. Modes: `ok|auth|noise|exit12|exit-error|real|real-error|real-fail|hang|slow` plus `FAKE_AGY_EVENTS_FILE` (verbatim replay, with `FAKE_AGY_EXIT_CODE`) and `FAKE_AGY_ARGS_FILE` (argv recording).

## Release rules (inherited from AGENTS.md discipline of the upstream repo)

- NEVER auto-publish npm/GitHub Release/tags. Publish only on the user's explicit command.
- Before any release: three gates green + CHANGELOG.md updated + version bumped + summary presented.

## Roadmap status

M0 done (skeleton). M1 done: engine layer ported (716fc3f), Fastify service layer + OpenAI non-streaming `/v1/chat/completions` + static `AGY_PROXY_API_KEY` auth + OA1 golden case (d3bf836, 06342e9). M2 done: dual-protocol streaming SSE (hijack + heartbeat + disconnect abort), Anthropic `/v1/messages` + count_tokens + model routes (dual-shape /v1/models with header sniff, /v1/anthropic/models with pagination), widened OpenAI surface (tools accepted-not-executed, assistant tool_calls history, data: images, OA8 discovered-catalog 404, OA10 proportional truncation), 26 golden cases (oa1–oa10, an1–an10, ma1–ma3). Next: M3 account pool + key management + SQLite accounting. Track in acceptance.md §3 DoD checklists.
