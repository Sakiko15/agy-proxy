// Differential equivalence suite for the hot-path token estimator (B-H2).
// estimateTokens rides every Anthropic streaming request and count_tokens
// call, so its rewrite to a 64KB classification LUT must be BYTE-identical
// to the previous for..of + regex walk — not close, identical: the estimate
// is pinned by goldens (message_start input_tokens, count_tokens responses)
// and feeds max_tokens budget enforcement. The oracle below is the original
// implementation, kept verbatim; the fuzz corpus sweeps every classification
// boundary the ranges touch.
import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../src/server/tokens.ts'

/** Verbatim pre-LUT implementation — the equivalence oracle. The ranges are
 *  spelled with \u escapes (identical to src/server/tokens.ts's literal CJK
 *  source chars): U+F900 is a compatibility ideograph whose NFC form is a
 *  different code point, so literal source text here would silently widen
 *  the range. */
const CJK_RE = /[\u3000-\u9fff\u3040-\u30ff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/
function estimateTokensOracle(text: string): number {
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

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Code-unit buckets the classifier branches on, plus every range edge ±1:
 *  CJK ranges (U+3000-9FFF, F900-FAFF, FF00-FFEF, 3040-30FF, AC00-D7AF),
 *  surrogates (the for..of astral-pair path), and the \s set edges. */
const BUCKETS: Array<[number, number]> = [
  [0x0020, 0x007e], // printable ASCII
  [0x0080, 0x009f], // C1 controls incl. U+0085 (NEL, \s)
  [0x00a0, 0x00a0], // NBSP (\s)
  [0x1680, 0x1680], // OGHAM SPACE (\s)
  [0x2000, 0x200a], // en/em quad… (\s)
  [0x2028, 0x2029], // line/paragraph separator (\s)
  [0x202f, 0x202f], // NNBSP (\s)
  [0x205f, 0x205f], // MMSP (\s)
  [0x2fff, 0x3001], // CJK lower edge (U+3000 ideographic space: \s AND CJK)
  [0x3040, 0x3100], // hiragana/katakana block edges
  [0x9fff, 0xa000], // CJK upper edge
  [0xf900, 0xfb00], // compat ideographs edges
  [0xabff, 0xac00], // hangul lower edge
  [0xd7af, 0xd7b0], // hangul upper edge
  [0xd7ff, 0xdfff], // surrogate block (astral pairs + lone)
  [0xe000, 0xe001], // just above hangul
  [0xff00, 0xfff0], // fullwidth forms edges
  [0xfffd, 0xfffe], // replacement + BOM-ish
]

function randomUnit(rand: () => number): number {
  if (rand() < 0.5) {
    const b = BUCKETS[Math.floor(rand() * BUCKETS.length)] ?? [0x41, 0x41]
    return b[0] + Math.floor(rand() * (b[1] - b[0] + 1))
  }
  return Math.floor(rand() * 0x10000) // anything, incl. lone surrogates
}

describe('estimateTokens differential equivalence (B-H2 LUT rewrite)', () => {
  const handPicked = [
    '',
    'hello world',
    '   ',
    '你好，世界',
    'mixed ascii and 中文 interleaved 123',
    '　', // U+3000 ideographic space: \s AND first CJK code unit
    'a　b',
    '　　', // two U+3000 in a row
    '   　', // NBSP, NNBSP, MMSP then U+3000
    '👍', // astral pair (one for..of iteration)
    '👍🏽👍🏻', // astral pairs with modifiers
    'a👍b👍c',
    '𠮷', // astral CJK-ext code point (U+20BB7) — surrogates are not in CJK ranges
    '\uD800', // lone high surrogate
    '\uDFFF', // lone low surrogate
    '\uD800a', // high surrogate followed by BMP char (no pair)
    '\uD800\uD800', // two high surrogates (no low pair)
    'é', // combining acute — e is one unit, U+0301 another
    '﻿', // U+FEFF BOM (\s)
    'text﻿text',
    'line1\nline2\r\n\ttab',
    'ｱｲｳｴｵ', // halfwidth katakana (FF61-FF9F, inside FF00-FFEF)
    'ＡＢＣ', // fullwidth latin (FF21-FF3A)
    '\uF900\uFAFF', // compat ideograph edges (U+F900 / U+FAFF) - escapes, NFC-mangles the literal
    '가힯ힰ', // hangul edges (AC00 / D7AF / just past)
    '぀ヿ', // kana edges (3040 / 30FF)
    '鿿뀀', // CJK upper edge (9FFF) then non-CJK (A000)
    'ﬀﬃ', // FB00+ (outside CJK, outside \s)
    '日本語 mixed with English text and 1234 numbers and emoji 🎉 and more 中文',
    'x'.repeat(4096),
    ('日'.repeat(512) + 'abc ') as string,
  ]

  it('hand-picked boundary corpus: LUT === oracle', () => {
    for (const s of handPicked) {
      expect(estimateTokens(s)).toBe(estimateTokensOracle(s))
    }
  })

  it('seeded random fuzz over classification buckets: LUT === oracle', () => {
    const rand = mulberry32(0xc0ffee)
    for (let iter = 0; iter < 600; iter++) {
      const len = 1 + Math.floor(rand() * 64)
      let s = ''
      for (let i = 0; i < len; i++) s += String.fromCharCode(randomUnit(rand))
      const a = estimateTokens(s)
      const b = estimateTokensOracle(s)
      if (a !== b) {
        throw new Error(
          `divergence at iter ${iter}: got ${String(a)}, oracle ${String(b)} for ${JSON.stringify(s)}`,
        )
      }
      expect(a).toBe(b)
    }
  })

  it('random astral-heavy fuzz: paired surrogates and emoji runs', () => {
    const rand = mulberry32(0xabcdef)
    const pieces = ['👍', '👍🏽', '𠮷', 'あ', '中', 'a', ' ', '　', '😀', '\u{1F1EF}\u{1F1F5}', 'x', '\t']
    for (let iter = 0; iter < 300; iter++) {
      const len = 1 + Math.floor(rand() * 40)
      let s = ''
      for (let i = 0; i < len; i++) {
        const p = pieces[Math.floor(rand() * pieces.length)] ?? 'a'
        if (rand() < 0.05) {
          // Occasional mid-pair splice: string.splice can split an astral char
          // into lone surrogates — the trickiest for..of semantic to mirror.
          const cut = 1 + Math.floor(rand() * Math.max(1, s.length - 1))
          s = s.slice(0, cut) + 'あ'
          continue
        }
        s += p
      }
      expect(estimateTokens(s)).toBe(estimateTokensOracle(s))
    }
  })

  it('long mixed document (realistic prompt shape): LUT === oracle', () => {
    const rand = mulberry32(42)
    const s = Array.from({ length: 50_000 }, () => String.fromCharCode(randomUnit(rand))).join('')
    expect(estimateTokens(s)).toBe(estimateTokensOracle(s))
  })
})
