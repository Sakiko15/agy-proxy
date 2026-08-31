# OA10 max_tokens truncation — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA10 — 网关侧截断:
`max_completion_tokens` 生效,超出部分被截断,`finish_reason:'length'`。

Source basis:
- `max_completion_tokens` is the current OpenAI parameter (`max_tokens` is
  deprecated), https://platform.openai.com/docs/api-reference/chat/create;
  `finish_reason: 'length'` marks token-limit stops.
- Gateway-side cut (charter §4.2): the gateway has NO tokenizer, so the text
  is cut PROPORTIONALLY — `keepChars = floor(text.length * max /
  usage.outputTokens)` — because agy's outputTokens INCLUDE thinking tokens
  while the visible text does not. Approximate by design; documented in
  README and here. Tool-call spans are never truncated (their finish
  semantics differ).

Fixture: the model returns the 19-char text "Hello from fake agy" with
output_tokens=100; max_completion_tokens=3 → keepChars=0 → empty content +
`length`. This pins the arithmetic END-TO-END (the maxTokens≤output guard,
the exact proportional formula, the finish remap) — a regression in any of
them flips finish_reason or the usage/echo fields.
