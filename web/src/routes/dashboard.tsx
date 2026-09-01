// Dashboard (charter §9 page 2): today's requests/success-rate/tokens/active
// accounts from /admin/usage (status split) + /admin/usage/summary + the
// /admin/status pool snapshot; the live feed rides the /admin/events SSE hook.
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../api/client.ts'
import { useAdminEvents } from '../sse/useAdminEvents.ts'
import { formatDuration, formatPercent, formatTime, formatTokens } from '../lib/format.ts'
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, PageHeader } from '../components/ui.tsx'

function localMidnight(): number {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return now.getTime()
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="py-3 text-2xl font-semibold tabular-nums">{value}</CardContent>
    </Card>
  )
}

function statusBadgeVariant(status: string): 'success' | 'danger' | 'warning' | 'muted' {
  if (status === 'OK') return 'success'
  if (status === 'VALIDATION_REQUIRED' || status === 'AUTH') return 'warning'
  if (status === 'POOL_EXHAUSTED' || status === 'BUSY' || status === 'TIMEOUT') return 'warning'
  return 'danger'
}

export function DashboardPage(): React.JSX.Element {
  const { t } = useTranslation()
  const events = useAdminEvents()
  const summary = useQuery({ queryKey: ['usage-summary'], queryFn: () => api.usageSummary() })
  const status = useQuery({ queryKey: ['status'], queryFn: () => api.status() })
  const midnight = localMidnight()
  const allToday = useQuery({ queryKey: ['usage-today-all', midnightKey(midnight)], queryFn: () => api.usage(`?from=${midnight}&limit=1`) })
  const okToday = useQuery({ queryKey: ['usage-today-ok', midnightKey(midnight)], queryFn: () => api.usage(`?from=${midnight}&status=OK&limit=1`) })

  const totalAll = allToday.data?.total ?? 0
  const totalOk = okToday.data?.total ?? 0
  const successRate = totalAll > 0 ? formatPercent(totalOk / totalAll) : '—'
  const accounts = status.data?.pool.accounts ?? []
  const active = accounts.filter((a) => a.enabled && a.authRequired !== true && Object.keys(a.cooldowns ?? {}).length === 0)
  const errors = events.runs.filter((r) => !r.ok).slice(0, 8)

  return (
    <div>
      <PageHeader title={t('dashboard.title')} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('dashboard.todayRequests')} value={String(summary.data?.today.requests ?? '—')} />
        <StatCard label={t('dashboard.todaySuccessRate')} value={successRate} />
        <StatCard label={t('dashboard.todayTokens')} value={summary.data?.today !== undefined ? formatTokens(summary.data.today.totalTokens) : '—'} />
        <StatCard
          label={t('dashboard.activeAccounts')}
          value={status.data === undefined ? '—' : `${active.length} / ${accounts.length}`}
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('dashboard.liveFeed')}</CardTitle>
          </CardHeader>
          <CardContent>
            {events.runs.length === 0 ? (
              <EmptyState title={t('dashboard.noRuns')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-2">{t('dashboard.time')}</th>
                      <th className="py-1.5 pr-2">{t('dashboard.model')}</th>
                      <th className="py-1.5 pr-2">{t('dashboard.status')}</th>
                      <th className="py-1.5 pr-2">{t('dashboard.duration')}</th>
                      <th className="py-1.5 pr-2">{t('dashboard.tokens')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.runs.slice(0, 15).map((run) => (
                      <tr key={`run-${run.reqId}-${run.at}`} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">{formatTime(run.at)}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs">{run.model}</td>
                        <td className="py-1.5 pr-2">
                          <Badge variant={statusBadgeVariant(run.status)}>{run.status}</Badge>
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums">{formatDuration(run.durationMs)}</td>
                        <td className="py-1.5 pr-2 tabular-nums">
                          {run.usage === null ? '—' : `${run.usage.promptTokens}+${run.usage.completionTokens}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t('dashboard.recentErrors')}</CardTitle>
          </CardHeader>
          <CardContent>
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard.noErrors')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {errors.map((run) => (
                  <li key={`err-${run.reqId}-${run.at}`} className="rounded border border-border/60 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={statusBadgeVariant(run.status)}>{run.status}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{run.model}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function midnightKey(ms: number): number {
  return Math.floor(ms / 60000)
}