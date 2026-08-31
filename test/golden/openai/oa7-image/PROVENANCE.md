# OA7 image input — provenance

Acceptance basis: `docs/acceptance.md` §2.1 OA7 — 图片输入 (data: URL):
data:/base64 图片接受并落盘 staging,http(s) URL → 400。

Source basis:
- data: URL form (`data:<mime>;base64,<payload>`): RFC 2397 / OpenAI
  `image_url` content part, https://platform.openai.com/docs/api-reference/
  chat/create (image_url.url). This gateway accepts ONLY data: URLs —
  http(s) sources would be an SSRF surface and are deferred to the M5
  hardening pass (user decision, docs/plan §0).
- Staging pipeline: media.ts `stageImages` (ported verbatim from
  dsh-agy-link) writes the bytes to cfg.mediaDir and appends a
  `[image attached: …] Inspect it using the view_file tool …` line to the
  prompt; the media dir rides `--add-dir` (docs/charter.md §4.2
  path-based multimodal).

Assertions split (per docs/plan §4):
- THIS golden pins the completion BODY for an image-bearing request — the
  image never appears in the body or prompt text of the response.
- The staged-file and argv assertions (a real PNG lands in cfg.mediaDir;
  `--add-dir <mediaDir>`; the `[image attached: "img-1"` prompt line) live in
  test/openai-chat.test.ts ("data: images stage to disk and reach --add-dir +
  view_file prompt (OA7 leg)") and the mirrored Anthropic leg.
- http(s) → 400: asserted in test/openai-chat.test.ts mapChatRequest units.
