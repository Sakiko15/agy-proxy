// Accounts page (charter §9 page 3): card per account — email/alias, dual
// quota bars (5h + weekly from Google's quota endpoint data), cooldown
// countdown + reason, health incl. VALIDATION_REQUIRED surfacing, paste-URL
// login with QR, enable/disable, proxy edit, clear-cooldown, refresh quota.
// Pool data comes live from the SSE snapshot events (initial snapshot makes
// the page paint without a fetch).
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { api, ApiError } from '../api/client.ts'
import { useAdminEvents } from '../sse/useAdminEvents.ts'
import { countdownUntil } from '../lib/quota.ts'
import { formatIsoTime, formatTime } from '../lib/format.ts'
import { HealthBadge } from '../components/HealthBadge.tsx'
import { LoginFlowCard } from '../components/LoginFlowCard.tsx'
import { QuotaBar } from '../components/QuotaBar.tsx'
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, PageHeader } from '../components/ui.tsx'

const FAMILY_LABEL: Record<string, string> = { google: 'Google' }

export function AccountsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const events = useAdminEvents()
  const poolQuery = useQuery({ queryKey: ['pool'], queryFn: () => api.pool() })
  const pool = events.pool ?? poolQuery.data?.pool ?? null
  const auth = useQuery({
    queryKey: ['pool-auth'],
    queryFn: () => api.authStatus(),
    refetchInterval: (query) => (query.state.data?.phase === 'waiting' || query.state.data?.phase === 'exchanging' ? 2_000 : false),
  })

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['pool'] })
    void queryClient.invalidateQueries({ queryKey: ['status'] })
  }

  const accounts = pool?.accounts ?? []
  return (
    <div>
      <PageHeader
        title={t('accounts.title')}
        description={t('accounts.subtitle')}
        actions={
          <>
            <span className="mr-1 text-xs text-muted-foreground">
              {t('accounts.mode')}: {pool?.mode === 'round-robin' ? t('accounts.modeRoundRobin') : t('accounts.modeSequential')}
            </span>
            <Button variant="outline" size="sm" onClick={() => void api.refreshQuota().then(refresh).catch(failToast)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {t('accounts.refreshAll')}
            </Button>
            <Button size="sm" onClick={() => void api.authBegin().then(() => void queryClient.invalidateQueries({ queryKey: ['pool-auth'] })).catch(failToast)}>
              {t('accounts.addAccount')}
            </Button>
          </>
        }
      />

      {auth.data !== undefined && auth.data.phase !== 'idle' && <LoginFlowCard onDone={refresh} />}

      {pool === null ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : accounts.length === 0 ? (
        <EmptyState
          title={t('accounts.noAccounts')}
          action={
            <Button onClick={() => void api.authBegin().then(refresh).catch(failToast)}>{t('accounts.addAccount')}</Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => (
            <AccountCard key={account.id} id={account.id} onDone={refresh} />
          ))}
        </div>
      )}
      {statusHint(pool?.mode)}
    </div>
  )

  function statusHint(mode: string | undefined): React.JSX.Element | null {
    if (mode !== 'sequential') return null
    return <p className="mt-3 text-xs text-muted-foreground">{t('accounts.reorderHint')}</p>
  }
}

function AccountCard({ id, onDone }: { id: string; onDone?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const events = useAdminEvents()
  const account = events.pool?.accounts.find((a) => a.id === id) ?? null
  const [proxy, setProxy] = useState<string>('')
  const [editingProxy, setEditingProxy] = useState(false)
  if (account === null) return <Card><CardContent className="p-4 text-sm text-muted-foreground">{t('common.loading')}</CardContent></Card>
  const google = account.quotas.google
  const cooldown = account.cooldowns.google

  const act = (p: Promise<unknown>, okMsg?: string): void => {
    p.then(() => {
      if (okMsg !== undefined) toast.success(okMsg)
      onDone?.()
    }).catch(failToast)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-sm">
            {account.alias}
            {account.email !== undefined && account.email !== '' && <span className="ml-2 text-xs font-normal text-muted-foreground">{account.email}</span>}
          </CardTitle>
          <HealthBadge
            account={{
              enabled: account.enabled,
              authRequired: account.authRequired,
              cooldownUntilMs: cooldown?.cooldownUntil ?? null,
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {google !== undefined && (
          <div className="flex flex-col gap-2">
            <QuotaBar label={`${FAMILY_LABEL.google ?? 'Google'} ${t('accounts.quota5h')}`} fraction={google.remainingFraction} resetTime={google.resetTime} />
            <QuotaBar label={`${FAMILY_LABEL.google} ${t('accounts.quota7d')}`} fraction={google.weeklyFraction} resetTime={google.weeklyResetTime} />
          </div>
        )}
        {cooldown !== undefined && (
          <div className="rounded border border-border/60 p-2 text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-400">
              {t('accounts.cooldownUntil')}: {countdownUntil(cooldown.cooldownUntil) || formatIsoTime(new Date(cooldown.cooldownUntil).toISOString())}
            </div>
            <div className="mt-1 line-clamp-2 text-muted-foreground" title={cooldown.reason}>{cooldown.reason}</div>
          </div>
        )}
        {account.authRequired === true && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            <p className="font-medium text-amber-800 dark:text-amber-300">{t('accounts.authRequiredHint')}</p>
            {account.authError !== undefined && <p className="mt-1 break-all text-muted-foreground">{account.authError}</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {account.enabled ? (
            <Button variant="outline" size="sm" onClick={() => void act(api.patchAccount(id, { enabled: false }))}>
              {t('common.disable')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void act(api.patchAccount(id, { enabled: true }))}>
              {t('common.enable')}
            </Button>
          )}
          {cooldown !== undefined && (
            <Button variant="outline" size="sm" onClick={() => void act(api.clearCooldown(id))}>
              {t('accounts.clearCooldown')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void act(api.refreshAccountQuota(id))}>
            {t('accounts.refreshQuota')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (window.confirm(t('accounts.deleteConfirm'))) void act(api.deleteAccount(id))
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('accounts.lastUsed')}: {formatTime(account.lastUsedAt ?? null)}
        </div>
        {editingProxy ? (
          <form
            className="flex gap-1.5"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault()
              void act(api.patchAccount(id, { proxyUrl: proxy.trim() === '' ? null : proxy.trim() }))
              setEditingProxy(false)
            }}
          >
            <Input value={proxy} placeholder="http://host:port" onChange={(e) => setProxy(e.currentTarget.value)} aria-label={t('accounts.proxy')} />
            <Button size="sm" type="submit">{t('common.save')}</Button>
          </form>
        ) : (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              setProxy(account.proxyUrl ?? '')
              setEditingProxy(true)
            }}
          >
            {t('accounts.proxy')}: {account.proxyUrl ?? '—'}
          </button>
        )}
      </CardContent>
    </Card>
  )
}

function failToast(error: unknown): void {
  toast.error(error instanceof ApiError ? error.message : String(error instanceof Error ? error.message : error))
}