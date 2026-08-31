# OA5 json_schema structured output — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA5 — 结构化输出:
- `response_format: json_schema` 透传给 agy(`--json-schema`);
- 返回 content 可 parse 且符合 schema。

Source basis:
- `response_format` shape: OpenAI API reference — Chat Completions
  `response_format` (`json_schema` with `json_schema.name`/`json_schema.schema`),
  https://platform.openai.com/docs/api-reference/chat/create.
- argv tail: `--json-schema <file>` — the engine writes the schema to a temp
  file and appends it to the argv (docs/charter.md §4.2; dsh-agy-link
  oneshot.ts schemaArgs absorbed at agy-proxy engine.ts).

Assertions split (per docs/plan §4):
- THIS golden pins the completion BODY: content is the raw JSON string.
- The argv assertion (`--json-schema` present, the temp file parses back to
  exactly the request schema) lives in `test/openai-chat.test.ts`
  ("json_schema reaches the --json-schema argv tail") — FAKE_AGY_ARGS_FILE
  inspection is not expressible through a single golden inject.
- Parseability of the response text against the schema: this fixture's
  content IS valid JSON for the schema (single assertion: exact string
  equality pins both shape and validity).
