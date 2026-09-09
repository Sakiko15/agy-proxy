# AN3 thinking stream — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN3 — 思考流:
末 message_delta 带 thinking_tokens;signature_delta 不发。
(AN3 的 thinking 块 wire 形状由 an5 的真思考文本 fixture 覆盖;
本用例钉 usage 纪律与占位行移除后的空 reasoning 流。)

Source basis:
- Anthropic thinking content blocks and `thinking_delta`:
  https://platform.claude.com/docs/build-with-claude/extended-thinking
- ANOTHER deviation, documented: agy's stream-json carries thinking as a
  token-count turn (`thinking_tokens: 80`), not text and NOT signed, so this
  golden carries NO thinking block and NEVER emits `signature_delta` — there
  is no signature to protect. Inbound thinking blocks in history are likewise
  accepted without signature validation (see an4). The formerly synthesized
  `[agy thinking turn · N thinking tokens]` annotation was removed 2026-09-09
  (recipients mistook it for model output): thinking rides usage only —
  `message_delta.usage.output_tokens_details.thinking_tokens` = 15 comes from
  the text step's DONE tail.
- Usage discipline: the `message_delta` usage is the per-call step sample
  (output 60 / thinking 15) — the trailing `result` envelope is
  conversation-CUMULATIVE (100/95) and is never forwarded. The nested
  `result.result` shape in the fixture also exercises the parser's
  tolerant envelope unwrap across agy versions.

Fixture: the real-shape replay from the ok-mode binary capture (checkpoint
step + thinking-only turn + 3 text deltas), same one dsh-agy-link's oa3
golden pins on the OpenAI side.
