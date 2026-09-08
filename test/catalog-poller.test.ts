// Catalog poller semantics (MA5): no-account ticks spawn nothing, failures
// back off exponentially (capped), recovery resets to the base cadence, and
// a fresh discovered catalog stays quiet until TTL expiry (SWR). Fake timers
// drive the schedule; the discover fn is a stub.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ModelCatalog, type DiscoverFn } from '../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS } from '../src/common/types.ts'
import { startCatalogPoller, CATALOG_BACKOFF_MAX_MS } from '../src/host/catalog-poller.ts'

const FALLBACK = DEFAULT_FALLBACK_MODELS

function makeCatalog(discover: DiscoverFn, ttlMs = 300_000): ModelCatalog {
  return new ModelCatalog(discover, FALLBACK, ttlMs)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('catalog poller', () => {
  it('skips every tick while no eligible account exists — zero spawns', async () => {
    vi.useFakeTimers()
    let calls = 0
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      return { stdout: '', stderr: '' }
    })
    const poller = startCatalogPoller({
      catalog: makeCatalog(discover),
      canDiscover: () => false,
    })
    try {
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(0)
    } finally {
      poller.stop()
    }
  })

  it('recovers immediately when an account appears', async () => {
    vi.useFakeTimers()
    let calls = 0
    let eligible = false
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      return { stdout: JSON.stringify([{ id: 'm1', display_name: 'm1' }]), stderr: '' }
    })
    const poller = startCatalogPoller({
      catalog: makeCatalog(discover),
      canDiscover: () => eligible,
    })
    try {
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(0)
      eligible = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
    } finally {
      poller.stop()
    }
  })

  it('backs off exponentially on consecutive failures, capped at 10 minutes', async () => {
    vi.useFakeTimers()
    let calls = 0
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      throw new Error('Please sign in')
    })
    const poller = startCatalogPoller({
      catalog: makeCatalog(discover),
      canDiscover: () => true,
    })
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      // failures=1 → next attempt at +120s.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(2)
      // failures=2 → +240s (t=420).
      await vi.advanceTimersByTimeAsync(240_000)
      expect(calls).toBe(3)
      // failures=3 → +480s (t=900).
      await vi.advanceTimersByTimeAsync(480_000)
      expect(calls).toBe(4)
      // failures≥4 → capped at +600s (t=1500, then every 600s).
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(5)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(calls).toBe(6)
      expect(CATALOG_BACKOFF_MAX_MS).toBe(600_000)
    } finally {
      poller.stop()
    }
  })

  it('success resets backoff to the base cadence', async () => {
    vi.useFakeTimers()
    let calls = 0
    let fail = true
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      if (fail) throw new Error('boom')
      return { stdout: JSON.stringify([{ id: 'm1', display_name: 'm1' }]), stderr: '' }
    })
    const poller = startCatalogPoller({
      // Tiny TTL so every tick re-discovers and the cadence is observable.
      catalog: makeCatalog(discover, 1),
      canDiscover: () => true,
    })
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      fail = false
      await vi.advanceTimersByTimeAsync(120_000)
      expect(calls).toBe(2)
      fail = true
      // With backoff reset, the next attempt is one base interval later —
      // a persisted backoff (240s) would not have fired yet.
      await vi.advanceTimersByTimeAsync(59_000)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(3)
    } finally {
      poller.stop()
    }
  })

  it('a fresh discovered catalog keeps ticks no-op until TTL expiry', async () => {
    vi.useFakeTimers()
    let calls = 0
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      return { stdout: JSON.stringify([{ id: 'm1', display_name: 'm1' }]), stderr: '' }
    })
    const poller = startCatalogPoller({
      catalog: makeCatalog(discover, 300_000),
      canDiscover: () => true,
    })
    try {
      await vi.advanceTimersByTimeAsync(240_000)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(calls).toBe(2)
    } finally {
      poller.stop()
    }
  })

  it('stop() ends the chain — no further attempts', async () => {
    vi.useFakeTimers()
    let calls = 0
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      throw new Error('boom')
    })
    const poller = startCatalogPoller({
      catalog: makeCatalog(discover),
      canDiscover: () => true,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(1)
    poller.stop()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls).toBe(1)
  })
})