// Display formatting helpers (pure).
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatTime(epochMs: number | undefined | null): string {
  if (epochMs === null || epochMs === undefined) return '—'
  return new Date(epochMs).toLocaleString()
}

export function formatIsoTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : iso
}

/** Percent 0..1 → display string ('—' for unknown). */
export function formatPercent(fraction: number | null): string {
  if (fraction === null) return '—'
  return `${Math.round(fraction * 100)}%`
}