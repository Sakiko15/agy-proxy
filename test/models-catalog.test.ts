// ModelCatalog semantics (MA5): in-flight dedupe, TTL gating, lastError
// lifecycle, and the stale-while-revalidate pin — a failed re-validation
// keeps serving the discovered list with lastError set. Pure module tests:
// the discover fn is a stub, no spawn involved.
import { describe, it, expect, vi } from 'vitest'
import { ModelCatalog, defaultEffortFor, type Catalog, type DiscoverFn } from '../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS, defaultConfig } from '../src/common/types.ts'

const FALLBACK = DEFAULT_FALLBACK_MODELS

interface Deferred {
  promise: Promise<{ stdout: string; stderr: string }>
  resolve: (v: { stdout: string; stderr: string }) => void
  reject: (e: Error) => void
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<{ stdout: string; stderr: string }>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function okCatalog(ids: string[]): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(ids.map((id) => ({ id, display_name: id }))), stderr: '' }
}

describe('ModelCatalog', () => {
  it('dedupes in-flight refreshes: concurrent refreshIfNeeded spawns once', async () => {
    const gate = deferred()
    let calls = 0
    const discover: DiscoverFn = vi.fn(() => {
      calls += 1
      return gate.promise
    })
    const catalog = new ModelCatalog(discover, FALLBACK, 300_000)
    const a = catalog.refreshIfNeeded()
    const b = catalog.refreshIfNeeded()
    expect(calls).toBe(1)
    gate.resolve(okCatalog(['m1']))
    await Promise.all([a, b])
    expect(catalog.get().source).toBe('discovered')
    expect(calls).toBe(1)
  })

  it('TTL: fresh discovered catalogs skip re-discovery until the TTL elapses', async () => {
    let calls = 0
    const discover: DiscoverFn = vi.fn(async () => {
      calls += 1
      return okCatalog(['m1'])
    })
    const ttl = 100
    const catalog = new ModelCatalog(discover, FALLBACK, ttl)
    await catalog.refreshIfNeeded()
    expect(calls).toBe(1)
    await catalog.refreshIfNeeded()
    await catalog.refreshIfNeeded()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, ttl + 30))
    await catalog.refreshIfNeeded()
    expect(calls).toBe(2)
  })

  it('lastError lifecycle: set on failure, cleared on success, SWR-pinned on later failure', async () => {
    let fail = true
    const discover: DiscoverFn = vi.fn(async () => {
      if (fail) throw new Error('Please sign in')
      return okCatalog(['m1', 'm2'])
    })
    const catalog = new ModelCatalog(discover, FALLBACK, 300_000)
    await catalog.forceRefresh()
    let c = catalog.get() as Catalog
    expect(c.source).toBe('fallback')
    expect(c.lastError).toContain('Please sign in')

    fail = false
    await catalog.forceRefresh()
    c = catalog.get()
    expect(c.source).toBe('discovered')
    expect(c.lastError).toBeUndefined()

    // Stale-while-revalidate: a failed re-validation keeps the discovered
    // list live and records why the refresh failed.
    fail = true
    await catalog.forceRefresh()
    c = catalog.get()
    expect(c.source).toBe('discovered')
    expect(c.models.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(c.lastError).toContain('Please sign in')
  })

  it('empty stdout: stays fallback with the no-entries error', async () => {
    const discover: DiscoverFn = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const catalog = new ModelCatalog(discover, FALLBACK, 300_000)
    await catalog.forceRefresh()
    const c = catalog.get()
    expect(c.source).toBe('fallback')
    expect(c.lastError).toBe('agy models returned no entries')
  })

  it('forceRefresh resolves with the post-refresh catalog', async () => {
    const discover: DiscoverFn = vi.fn(async () => okCatalog(['m1']))
    const catalog = new ModelCatalog(discover, FALLBACK, 300_000)
    const after = await catalog.forceRefresh()
    expect(after.source).toBe('discovered')
    expect(after.models.map((m) => m.id)).toEqual(['m1'])
    expect(after.discoveredAt).toBeGreaterThan(0)
  })

  it('defaultEffortFor picks high → medium → low unless config pins one', () => {
    const cfg = defaultConfig()
    const entry = { id: 'g', name: 'g', efforts: ['low', 'medium', 'high'] }
    expect(defaultEffortFor(entry, cfg)).toBe('high')
    expect(defaultEffortFor(entry, { ...cfg, defaultEffort: 'medium' })).toBe('medium')
    expect(defaultEffortFor({ id: 'g', name: 'g', efforts: null }, cfg)).toBeUndefined()
  })
})