# OA8b upstream exit — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA8 — 上游退出:
agy 非零退出 → 502,携带 agy 真实错误文本(而非裸 "exited with code 1")。

Source basis:
- The silent-failure shape observed in the wild (dsh-agy-link v0.4.21,
  CHANGELOG root-cause note): agy writes ONLY a `result` envelope with a
  human-readable `error` to stdout and exits 1 with an EMPTY stderr. The
  engine prefers `parser.stats.lastResultError` over the stderr tail when
  composing the failure message (engine.ts settlement block).
- OpenAI 502 body `{error:{message,type,code}}`:
  https://platform.openai.com/docs/guides/error-codes; PROCESS_EXIT is a
  gateway error-code extension (charter §4.4 error model table).

Fixture: events.ndjson replays the ERROR envelope; `case.json` sets
`fakeAgyExitCode: 1` so the replay reproduces the real exit semantics
(test/fake-agy.mjs FAKE_AGY_EXIT_CODE hook, added for this golden).
