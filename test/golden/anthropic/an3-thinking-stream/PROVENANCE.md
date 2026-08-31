# AN3 thinking stream — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN3 — 思考流:
thinking 块 + thinking_delta,末 message_delta 带 thinking_tokens;
signature_delta 不发。

Source basis:
- Anthropic thinking content blocks and `thinking_delta`:
  https://platform.claude.com/docs/build-with-claude/extended-thinking
- ANOTHER deviation, documented: agy's stream-json carries thinking as a
  token-count turn (`thinking_tokens: 80`), not text and NOT signed, so the
  gateway renders the mapper's `[agy thinking turn · N thinking tokens]`
  annotation and NEVER emits `signature_delta` — there is no signature to
  protect. Inbound thinking blocks in history are likewise accepted without
  signature validation (see an4).
- Annotation placement follows the mapper's deferral rule (dsh-agy-link
  mapper.ts): a thinking-ONLY turn annotates BEFORE any text; the text
  step's own thinking rides its DONE tail, AFTER the fragments.
- Usage discipline: the `message_delta` usage is the per-call step sample
  (output 60 / thinking 15) — the trailing `result` envelope is
  conversation-CUMULATIVE (100/95) and is never forwarded. The nested
  `result.result` shape in the fixture also exercises the parser's
  tolerant envelope unwrap across agy versions.

Fixture: the real-shape replay from the ok-mode binary capture (checkpoint
step + thinking-only turn + 3 text deltas), same one dsh-agy-link's oa3
golden pins on the OpenAI side.
