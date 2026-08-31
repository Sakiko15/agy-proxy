# OA3 stream-reasoning — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA3 — 流式 + 思考:
- `reasoning_content` 增量先于正文;
- thinking / cache token 映射对齐(charter §4.3)。

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
no mirror cut). Two reasoning annotations appear:
- the thinking-only turn (80 tokens) is annotated BEFORE any text — nothing
  of that step had streamed, so the annotation leads;
- the text step's own thinking (15 tokens) arrives on its DONE tail, AFTER
  its fragments — the mapper's deferral rule (emitting at arrival would wedge
  the annotation mid-sentence; dropping it hid the thinking entirely,
  upstream v0.3.2/v0.3.3 regressions).
