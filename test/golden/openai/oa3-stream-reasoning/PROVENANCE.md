# OA3 stream-reasoning — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA3 — 流式 + 思考:
- thinking / cache token 映射对齐(charter §4.3)— 本用例钉 usage 半边;
- `delta.reasoning_content` 出现在 content 之前那半边由 oa2 的真思考
  文本 fixture 覆盖(占位行移除后,本 fixture 的思考回合不再产生
  reasoning_content)。

Source basis:
- Chunk shape: OpenAI API reference — Chat Completions streaming,
  https://platform.openai.com/docs/api-reference/chat/streaming.
- Usage detail objects (`prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`): CompletionUsage,
  https://platform.openai.com/docs/api-reference/chat/object; mapping from
  agy usage per docs/charter.md §4.3 (input→prompt_tokens,
  cache_read→cached_tokens, thinking→reasoning_tokens).
- `reasoning_content`: ecosystem convention (DeepSeek-style), not an official
  OpenAI field — documented deviation, charter §4.3.

Fixture (events.ndjson): captured real agy 1.1.15 stream-json shapes — init
with nested `init` details, user_input/checkpoint bookkeeping, a
thinking-only agent_response turn (usage, no text_delta), then three streamed
text_delta fragments whose DONE tail carries the per-call usage. The result
envelope's usage is conversation-cumulative and deliberately NOT what the
golden asserts: the gateway forwards the LAST PER-CALL STEP SAMPLE
(900/60/200/15), per docs/charter.md §4.3 and the RunRecording noteStepUsage
contract.

This expected.json pins ONE streamed span (no tool steps in the fixture, so
no mirror cut). No reasoning_content appears: the formerly synthesized
thinking-turn annotations were removed 2026-09-09 (they were mistaken for
model output) — the thinking-only turn (80 tokens) and the text step's
DONE-tail thinking (15 tokens) surface only through usage
(`completion_tokens_details.reasoning_tokens` = 15).
