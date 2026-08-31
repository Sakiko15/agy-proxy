# OA2 stream-basic — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA2 — 流式响应 (SSE):
- `object:'chat.completion.chunk'`,稳定 id/created/model 贯穿全程;
- 首帧 `delta:{role:'assistant',content:''}`;
- 完成帧 `finish_reason` + `data: [DONE]`;
- `stream_options.include_usage` 时 usage 以 `choices:[]` 帧收尾。

Source basis:
- OpenAI API reference — Chat Completions streaming,
  https://platform.openai.com/docs/api-reference/chat/streaming (chunk shape:
  `chat.completion.chunk` with `choices[].delta` / `finish_reason`;
  `stream_options.include_usage` semantics: "the final chunk carries usage
  with an empty `choices` array").
- Field spellings cross-checked against the openai-node SDK
  (`ChatCompletionChunk`, `ChatCompletionStreamOptions`), openai-node v4/v5.
- `reasoning_content` on the reasoning deltas: an established ecosystem
  convention (DeepSeek/OpenRouter style); OpenAI's official chunk schema has
  no such field — documented deviation, docs/charter.md §4.3.

Fixture (events.ndjson): init → user_input → thinking ACTIVE/DONE fragments →
a COMPLETED read_file tool step, which cuts the span (mirror round trip). The
first hop therefore ends with `finish_reason:'tool_calls'` and the 0/0
placeholder usage frame — continuation coverage lives in openai-stream.test
(OA4) and the engine suite; this golden pins the exact frame sequence.
