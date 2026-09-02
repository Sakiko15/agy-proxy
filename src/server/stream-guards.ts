// Streaming-side guards shared by both SSE legs (charter §4.2):
// StopHoldback mirrors the non-streaming stop-sequence cut for streamed
// text — a tail that could still turn out to be the prefix of one of the
// stop sequences is withheld until it resolves — and OutputBudget caps
// streamed output at max_tokens using the same estimateTokens heuristic as
// count_tokens, aborting the engine mid-generation instead of letting it
// run past the client's budget. Reasoning deltas are never cut by the
// holdback; the budget counts them (they are billed output).
import { estimateTokens } from './tokens.ts'

export class StopHoldback {
  readonly #stops: string[]
  #buffer = ''
  #matched: string | null = null

  constructor(stops: readonly string[]) {
    // Empty stops would match everywhere; mappers already reject them, but
    // the guard stays safe under direct construction.
    this.#stops = stops.filter((s) => s !== '')
  }

  get matched(): string | null {
    return this.#matched
  }

  /**
   * Feed one text delta; returns the prefix that is safe to emit now. Once
   * a stop has matched, every further push returns '' (the remainder of the
   * generation is discarded, per official stop-sequence semantics).
   */
  push(text: string): string {
    if (this.#matched !== null) return ''
    this.#buffer += text
    return this.#drain()
  }

  /**
   * Terminal flush at finish: emits whatever remains (cut at a full stop
   * match if one lands in the final buffer) and reports the matched stop.
   * Call exactly once, after the last push.
   */
  close(): { text: string; matched: string | null } {
    if (this.#matched !== null) return { text: '', matched: this.#matched }
    const hit = this.#earliestMatch()
    if (hit !== null) {
      this.#matched = hit.stop
      const text = this.#buffer.slice(0, hit.index)
      this.#buffer = ''
      return { text, matched: hit.stop }
    }
    const text = this.#buffer
    this.#buffer = ''
    return { text, matched: null }
  }

  #earliestMatch(): { index: number; stop: string } | null {
    let best: { index: number; stop: string } | null = null
    for (const s of this.#stops) {
      const idx = this.#buffer.indexOf(s)
      // Strict < keeps the client's first-listed stop on exact ties.
      if (idx !== -1 && (best === null || idx < best.index)) best = { index: idx, stop: s }
    }
    return best
  }

  #drain(): string {
    const hit = this.#earliestMatch()
    let cut: number
    if (hit !== null) {
      this.#matched = hit.stop
      cut = hit.index
    } else {
      // No full match yet: withhold the longest buffer suffix that is a
      // proper prefix of some stop — it may complete on the next push.
      let hold = 0
      for (const s of this.#stops) {
        const maxK = Math.min(s.length - 1, this.#buffer.length)
        for (let k = maxK; k > hold; k--) {
          if (this.#buffer.endsWith(s.slice(0, k))) {
            hold = k
            break
          }
        }
      }
      cut = this.#buffer.length - hold
    }
    const out = this.#buffer.slice(0, cut)
    this.#buffer = this.#buffer.slice(cut)
    return out
  }
}

/** Streaming output budget: estimates accumulate and trip at maxTokens. */
export class OutputBudget {
  #spent = 0

  constructor(readonly maxTokens: number) {}

  /** Estimated tokens charged so far. */
  get spent(): number {
    return this.#spent
  }

  /** Record generated output; returns true once the budget is exhausted. */
  charge(text: string): boolean {
    if (this.#spent >= this.maxTokens) return true
    this.#spent += estimateTokens(text)
    return this.#spent >= this.maxTokens
  }
}