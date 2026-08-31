# MA3 single model GET / 404 — provenance

Acceptance basis: `docs/acceptance.md` §2.3 MA3 — 单模型查询/404:
`GET /v1/models/:id` 未知 id → 404 model_not_found。

Source basis:
- OpenAI "Retrieve model" route and its 404 shape
  (`{error:{message, type:'invalid_request_error', code:'model_not_found'}}`):
  https://platform.openai.com/docs/api-reference/models/retrieve — the
  `model_not_found` code spelling matches OpenAI's 404 for a missing model.
- The 404 body goes through the shared OpenAI error builder (httpError),
  same shape as oa8a's chat-surface model 404 (which adds the available
  list to the message; the retrieve route keeps the short form).

Fixture: discovered catalog via case.json; request targets an id that is
not in it. No agy spawn.
