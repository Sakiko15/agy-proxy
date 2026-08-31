# AN2 streaming — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN2 — 流式:
SSE 事件序 message_start → content_block_* → message_delta → message_stop。

Source basis:
- Anthropic streaming event sequence and `event:`/`data:` framing:
  https://platform.claude.com/docs/build-with-claude/streaming
- The stream mirrors the non-streaming body (an1): content blocks appear in
  the same order, text deltas concatenate to the same text, and
  `message_delta.usage` carries the same output token count.
- `message_start.message.usage` carries zeros at start (per the streaming
  docs' minimal shape) — real per-call input tokens are known only at the
  DONE step, after the message has already started.
- `usage.output_tokens_details.thinking_tokens` on message_delta is the
  gateway extension field (see an1 provenance).

Fixture: same 2-step ok replay as an1 with `"stream": true`.
