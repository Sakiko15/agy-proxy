// Deterministic token estimation for /v1/messages/count_tokens (AN7). The
// gateway has no tokenizer: the heuristic below lands well within the +/-
// 30% accuracy envelope acceptance.md 2.2 declares for the endpoint (the
// response also notes non-exactness via the x-agy-proxy-token-estimate
// header). CJK text consumes roughly one token per character on modern
// tokenizers; Latin script averages ~4 characters per token.
// New code, not a port.
//
// B-H2 hot path: this estimator rides every Anthropic streaming request and
// every count_tokens call. The original for..of + per-character regex walk
// cost two regex tests per character, synchronously on the event loop
// (measured: 10MB prompt ~370ms first-byte stall). The 64KB classification
// LUT below is built once at module load by running the same two regexes
// over all 65536 BMP code units, then answers each character with two array
// reads instead of two regex tests. BYTE-identical semantics, pinned by the
// differential fuzz in test/tokens.test.ts:
// - the original for..of walks code points, so an astral pair (emoji, CJK
//   ext B) is ONE iteration whose two surrogate units can never match the
//   BMP-only ranges or \s -> latinRun += 1 total, not 2; lone surrogates
//   behave the same;
// - U+3000 (ideographic space) is both \s and the first CJK code unit: CJK
//   wins, because it was checked first.
const CJK_RE = /[　-鿿぀-ヿ豈-﫿＀-￯가-힯]/

const CLS_OTHER = 0
const CLS_CJK = 1
const CLS_WS = 2
const CLS = new Uint8Array(0x10000)
for (let c = 0; c <= 0xffff; c++) {
  const ch = String.fromCharCode(c)
  if (CJK_RE.test(ch)) CLS[c] = CLS_CJK
  else if (/\s/.test(ch)) CLS[c] = CLS_WS
}

export function estimateTokens(text: string): number {
  if (text === '') return 0
  let tokens = 0
  let latinRun = 0
  const n = text.length
  let i = 0
  while (i < n) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < n) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next < 0xe000) {
        // Astral code point = one for..of iteration over a 2-unit string that
        // matches neither the BMP-only CJK ranges nor \s.
        latinRun += 1
        i += 2
        continue
      }
    }
    const cls = CLS[code]
    if (cls === CLS_CJK) {
      tokens += 1 + latinRun / 4
      latinRun = 0
    } else if (cls === CLS_WS) {
      latinRun += 0.25 // whitespace rides the Latin budget
    } else {
      latinRun += 1
    }
    i += 1
  }
  tokens += latinRun / 4
  return Math.max(1, Math.round(tokens))
}

/** Image inputs are accounted at a flat 1000 tokens (documented heuristic). */
export const IMAGE_TOKEN_ESTIMATE = 1000