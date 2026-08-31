// Deterministic token estimation for /v1/messages/count_tokens (AN7). The
// gateway has no tokenizer: the heuristic below lands well within the ±30%
// accuracy envelope acceptance.md §2.2 declares for the endpoint (the
// response also notes non-exactness via the x-agy-proxy-token-estimate
// header). CJK text consumes roughly one token per character on modern
// tokenizers; Latin script averages ~4 characters per token.
// New code, not a port.
const CJK_RE = /[　-鿿豈-﫿＀-￯぀-ヿ가-힯]/

export function estimateTokens(text: string): number {
  if (text === '') return 0
  let tokens = 0
  let latinRun = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      tokens += 1 + latinRun / 4
      latinRun = 0
    } else if (/\s/.test(ch)) {
      latinRun += 0.25 // whitespace rides the Latin budget
    } else {
      latinRun += 1
    }
  }
  tokens += latinRun / 4
  return Math.max(1, Math.round(tokens))
}

/** Image inputs are accounted at a flat 1000 tokens (documented heuristic). */
export const IMAGE_TOKEN_ESTIMATE = 1000
