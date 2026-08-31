# MA1 OpenAI model list — provenance

Acceptance basis: `docs/acceptance.md` §2.3 MA1 — 模型列表:
`GET /v1/models` 返回 OpenAI 形状,折叠后无重复 id。

Source basis:
- OpenAI list shape `{object:'list', data:[{id, object:'model', created,
  owned_by}]}`: https://platform.openai.com/docs/api-reference/models/list
- M2 routing decision (user-selected): `/v1/models` is OpenAI-shaped by
  default and Anthropic-shaped when an `anthropic-version` header is
  present; `/v1/anthropic/models` is ALWAYS Anthropic-shaped. The
  header-sniff variant is covered by test/models.test.ts; this golden pins
  the default shape.
- MA3 folding: `foldEfforts` folds Gemini `-low/-medium/-high` effort slugs
  into the base entry (the `-low` fixture entry disappears into
  gemini-3.7-flash). DSH rejects duplicate model ids with INVALID_CATALOG —
  folding keeps one id per capability. Catalog order is stable-alphabetical
  on the HTTP surface (claude before gemini).
- `created` = MODEL_CREATED (2026-01-01 UTC, src/server/models-routes.ts) —
  a fixed epoch for determinism, pinned LITERALLY here (the `created → 0`
  scrub applies only to chat surfaces).

Fixture: discovered catalog via case.json; no agy spawn (the catalog
refresh is injected).
