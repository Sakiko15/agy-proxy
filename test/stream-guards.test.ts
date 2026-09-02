// Unit tests for the streaming guards (src/server/stream-guards.ts):
// StopHoldback — the tail-holding buffer that cuts text at stop sequences
// across delta boundaries — and OutputBudget, the estimateTokens-driven
// streaming max_tokens cap.
import { describe, it, expect } from 'vitest'
import { OutputBudget, StopHoldback } from '../src/server/stream-guards.ts'

describe('StopHoldback', () => {
  it('passes text through untouched when there is nothing to hold', () => {
    const hb = new StopHoldback([])
    expect(hb.push('hello ')).toBe('hello ')
    expect(hb.push('world')).toBe('world')
    expect(hb.close()).toEqual({ text: '', matched: null })
  })

  it('emits everything before a full stop match and swallows the rest', () => {
    const hb = new StopHoldback(['END'])
    expect(hb.push('hello END world')).toBe('hello ')
    expect(hb.matched).toBe('END')
    expect(hb.push('more')).toBe('')
    expect(hb.close()).toEqual({ text: '', matched: 'END' })
  })

  it('holds back a cross-delta partial prefix until it resolves', () => {
    const hb = new StopHoldback(['STOP'])
    expect(hb.push('hello ')).toBe('hello ')
    expect(hb.push('ST')).toBe('') // could still become STOP
    expect(hb.push('OP')).toBe('') // full match lands
    expect(hb.push(' more')).toBe('')
    const tail = hb.close()
    expect(tail.matched).toBe('STOP')
    expect(tail.text).toBe('')
  })

  it('releases a held partial prefix when it resolves to plain text', () => {
    const hb = new StopHoldback(['END'])
    expect(hb.push('EN')).toBe('')
    expect(hb.push('X')).toBe('ENX')
    expect(hb.close()).toEqual({ text: '', matched: null })
  })

  it('flushes the held tail on close when no stop ever matched', () => {
    const hb = new StopHoldback(['END'])
    expect(hb.push('hello EN')).toBe('hello ')
    expect(hb.close()).toEqual({ text: 'EN', matched: null })
  })

  it('prefers the earliest stop match when several could apply', () => {
    const hb = new StopHoldback(['bc', 'abcd'])
    expect(hb.push('abcd')).toBe('')
    expect(hb.matched).toBe('abcd') // starts at 0, before "bc" at 1
  })

  it('ignores empty stop strings defensively', () => {
    const hb = new StopHoldback(['', 'END'])
    expect(hb.push('a END')).toBe('a ')
    expect(hb.matched).toBe('END')
  })

  it('returns nothing after a match even on later pushes', () => {
    const hb = new StopHoldback(['x'])
    expect(hb.push('a x b')).toBe('a ')
    expect(hb.push('c x d')).toBe('')
    expect(hb.close()).toEqual({ text: '', matched: 'x' })
  })
})

describe('OutputBudget', () => {
  it('charges estimateTokens per string and trips at the cap', () => {
    const budget = new OutputBudget(10)
    // 8 latin chars ≈ 2 tokens.
    expect(budget.charge('xxxxxxxx')).toBe(false)
    expect(budget.charge('xxxxxxxx')).toBe(false)
    expect(budget.charge('xxxxxxxx')).toBe(false)
    expect(budget.charge('xxxxxxxx')).toBe(false)
    expect(budget.charge('xxxxxxxx')).toBe(true) // 10 ≥ 10
  })

  it('counts CJK at one token per character', () => {
    const budget = new OutputBudget(5)
    expect(budget.charge('一二三四五')).toBe(true)
  })

  it('stays exhausted once tripped', () => {
    const budget = new OutputBudget(3)
    expect(budget.charge('x')).toBe(false)
    expect(budget.charge('x')).toBe(false)
    expect(budget.charge('xxxxxxxx')).toBe(true)
    expect(budget.charge('')).toBe(true)
  })

  it('exposes the estimated spend', () => {
    const budget = new OutputBudget(100)
    budget.charge('xxxxxxxx')
    expect(budget.spent).toBe(2)
  })
})