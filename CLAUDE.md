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

Already ported (M0): `src/host/runner.ts` (process spawn/watchdog/tree-kill), `src/common/config.ts` + `types.ts` (config layering: env > runtime-overrides.json > defaults), `test/fake-agy.mjs` (stub agy binary; modes `ok|auth|noise|exit12|exit-error|real|real-error|real-fail`, `FAKE_AGY_MODE` env, argv appended to `FAKE_AGY_ARGS_FILE`).

## Key facts that shape the code

- **Config layering** (`src/common/config.ts`): env (`AGY_PROXY_*`, read per call) > `~/.agy-proxy/gateway/runtime-overrides.json` (or `$AGY_PROXY_DATA_DIR`) > defaults. `permissionMode` default is **`plan`** — `skip` means `--dangerously-skip-permissions` (arbitrary shell in container); its default must never be flipped casually (development.md §8).
- **agy quirks already handled in runner.ts**: stdin closed immediately (agy hangs forever on open pipe stdin), activity-based watchdog re-armed on every stdout/stderr chunk, whole-process-group kill (`process.kill(-pid)` on POSIX, `taskkill /T /F` on Windows), Windows cmd-shim re-spawn through `cmd.exe` with verbatim args, `isolatedHomeEnv` sets `USERPROFILE`/`HOMEDRIVE`/`HOMEPATH` (not just `HOME`) on Windows.
- **Engine error codes** (`src/common/types.ts` `Err`): AUTH / AGY_NOT_INSTALLED / TIMEOUT / PROCESS_EXIT / INVALID_OUTPUT / AGY_ERROR / BUSY / … — protocol adapters map these onto OpenAI (`{error:{message,type,code}}`) and Anthropic (`{type:'error',error:{type,message}}`) bodies. Real agy error text is always surfaced verbatim, never replaced by generic "exited with code 1".
- **Stream protocol**: agy NDJSON (init → step_update* → result) is parsed into `AgyEvent`s, then mapped to StreamChunks (block-start/text-delta/reasoning-delta/tool-call/usage/finish), then translated per-protocol. Usage fields from agy: `input_tokens/output_tokens/thinking_tokens/cache_read_tokens/total_tokens` — mapping table in charter §4.3.
- **All persistent state under `dataDir()`** (`AGY_PROXY_DATA_DIR`, default `~/.agy-proxy`): pool, sessions, per-account isolated HOMEs, media, SQLite. Account credentials are device-bound — everything must live on the Docker volume.
- **No systemHome accounts**: unlike dsh-agy-link, every pool account uses an isolated HOME (VPS has no desktop login).

## Testing

- Golden-case system (from M1, acceptance.md §2): `test/golden/<protocol>/<case>/` with `request.json` + `events.ndjson` + `expected.json`; every golden case must cite its source (OpenAI SDK path / Anthropic docs URL) in a header comment.
- fake-agy is the only upstream for tests — never hit real Google endpoints in CI.

## Release rules (inherited from AGENTS.md discipline of the upstream repo)

- NEVER auto-publish npm/GitHub Release/tags. Publish only on the user's explicit command.
- Before any release: three gates green + CHANGELOG.md updated + version bumped + summary presented.

## Roadmap status

M0 done (skeleton). Next: M1 engine port (parser/recording/mapper/pool/quota/oauth — see charter §5 porting table), then Fastify + OpenAI non-streaming endpoint. Track in acceptance.md §3 DoD checklists.
