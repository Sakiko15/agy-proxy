# OA8c / OA-golden auth — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA8 — 鉴权失败腿:
配置静态 key 后,缺 key 请求 → 401 `authentication_error`。

Source basis:
- OpenAI 401 body: `{error:{message,type:'authentication_error',code}}` —
  the `invalid_api_key` code spelling matches OpenAI's auth errors
  (https://platform.openai.com/docs/guides/error-codes/api-errors).
- The static-key mode is the M1/M2 interim (M3 introduces the sha256 key
  store): `AGY_PROXY_API_KEY` lives in the environment only, and the
  comparison is sha256+timingSafeEqual (src/server/auth.ts). Key VALUES are
  never logged — hooks log the verdict only.
- Per-protocol bodies: OpenAI paths keep `{error:{...}}`; Anthropic paths
  receive `{type:'error',error:{...}}` (see test/golden/anthropic/an8a-*).

Fixture: `case.json` sets `apiKey` (the runner passes it into
GatewayConfig). The request carries no auth header, so the hook rejects at
the preHandler stage — no agy spawn, empty events.ndjson.
