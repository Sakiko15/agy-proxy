# AN8c invalid body — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN8 — 非法体腿:
缺 `max_tokens` → 400 invalid_request_error。

Source basis:
- `max_tokens` is a REQUIRED field on Anthropic's Messages API
  (https://platform.claude.com/docs/api-reference/messages — the request
  table marks max_tokens required), unlike OpenAI where the equivalent is
  optional. The adapter enforces it up front in `mapMessagesRequest`.
- 400 + `{type:'error',error:{type:'invalid_request_error',message}}` is
  the standard Anthropic error envelope (same errors reference as an8a).

Fixture: valid model + messages but no max_tokens. The adapter throws
before any engine work — no agy spawn, empty events.ndjson.
