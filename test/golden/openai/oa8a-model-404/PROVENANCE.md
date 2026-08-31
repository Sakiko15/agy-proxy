# OA8a unknown model on a discovered catalog — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA8 — 无效模型:
discovered 目录下未知 model → 404 `model_not_found` + 可用模型列表提示。

Source basis:
- OpenAI error body shape `{error:{message,type,code}}`:
  https://platform.openai.com/docs/guides/error-codes (and the `model_not_found`
  code spelling used by the API for unknown models).
- Dual-state policy (M2 decision, docs/plan §0): with a LIVE `agy models`
  discovery the gateway enforces 404 up front; with only the FALLBACK catalog
  (signed out / offline) unknown ids stay advisory — forwarded to agy, whose
  real error text surfaces. Documented in docs/charter.md §4.4 and README.

Fixture: `case.json` seeds the catalog with a discovered set
(`discoveredModels` → ModelCatalog.forceRefresh over a JSON `agy models`
stdout). No agy spawn happens (400-stage rejection), so events.ndjson is
empty.
