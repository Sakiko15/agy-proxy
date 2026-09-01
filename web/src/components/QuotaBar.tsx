// Quota bar (charter §9 page 3): one bar for a 0..1 fraction; unknown renders
// muted. resetCountdown shows when data exists.
import { useTranslation } from 'react-i18next'
import { clampFraction } from '../lib/quota.ts'
import { countdownUntil } from '../lib/quota.ts'
import { formatPercent } from '../lib/format.ts'

export function QuotaBar({ label, fraction, resetTime }: { label: string; fraction: number | undefined; resetTime?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const value = clampFraction(fraction)
  const width = value === null ? '0%' : `${Math.round(value * 100)}%`
  const tone = value === null ? 'bg-muted' : value >= 0.5 ? 'bg-emerald-500' : value >= 0.2 ? 'bg-amber-500' : 'bg-destructive'
  const until = countdownUntil(resetTime)
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{formatPercent(value)}{until !== '' ? ` · ${until}` : ''}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value * 100)} aria-label={label}>
        <div className={`h-full ${tone} transition-[width]`} style={{ width }} />
      </div>
      {value === null && <span className="sr-only">{t('common.unknown')}</span>}
    </div>
  )
}