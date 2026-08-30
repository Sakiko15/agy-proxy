# OA1 basic non-streaming — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA1 — 基础非流式（单轮文本）:
`id` 格式、`object:'chat.completion'`、`created`、`model` 回显、
`choices[0].message.role/content`、`finish_reason:'stop'`、usage 三元组.

Source basis (acceptance.md §2 用例来源纪律):
- Response shape: OpenAI API reference — Chat object,
  https://platform.openai.com/docs/api-reference/chat/object (the
  `chat.completion` object with `id`, `object`, `created`, `model`,
  `choices[].message`, `choices[].finish_reason`, `usage`).
- Field spellings cross-checked against the openai-node SDK types
  (`src/resources/chat/completions/completions.ts`, ChatCompletion /
  CompletionUsage interfaces), openai-node v4/v5.
- Usage detail objects (`prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`): OpenAI API reference,
  CompletionUsage; mapping from agy usage per docs/charter.md §4.3.

Conventions (documented deviation from acceptance.md §2 "expected.json 头部
注明依据来源" — JSON cannot carry comments):
- The provenance note lives in `expected.json` under the `_provenance` key
  (stripped before comparison) and in this file.
- `id` is normalized to the `__ID__` sentinel by the runner and its format
  asserted separately (`/^chatcmpl-[A-Za-z0-9_-]{24}$/`).
- `created` is normalized to `0` (the runner pins the epoch seconds).

Engine events (`events.ndjson`): minimal real-shape run — init, user_input,
one agent_response with a single text_delta fragment (PONG), and a DONE
result envelope. No tool steps, so no mirror tool_calls: the purest OA1 path.
