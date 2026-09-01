// Quota-bar + countdown math (pure; used by the accounts page).
import type { FamilyQuotaInfo } from '../api/types.ts'

/** Clamp a 0..1 fraction defensively (upstream may omit or drift). */
export function clampFraction(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/** Human countdown until an ISO timestamp or epoch ms; '' when absent/past. */
export function countdownUntil(target: string | number | undefined, now: number = Date.now()): string {
  if (target === undefined || target === null || target === '') return ''
  const ms = typeof target === 'number' ? target : Date.parse(target)
  if (!Number.isFinite(ms)) return ''
  const remaining = ms - now
  if (remaining <= 0) return ''
  return formatRemaining(remaining)
}

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** The 5h-window bar input, if the account has one. */
export function hourlyFraction(quota: FamilyQuotaInfo): number | null {
  return clampFraction(quota.remainingFraction)
}

/** The weekly bar input, if present. */
export function weeklyFraction(quota: FamilyQuotaInfo): number | null {
  return clampFraction(quota.weeklyFraction)
}

/** A fraction is "unknown" when upstream gave no data (bar shows muted dash). */
export function isUnknownFraction(fraction: number | null): boolean {
  return fraction === null
}