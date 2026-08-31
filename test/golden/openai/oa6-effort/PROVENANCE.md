# OA6 reasoning effort — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA6 — reasoning effort 映射:
`reasoning_effort` 接受 OpenAI 档位并映射到 agy `--effort`。

Source basis:
- OpenAI effort values: `minimal|low|medium|high` on
  https://platform.openai.com/docs/api-reference/chat/create
  (reasoning_effort parameter). `xhigh`/`max` are ecosystem extensions seen
  in the wild; the gateway maps them onto agy's `high` (EFFORT_MAP in
  src/server/openai-adapter.ts), `none` drops the flag entirely.
- agy argv: `--effort <low|medium|high>` — Gemini models only (agy rejects
  the flag for Claude/GPT-OSS); docs/charter.md §4.2.

Assertions split (per docs/plan §4):
- THIS golden pins the completion BODY (effort-transparent to the body).
- The argv assertion (`--effort high` for xhigh, plus the unsupported-effort
  400 for a fixed-thinking model) lives in the main suites:
  test/openai-chat.test.ts (mapEffort table + engine.test.ts argv cases).
