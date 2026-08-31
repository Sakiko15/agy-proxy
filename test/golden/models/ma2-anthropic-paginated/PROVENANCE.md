# MA2 Anthropic paginated list — provenance

Acceptance basis: `docs/acceptance.md` §2.3 MA2 — Anthropic 分页列表:
limit/after_id → data + first_id/last_id/has_more。

Source basis:
- Anthropic models list shape and pagination fields (`data`,
  `first_id`, `last_id`, `has_more`; `limit` default 20 cap 1000;
  `after_id` starts AFTER the named id):
  https://platform.claude.com/docs/api-reference/models-list
- M2 routing decision: `/v1/anthropic/models` is ALWAYS Anthropic-shaped
  (so an Anthropic SDK pointed at this host works with base_url = host
  root); `/v1/models` serves the same shape under the anthropic-version
  header. Pagination cursor mechanics (stable alphabetical order, unknown
  after_id → empty page, limit cap) are unit-tested in
  test/models.test.ts; this golden pins one real cursor page end-to-end.
- `created_at` = fixed MODEL_CREATED ISO (determinism; literal compare).

Fixture: same discovered catalog as ma1; `limit=1&after_id=gemini-3.7-flash`
→ the page starts at the NEXT catalog entry after the cursor
(claude-sonnet-4-6, the final entry, so has_more=false). No agy spawn.
