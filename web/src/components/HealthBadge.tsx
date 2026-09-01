// Account health badge (mirrors pool-types getAccountHealth four states) with
// the live cooldown countdown ticked per second.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { countdownUntil } from '../lib/quota.ts'
import { Badge } from './ui.tsx'

export interface HealthInput {
  enabled: boolean
  authRequired?: boolean | null
  cooldownUntilMs?: number | null
}

export function HealthBadge({ account }: { account: HealthInput }): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  if (!account.enabled) return <Badge variant="muted">{t('accounts.disabled')}</Badge>
  if (account.authRequired === true) return <Badge variant="warning">{t('accounts.authRequired')}</Badge>
  const cd = countdownUntil(account.cooldownUntilMs ?? undefined, now)
  if (cd !== '') return <Badge variant="warning">{`${t('accounts.cooldown')} · ${cd}`}</Badge>
  return <Badge variant="success">{t('accounts.healthy')}</Badge>
}