# AN5 tool_use stream — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN5 — 工具镜像:
agy 工具步镜像为 tool_use 块 + input_json_delta,stop_reason tool_use。

Source basis:
- Anthropic `tool_use` content blocks and `input_json_delta` framing:
  https://platform.claude.com/docs/build-with-claude/streaming (the docs'
  tool-use streaming example sends the arguments as one or more
  input_json_delta chunks; a single full-JSON delta is a valid instance).
- The gateway mirrors agy's OWN tool activity (native git tools — agy runs
  its own tools internally); client tool definitions are accepted but never
  executed (M2 decision, charter §4.2). The mirrored call is `agy_tool` with
  `{run, step, tool, input}` — the same program the OpenAI side mirrors
  (test/golden/openai/oa2-stream-basic) with `step` = the event's ABSOLUTE
  recording index (init=0, user_input=1, thinking ACTIVE=2, thinking
  DONE=3, tool DONE=4), so a client can resume the run by echoing this id
  as a tool_result (continuation cursor, engine.ts).
- `content_block_start` for tool_use carries an empty `input` object and the
  deltas carry the JSON string — the Anthropic docs' streaming shape.
- Tool-cut usage: tool-calls spans settle before a DONE usage sample rides
  the hop, so message_delta carries `output_tokens: 0` and NO
  `output_tokens_details` (the extension field only appears when the
  engine actually reports reasoning tokens — absent, not zero; same
  discipline as oa2's usage frame).

Fixture: oa2's replay (thinking turn + DONE tool step, `read_file` on
/tmp/x). Continuation ("no new spawn on tool_result replay") is asserted by
argv in test/anthropic.test.ts, not here — the golden runner drives a
single hop.
