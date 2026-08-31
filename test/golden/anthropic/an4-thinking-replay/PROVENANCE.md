# AN4 thinking replay in history — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN4 — 思考回放:
历史 thinking/redacted_thinking 块接受进上下文;篡改 signature 腿。

Source basis:
- Anthropic history shapes: thinking blocks and redacted_thinking blocks are
  valid assistant-side content in the Messages API
  (https://platform.claude.com/docs/build-with-claude/extended-thinking).
- Gateway behavior: inbound thinking blocks are folded into the request
  digest like any other content (charter §4.3) — they are never forwarded
  to agy as separate turns, because agy has no thinking-history concept.
- Tampered-signature leg N/A: the gateway does not validate inbound
  signatures (charter §4.3 explicitly keeps the gateway signature-agnostic)
  and agy emits no signatures at all, so there is nothing to tamper with.
  The acceptance scenario's premise ("upstream rejects a bad signature")
  cannot arise on this gateway; recorded as N/A rather than faked.

Fixture: standard ok replay; the request exercises the mapping path
(system string + mixed block array with a thinking block + assistant turn
+ trailing user turn).
