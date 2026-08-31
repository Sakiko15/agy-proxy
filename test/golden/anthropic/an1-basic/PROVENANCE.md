# AN1 basic non-streaming — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN1 — 基础对话:
非流式 `/v1/messages` 返回 Anthropic Message 形状。

Source basis:
- Anthropic Messages response shape (`id`/`type`/`role`/`content`/`model`/
  `stop_reason`/`stop_sequence`/`usage`):
  https://platform.claude.com/docs/api-reference/messages
- `usage.cache_read_input_tokens` is Anthropic's cache-hit field:
  https://platform.claude.com/docs/build-with-claude/prompt-caching
- `usage.output_tokens_details.thinking_tokens` is a GATEWAY EXTENSION
  (charter §4.4 usage-mapping table): agy's envelope carries thinking_tokens
  and Anthropic's official shape has no slot for it, so the gateway mirrors
  the OpenAI-side extension field name on the Anthropic surface.
- The `[agy thinking turn · N thinking tokens]` annotation is the mapper's
  thinking-turn marker (dsh-agy-link mapper.ts): agy's stream-json reports
  thinking as a token-count turn, not text, so the gateway renders a
  placeholder annotation before the text block.

Fixture: the standard 2-step ok fixture (user_input + agent_response with
text "Hello from fake agy", usage 10/5/2/3). The `msg_` id is a random 24-char
base64url — normalized to `__ID__` by shape.
