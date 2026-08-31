# OA4 tool-call streaming — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA4 — 工具调用流式:
- tool_calls 以流式 delta 帧下发,`finish_reason:'tool_calls'`;
- 续传消息带 tool_call_id 原样回传,游标复用不新 spawn。

Source basis:
- Delta tool_calls shape (index/id/type/function.arguments):
  https://platform.openai.com/docs/api-reference/chat/streaming —
  "tool_calls index … the ID and name are only present in the first delta
  of a tool call". This gateway emits ONE complete delta per call (no
  fragment accumulation), which is a valid refinement of that contract:
  clients see the full arguments string in a single frame.
- agy tool shapes: captured real agy 1.1.15 stream-json ACTIVE/DONE tool
  steps (test/fake-agy.mjs header note); the ACTIVE announcement carries
  name/parameters only and must NOT surface — only the DONE update with
  output/error cuts the span.

Continuation leg (`游标复用不新 spawn`): asserted in
`test/openai-stream.test.ts` OA4 by counting FAKE_AGY_ARGS_FILE lines across
the replay — the golden runner drives a single inject per case, so the
spawn-counting assertion lives in the main suite per docs/plan §4
(`--add-dir`/argv 断言在主测试).
