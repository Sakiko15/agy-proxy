// Login page (charter §9 page 1): admin password → POST /admin/login. The
// server damps failures 300ms; a 401 says "invalid password" verbatim.
import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, ApiError } from '../api/client.ts'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../components/ui.tsx'

export function LoginPage(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    api
      .login(password)
      .then(() => {
        void navigate({ to: '/' })
        // reload-less handoff: dashboards refetch under the new cookie
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) toast.error(t('login.failed'))
        else toast.error(`${t('login.networkFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setBusy(false))
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('login.title')}</CardTitle>
          <CardDescription>{t('login.hint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="admin-password">{t('login.password')}</Label>
              <Input
                id="admin-password"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
            </div>
            <Button type="submit" disabled={busy || password === ''}>
              {busy ? `${t('common.loading')}` : t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}