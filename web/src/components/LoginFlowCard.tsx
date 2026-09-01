// Paste-URL login flow card (charter §9 page 3): begin → phase waiting → QR
// <img> (same-origin session cookie authorizes the PNG) + link + paste the
// callback URL/code → complete. Auto/manual mode is tolerated (EADDRINUSE
// downgrades server-side); 2s status polling while waiting.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, ApiError } from '../api/client.ts'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from './ui.tsx'

export function LoginFlowCard({ onDone }: { onDone?: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['pool-auth'],
    queryFn: () => api.authStatus(),
    refetchInterval: (query) => (query.state.data?.phase === 'waiting' || query.state.data?.phase === 'exchanging' ? 2_000 : false),
  })
  const [code, setCode] = useState('')
  const phase = status.data?.phase ?? 'idle'
  if (phase === 'idle') return null

  const complete = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    api
      .authComplete(code)
      .then((result) => {
        if (result.phase === 'done') {
          toast.success(t('accounts.loginFlow.done'))
          void queryClient.invalidateQueries({ queryKey: ['pool-auth'] })
          onDone?.()
        } else if (result.phase === 'failed') {
          toast.error(result.message ?? t('accounts.loginFlow.failed'))
        } else {
          toast.error(t('accounts.loginFlow.waiting'))
        }
      })
      .catch((error: unknown) => {
        toast.error(error instanceof ApiError ? error.message : String(error))
      })
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {t('accounts.loginFlow.title')}
          {status.data?.alias !== undefined && <span className="ml-2 text-xs text-muted-foreground">{status.data.alias}</span>}
          <Badge variant={phase === 'done' ? 'success' : phase === 'failed' ? 'danger' : 'muted'} className="ml-2 align-middle">
            {phase}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row">
        {phase === 'waiting' && status.data?.url !== undefined && (
          <>
            <img
              src="/admin/pool/auth/qr"
              alt="QR"
              width={160}
              height={160}
              className="h-40 w-40 rounded border border-border bg-white p-1"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{t('accounts.loginFlow.step1')}</p>
              <a
                href={status.data.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 line-clamp-2 break-all text-sm text-primary underline-offset-2 hover:underline"
              >
                {status.data.url}
              </a>
              <form onSubmit={complete} className="mt-3 flex flex-col gap-1.5">
                <Label htmlFor="login-code">{t('accounts.loginFlow.pasteUrl')}</Label>
                <div className="flex gap-1.5">
                  <Input id="login-code" required value={code} onChange={(e) => setCode(e.currentTarget.value)} placeholder="https://localhost:51121/oauth-callback?code=…" />
                  <Button size="sm" type="submit">{t('accounts.loginFlow.complete')}</Button>
                </div>
              </form>
            </div>
          </>
        )}
        {phase === 'done' && <p className="text-sm text-emerald-600 dark:text-emerald-400">{t('accounts.loginFlow.done')}</p>}
        {phase === 'failed' && <p className="text-sm text-destructive">{status.data?.message ?? t('accounts.loginFlow.failed')}</p>}
        <div className="sm:ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void api.authCancel().then(() => onDone?.()).catch(() => undefined)}
          >
            {t('accounts.loginFlow.cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}