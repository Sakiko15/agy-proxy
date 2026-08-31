# AN8a auth 401 — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN8 — 鉴权失败腿:
配置静态 key 后,缺 key 请求 → 401 authentication_error。

Source basis:
- Anthropic 401 body shape `{type:'error',error:{type:'authentication_error',
  message}}`: https://platform.claude.com/docs/api-reference/errors —
  the errors table lists `authentication_error` among the named types and
  the envelope `{type:'error', error:{...}}` is Anthropic's error wrapper.
- Per-protocol body dispatch lives in src/server/errors.ts
  (`isAnthropicPath` / `authErrorFor`): the same hook failure renders as
  OpenAI's `{error:{message,type,code}}` on /v1/chat/completions (see
  test/golden/openai/oa8c-auth-401) and as the Anthropic wrapper here.
- Static-key mode is the M1/M2 interim; comparison is sha256 +
  timingSafeEqual and key VALUES are never logged (docs/SECURITY-NOTES).

Fixture: `case.json` sets `apiKey`; the request carries no auth header.
The auth hook rejects at preHandler — no agy spawn, empty events.ndjson.
