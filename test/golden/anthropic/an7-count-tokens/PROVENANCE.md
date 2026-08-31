# AN7 count_tokens — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN7 — token 计数:
`POST /v1/messages/count_tokens` → `{input_tokens:N}`,确定性启发式。

Source basis:
- Endpoint shape (`{input_tokens: number}` response, model + messages +
  optional system request):
  https://platform.claude.com/docs/build-with-claude/token-counting
- Estimate algorithm (charter §4.2, src/server/tokens.ts): CJK-range chars
  cost 1 token each; Latin script averages 4 chars/token (a `latinRun`
  counter divided by 4, whitespace riding the Latin budget at 0.25 each);
  `Math.max(1, round(...))` per string. The arithmetic for THIS request:
    system "you are terse" → 13 non-ws chars → round(13/4) = 3
    你好世界 → 4 (CJK @ 1)
    "hi" → 1, "ok" → 1
    total = 3 + 4 + 1 + 1 = 9
  THIS golden pins the exact deterministic output so any estimator change
  flips this file.
- Non-exact by design: real tokenizers are model-specific; the response
  carries header `x-agy-proxy-token-estimate: heuristic` and README states
  the ±30% approximate guarantee.

Fixture: no agy involved — events.ndjson is empty and no spawn occurs.
