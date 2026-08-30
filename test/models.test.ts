// Ported from dsh-agy-link test/models.test.ts @ 46984db (converted:
// node:test/assert → vitest describe/it/expect; PluginConfig → GatewayConfig).
import { describe, it, expect } from 'vitest'
import { buildFallbackCatalog, defaultEffortFor, findEntry, foldEfforts, parseModelsOutput } from '../src/host/models.ts'
import { DEFAULT_FALLBACK_MODELS, defaultConfig, type GatewayConfig } from '../src/common/types.ts'

describe('models', () => {
  it('parseModelsOutput reads the JSON array shape', () => {
    const raw = JSON.stringify([
      { id: 'gemini-3-6-flash', display_name: 'Gemini 3.6 Flash' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ])
    const out = parseModelsOutput(raw)
    expect(out.length).toBe(2)
    expect(out[0]?.slug).toBe('gemini-3-6-flash')
    expect(out[0]?.label).toBe('Gemini 3.6 Flash')
  })

  it('parseModelsOutput reads the TAB-separated agy 1.1.15 table and folds efforts', () => {
    // Captured verbatim from a live `agy models` (1.1.15, signed in)
    const table = [
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    ].join('\n')
    const out = parseModelsOutput(table)
    expect(out.length).toBe(5)
    expect(out[0]?.slug).toBe('gemini-3.7-flash-high')
    expect(out[0]?.label).toBe('Gemini 3.7 Flash (High)')
    const folded = foldEfforts(out)
    const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3.7-flash')
    expect(base).toBeTruthy()
    expect(base?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('parseModelsOutput reads the two-column text shape', () => {
    const out = parseModelsOutput('gemini-3-6-flash    Gemini 3.6 Flash\nclaude-sonnet-4-6    Claude Sonnet 4.6\n')
    expect(out.length).toBe(2)
    expect(out[1]?.slug).toBe('claude-sonnet-4-6')
  })

  it('parseModelsOutput handles dotted current-gen slugs', () => {
    // agy 1.1.13 prints gemini-3.7-flash(-medium) etc. (dots, not dashes)
    const out = parseModelsOutput('gemini-3.7-flash    Gemini 3.7 Flash\ngemini-3.7-flash-medium    Gemini 3.7 Flash (Medium)\ngemini-3.6-flash    Gemini 3.6 Flash\n')
    expect(out.map((r) => r.slug)).toEqual(['gemini-3.7-flash', 'gemini-3.7-flash-medium', 'gemini-3.6-flash'])
    const folded = foldEfforts(out)
    const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3.7-flash')
    expect(base).toBeTruthy()
    expect(base?.efforts).toEqual(['medium'])
  })

  it('fallback catalog carries the current model line-up incl. 3.7', () => {
    const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
    const ids = cat.map((e) => e.id)
    expect(ids).toContain('gemini-3.7-flash')
    expect(ids).toContain('gemini-3.6-flash')
    expect(ids).toContain('claude-opus-4-6-thinking')
    expect(ids).toContain('gpt-oss-120b-medium')
    const f37 = findEntry({ source: 'fallback', models: cat, discoveredAt: 0 }, 'gemini-3.7-flash')
    expect(f37?.efforts).toEqual(['low', 'medium', 'high'])
  })

  it('parseModelsOutput skips banners and error lines', () => {
    const out = parseModelsOutput('Fetching models...\nError: hmm\ngemini-3-6-flash    Flash\n')
    expect(out.length).toBe(1)
  })

  it('foldEfforts folds gemini effort suffixes into a base entry', () => {
    const folded = foldEfforts([
      { slug: 'gemini-3-6-flash', label: 'Gemini 3.6 Flash' },
      { slug: 'gemini-3-6-flash-high', label: 'Gemini 3.6 Flash High' },
      { slug: 'gemini-3-6-flash-low', label: 'Gemini 3.6 Flash Low' },
      { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ])
    const ids = folded.map((e) => e.id)
    expect(ids).toContain('gemini-3-6-flash')
    expect(ids).not.toContain('gemini-3-6-flash-high')
    const base = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'gemini-3-6-flash')
    expect(base?.efforts).toEqual(['low', 'high'])
    const claude = findEntry({ source: 'discovered', models: folded, discoveredAt: 0 }, 'claude-sonnet-4-6')
    expect(claude?.efforts).toBeNull()
  })

  it('foldEfforts emits no duplicate ids when agy lists the bare base plus one variant (issue #1)', () => {
    // agy 1.1.13 shape: the bare base IS a catalog member next to its
    // variants. Folding must absorb the bare entry into the folded base
    // instead of emitting the id twice — protocol layers must not see the
    // same model id twice in the /v1/models listing.
    const folded = foldEfforts([
      { slug: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { slug: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
      { slug: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    ])
    const ids = folded.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const base = folded.filter((e) => e.id === 'gemini-3.7-flash')
    expect(base.length).toBe(1)
    expect(base[0]?.efforts).toEqual(['medium'])
    // Unrelated bare entries stay verbatim.
    expect(ids).toContain('gemini-3.6-flash')
  })

  it('foldEfforts emits no duplicate ids when the bare base is listed alongside every variant', () => {
    const folded = foldEfforts([
      { slug: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
      { slug: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
      { slug: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
      { slug: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
      { slug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    ])
    const ids = folded.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const base = folded.filter((e) => e.id === 'gemini-3.7-flash')
    expect(base.length).toBe(1)
    expect(base[0]?.efforts).toEqual(['low', 'medium', 'high'])
    expect(ids).toContain('claude-sonnet-4-6')
  })

  it('parseModelsOutput dedupes repeated slugs', () => {
    // Some agy builds print the same row twice (e.g. overlapping sections);
    // duplicate raw slugs would become duplicate catalog ids downstream.
    const out = parseModelsOutput([
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    ].join('\n'))
    expect(out.map((r) => r.slug)).toEqual(['gemini-3.7-flash-high', 'claude-sonnet-4-6'])
  })

  it('bare gemini base without siblings gets no efforts', () => {
    const folded = foldEfforts([{ slug: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro' }])
    expect(folded[0]?.efforts).toBeNull()
  })

  it('buildFallbackCatalog carries configurable efforts', () => {
    const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
    expect(cat.length).toBe(7)
    const flash = cat.find((e) => e.id === 'gemini-3.7-flash')
    expect(flash?.efforts).toEqual(['low', 'medium', 'high'])
    const claude = cat.find((e) => e.id === 'claude-sonnet-4-6')
    expect(claude?.efforts).toBeNull()
  })

  it('defaultEffortFor prefers config override then high first', () => {
    const cfg: GatewayConfig = { ...defaultConfig(), defaultEffort: 'low' }
    const cat = buildFallbackCatalog(DEFAULT_FALLBACK_MODELS)
    const flash = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.7-flash')
    expect(flash && defaultEffortFor(flash, cfg)).toBe('low')
    // No config override: default is the highest available effort.
    const cfg2: GatewayConfig = { ...defaultConfig(), defaultEffort: '' }
    expect(flash && defaultEffortFor(flash, cfg2)).toBe('high')
    // pro line-up has no medium; high still wins.
    const pro = findEntry({ source: 'discovered', models: cat, discoveredAt: 0 }, 'gemini-3.1-pro')
    expect(pro && defaultEffortFor(pro, cfg2)).toBe('high')
  })

  it('effort suffix ids still resolve to their base entry', () => {
    const folded = foldEfforts([
      { slug: 'gemini-3-6-flash', label: 'F' },
      { slug: 'gemini-3-6-flash-high', label: 'FH' },
    ])
    const cat = { source: 'discovered' as const, models: folded, discoveredAt: 0 }
    expect(findEntry(cat, 'gemini-3-6-flash')?.id).toBe('gemini-3-6-flash')
  })

  it('findEntry resolves aliases via resolveModelSlug', () => {
    const cat = { source: 'fallback' as const, models: buildFallbackCatalog(DEFAULT_FALLBACK_MODELS), discoveredAt: 0 }
    expect(findEntry(cat, 'claude-opus-4-6')?.id).toBe('claude-opus-4-6-thinking')
    expect(findEntry(cat, 'claude-opus')?.id).toBe('claude-opus-4-6-thinking')
    expect(findEntry(cat, 'gpt-oss-120b')?.id).toBe('gpt-oss-120b-medium')
  })
})
