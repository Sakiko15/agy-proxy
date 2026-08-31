# AN10 stop sequences — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN10 — 停止序列:
命中截断 + stop_reason stop_sequence + 序列回填。

Source basis:
- Anthropic stop_sequences semantics: generation stops BEFORE the sequence,
  `stop_reason` becomes `stop_sequence`, and the response echoes the
  matched sequence in the `stop_sequence` field
  (https://platform.claude.com/docs/api-reference/messages).
- Gateway implementation: agy has no stop-sequence control, so the adapter
  cuts the settled text gateway-side at the FIRST occurrence of any
  sequence and remaps stop_reason end_turn → stop_sequence with the echo —
  the same place the OpenAI side implements `stop` (openai-adapter). The
  streaming side applies the same cut to deltas before block emission.

Fixture: text "APONG" with stop_sequences ["ON"] → visible text "AP".
Single text step (no tool hops) so the golden runner's single inject
covers the whole run.
