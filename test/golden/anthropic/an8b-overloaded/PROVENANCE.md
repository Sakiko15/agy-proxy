# AN8b overloaded 529 — provenance

Acceptance basis: `docs/acceptance.md` §2.2 AN8 — 过载腿:
上游过载 → 529 overloaded_error。

Source basis:
- Anthropic `overloaded_error` and the 529 "temporarily overloaded" status:
  https://platform.claude.com/docs/api-reference/errors — 529 is Anthropic's
  own overloaded status; the body keeps the standard error wrapper.
- Detection (charter §4.4): a narrow `/overloaded/i` match on the upstream
  error TEXT is the only soft-rate-limit signature the gateway accepts —
  broad prose scanning would mis-trigger cooldowns (dsh-agy-link lesson,
  hard-vs-soft limit discipline). The engine message for an upstream
  failure is "Google Antigravity quota / rate limit reached: <real text>",
  so "model overloaded" lands here; ordinary upstream failures (no
  overloaded token) map to 502 api_error instead (see oa8b on the OpenAI
  side for that shape — the Anthropic counterpart carries the same
  message with an api_error body).
- agy's real error text passes through verbatim in `message`.

Fixture: events.ndjson replays a lone ERROR result envelope; case.json
sets `fakeAgyExitCode: 1` (test/fake-agy.mjs FAKE_AGY_EXIT_CODE hook) so
the replay reproduces real agy's exit-1 semantics for a failed request.
