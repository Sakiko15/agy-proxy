// Quota-bar contract: fraction clamping and countdowns.
import { describe, it, expect } from 'vitest'
import { clampFraction, countdownUntil, formatRemaining, hourlyFraction, weeklyFraction } from './quota.ts'

describe('clampFraction', () => {
  it('clamps to [0,1] and maps junk to unknown', () => {
    expect(clampFraction(0.42)).toBe(0.42)
    expect(clampFraction(-0.2)).toBe(0)
    expect(clampFraction(1.4)).toBe(1)
    expect(clampFraction(undefined)).toBeNull()
    expect(clampFraction(Number.NaN)).toBeNull()
  })
})

describe('hourlyFraction / weeklyFraction', () => {
  it('reads both bars from one quota object', () => {
    const q = { remainingFraction: 0.5, weeklyFraction: 0.9 }
    expect(hourlyFraction(q)).toBe(0.5)
    expect(weeklyFraction(q)).toBe(0.9)
    expect(hourlyFraction({})).toBeNull()
  })
})

describe('countdownUntil', () => {
  const now = Date.parse('2026-08-31T12:00:00Z')

  it('formats h/m/s for future targets', () => {
    expect(countdownUntil(now + 59_000, now)).toBe('59s')
    expect(countdownUntil(now + 3 * 60_000, now)).toBe('3m 0s')
    expect(countdownUntil(now + 2 * 3_600_000 + 5 * 60_000, now)).toBe('2h 5m')
    expect(countdownUntil(now + 3 * 86_400_000, now)).toBe('3d 0h')
  })

  it('empty string for past/absent/invalid targets', () => {
    expect(countdownUntil(now - 1, now)).toBe('')
    expect(countdownUntil(undefined, now)).toBe('')
    expect(countdownUntil('', now)).toBe('')
    expect(countdownUntil('not-a-date', now)).toBe('')
    expect(countdownUntil('2026-08-31T13:00:00Z', now)).toBe('1h 0m')
  })

  it('formatRemaining ceil-rounds', () => {
    expect(formatRemaining(1)).toBe('1s')
    expect(formatRemaining(60_001)).toBe('1m 1s')
  })
})