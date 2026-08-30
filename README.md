# agy-proxy

Self-hosted LLM gateway: Google Antigravity (official `agy` CLI) as the upstream engine,
exposed as OpenAI Chat Completions + Anthropic Messages compatible HTTP APIs with per-key
quotas and a management WebUI. Runs in Docker on a VPS behind a reverse proxy.

**Status: M0 (skeleton) — under active development.** See [docs/charter.md](docs/charter.md)
(立项文档), [docs/development.md](docs/development.md), [docs/acceptance.md](docs/acceptance.md).

## Risk disclaimer

This project spawns only the **official, unmodified** `agy` binary. It does not reverse any
HTTP API and does not import OAuth tokens into non-Google clients. Using any wrapper may
still violate the Antigravity Terms of Service (Clause 6); use at your own risk and
preferably with a non-primary Google account. Quotas require a paid Antigravity plan
(free tier is exhausted within minutes).

## Development quick start

```bash
npm install
npm run check   # tsc --noEmit
npm run build   # tsdown
npm test        # vitest run
```

Node >= 24 required.
