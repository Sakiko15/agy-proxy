// Usage log page (charter §9 page 5): filter by key/account/model/family/
// protocol/status/from/to, server-paginated ≤500 rows, status chips,
// client-side CSV export of the filtered rows (button disabled past the
// 500-row query cap). Schema v2 (M5) added usage.error_text: failed rows
// carry their terminal error detail — expanded in place under the row and
// included in the CSV. Account attribution: the server enriches each row
// with the pool alias/email (read-time; orphaned/deleted ids keep the raw
// accountId visible).
import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { api, buildQuery } from '../api/client.ts'
import type { UsageRow } from '../api/types.ts'
import { toCsv, downloadCsv } from '../lib/csv.ts'
import { formatDuration, formatTime } from '../lib/format.ts'
import { Badge, Button, Card, CardContent, EmptyState, PageHeader } from '../components/ui.tsx'

const PAGE_SIZE = 50

interface Filters {
  keyId: string
  accountId: string
  model: string
  family: string
  protocol: string
  status: string
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { keyId: '', accountId: '', model: '', family: '', protocol: '', status: '', from: '', to: '' }

export function UsagePage(): React.JSX.Element {
  const { t } = useTranslation()
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)

  const query = useMemo(
    () =>
      buildQuery({
        keyId: filters.keyId,
        accountId: filters.accountId,
        model: filters.model,
        family: filters.family,
        protocol: filters.protocol,
        status: filters.status,
        from: filters.from === '' ? undefined : new Date(filters.from).getTime(),
        to: filters.to === '' ? undefined : new Date(filters.to).getTime(),
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    [filters, page],
  )
  const rowsQuery = useQuery({ queryKey: ['usage', query], queryFn: () => api.usage(query) })
  const keysQuery = useQuery({ queryKey: ['keys'], queryFn: () => api.keys() })
  // Full pool data (not /admin/status): disabled accounts still served
  // historical rows, so the filter lists them too; shares the ['pool'] cache
  // with the accounts page.
  const poolQuery = useQuery({ queryKey: ['pool'], queryFn: () => api.pool() })
  const rows = rowsQuery.data?.rows ?? []
  const total = rowsQuery.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const exportCsv = (): void => {
    if (rowsQuery.data === undefined || rowsQuery.data.rows.length === 0) return
    const csv = toCsv<UsageRow>(rowsQuery.data.rows, [
      { header: 'request_id', value: (r) => r.requestId },
      { header: 'time', value: (r) => new Date(r.createdAt).toISOString() },
      { header: 'key_id', value: (r) => r.keyId },
      { header: 'account_id', value: (r) => r.accountId },
      { header: 'account_alias', value: (r) => r.accountAlias ?? r.accountEmail ?? r.accountId ?? '' },
      { header: 'model', value: (r) => r.model },
      { header: 'family', value: (r) => r.family },
      { header: 'protocol', value: (r) => r.protocol },
      { header: 'status', value: (r) => r.status },
      { header: 'prompt_tokens', value: (r) => r.promptTokens },
      { header: 'completion_tokens', value: (r) => r.completionTokens },
      { header: 'total_tokens', value: (r) => r.totalTokens },
      { header: 'duration_ms', value: (r) => r.durationMs },
      // schema v2: terminal failure text rides alongside its status (empty for OK rows)
      { header: 'error_text', value: (r) => r.errorText ?? '' },
    ])
    downloadCsv(`agy-proxy-usage-${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  return (
    <div>
      <PageHeader
        title={t('usage.title')}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={(rowsQuery.data?.total ?? 0) > PAGE_SIZE || (rowsQuery.data?.rows.length ?? 0) === 0}
            title={(rowsQuery.data?.total ?? 0) > PAGE_SIZE ? t('usage.exportLimited', { total: rowsQuery.data?.total }) : undefined}
            onClick={exportCsv}
          >
            <Download className="size-3.5" aria-hidden />
            {t('usage.exportCsv')}
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 lg:grid-cols-8">
          <FilterInput label={t('usage.filterModel')} value={filters.model} onChange={(v) => setFilters({ ...filters, model: v })} />
          <FilterInput label={t('usage.filterFamily')} value={filters.family} onChange={(v) => setFilters({ ...filters, family: v })} />
          <FilterSelect
            label={t('usage.filterProtocol')}
            value={filters.protocol}
            onChange={(v) => setFilters({ ...filters, protocol: v })}
            options={[{ value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }]}
          />
          <FilterInput label={t('usage.filterStatus')} value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} />
          <FilterSelect
            label={t('usage.filterAccount')}
            value={filters.accountId}
            onChange={(v) => setFilters({ ...filters, accountId: v })}
            options={(poolQuery.data?.pool.accounts ?? []).map((a) => ({
              value: a.id,
              label: a.email !== undefined && a.email !== '' ? `${a.alias} (${a.email})` : a.alias,
            }))}
          />
          <FilterInput label={t('usage.filterFrom')} type="datetime-local" value={filters.from} onChange={(v) => setFilters({ ...filters, from: v })} />
          <FilterInput label={t('usage.filterTo')} type="datetime-local" value={filters.to} onChange={(v) => setFilters({ ...filters, to: v })} />
          <FilterSelect
            label={t('usage.filterKey')}
            value={filters.keyId}
            onChange={(v) => setFilters({ ...filters, keyId: v })}
            options={(keysQuery.data?.keys ?? []).map((key) => ({ value: key.id, label: `${key.prefix}… ${key.name}` }))}
          />
        </CardContent>
      </Card>

      {rows.length === 0 && !rowsQuery.isLoading ? (
        <EmptyState title={t('usage.empty')} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="p-2">{t('usage.createdAt')}</th>
                    <th className="p-2">{t('dashboard.model')}</th>
                    <th className="p-2">{t('dashboard.account')}</th>
                    <th className="p-2">{t('dashboard.status')}</th>
                    <th className="p-2 text-right">{t('usage.promptTokens')}</th>
                    <th className="p-2 text-right">{t('usage.completionTokens')}</th>
                    <th className="p-2 text-right">{t('usage.totalTokens')}</th>
                    <th className="p-2 text-right">{t('usage.duration')}</th>
                    <th className="p-2">{t('usage.request')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Fragment key={row.seq}>
                      <tr className="border-b border-border/50">
                        <td className="p-2 tabular-nums text-muted-foreground">{formatTime(row.createdAt)}</td>
                        <td className="p-2 font-mono text-xs">{row.model}</td>
                        {/* Alias first; orphaned/deleted pool ids fall back to
                            the raw id (full value on hover) — honest attribution. */}
                        <td className="p-2 font-mono text-xs text-muted-foreground" title={row.accountId ?? undefined}>
                          {row.accountAlias ?? row.accountEmail ?? (row.accountId !== null ? shortId(row.accountId) : '—')}
                        </td>
                        <td className="p-2">
                          {row.errorText !== undefined ? (
                            <button
                              type="button"
                              className="cursor-pointer"
                              title={t('usage.errorTextCol')}
                              aria-expanded={expanded === row.seq}
                              onClick={() => setExpanded((cur) => (cur === row.seq ? null : row.seq))}
                            >
                              <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                            </button>
                          ) : (
                            <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                          )}
                        </td>
                        <td className="p-2 text-right tabular-nums">{row.promptTokens}</td>
                        <td className="p-2 text-right tabular-nums">{row.completionTokens}</td>
                        <td className="p-2 text-right tabular-nums">{row.totalTokens}</td>
                        <td className="p-2 text-right tabular-nums">{formatDuration(row.durationMs)}</td>
                        <td className="p-2 font-mono text-xs text-muted-foreground">{shortId(row.requestId)}</td>
                      </tr>
                      {row.errorText !== undefined && expanded === row.seq && (
                        <tr className="border-b border-border/50 bg-muted/40">
                          <td colSpan={9} className="p-3">
                            <div className="text-xs font-medium text-muted-foreground">{t('usage.errorTextCol')}</div>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">{row.errorText}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>{rowsQuery.data === undefined ? '' : t('usage.rowsTotal', { total })}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            {t('usage.prevPage')}
          </Button>
          <span>{t('usage.page', { page: page + 1 })} / {pages}</span>
          <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            {t('usage.nextPage')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function FilterInput({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'datetime-local'
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
      />
    </label>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function statusVariant(status: string): 'success' | 'danger' | 'warning' {
  if (status === 'OK') return 'success'
  if (status === 'VALIDATION_REQUIRED' || status === 'AUTH' || status === 'POOL_EXHAUSTED' || status === 'BUSY' || status === 'TIMEOUT') return 'warning'
  return 'danger'
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}