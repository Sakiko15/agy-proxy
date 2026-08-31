# OA9 deprecated functions — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA9 — 已弃用参数:
`functions`/`function_call` → 400 并提示改用 tools。

Source basis:
- Legacy deprecation: OpenAI marked `functions`/`function_call` deprecated in
  favor of `tools`/`tool_choice`
  (https://platform.openai.com/docs/api-reference/chat/create —
  "Deprecated in favor of tool_choice").
- M2 tools decision (user-approved, docs/plan §0): `tools`/`tool_choice` are
  ACCEPTED BUT IGNORED — agy runs its own tool loop and the gateway mirrors
  that activity; client tool definitions are never forwarded nor executed
  (warning on the meta, visible in server logs). The legacy surface gets a
  hard 400 because silently dropping it would strand legacy clients.

Fixture: a `functions: []` request; the mapper rejects before any engine
work, so events.ndjson is empty. The warnings-on-tools behavior is covered
by test/openai-chat.test.ts mapChatRequest units.
