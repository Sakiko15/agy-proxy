# AN9 output_config — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN9 — 结构化输出:
`output_config.format` json_schema 与 OA5 等价处理。

Source basis:
- `output_config` is the current Anthropic control for constrained output
  (the Messages API's structured-output control; the earlier
  `response_format` spelling is also accepted —
  https://platform.claude.com/docs/build-with-claude/structured-outputs).
- Gateway behavior: BOTH spellings resolve to the same `call.jsonSchema`
  and the same `--json-schema <file>` argv as OpenAI's
  `response_format.json_schema` (OA5, test/golden/openai/oa5-json-schema) —
  one agy capability, one mapping. The argv equivalence is asserted in
  test/anthropic.test.ts (the golden runner drives one hop and the body
  shape is what pins here).
- The body shows agy's literal response text; fake-agy ok mode does not
  fabricate a schema-conforming payload (the real agy applies the schema).

Fixture: standard ok replay with `output_config.format.json_schema`.
