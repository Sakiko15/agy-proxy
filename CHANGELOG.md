# Changelog

All notable changes to agy-proxy are documented here. Format based on Keep a Changelog; versions follow semver.

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
