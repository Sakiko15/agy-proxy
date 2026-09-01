// API Keys page (charter §9 page 4): list with prefix/tokensToday/limits,
// create-once dialog (plaintext shown exactly once, "I saved it" gates the
// close), disable/enable + limits edit via PATCH, delete with confirm. The
// M5 scopes column renders as a read-only badge — enforcement is deferred,
// and a dead edit form would be worse than a labelled placeholder.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as Dialog from '@radix-ui/react-dialog'
import { api, ApiError } from '../api/client.ts'
import type { ApiKeyWithToday } from '../api/types.ts'
import { formatTime, formatTokens } from '../lib/format.ts'
import { Badge, Button, Card, CardContent, EmptyState, Input, Label, PageHeader } from '../components/ui.tsx'

export function KeysPage(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const keysQuery = useQuery({ queryKey: ['keys'], queryFn: () => api.keys() })
  const keys = keysQuery.data?.keys ?? []
  const [creating, setCreating] = useState(false)

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['keys'] })
    void queryClient.invalidateQueries({ queryKey: ['status'] })
  }

  return (
    <div>
      <PageHeader
        title={t('keys.title')}
        description={t('keys.subtitle')}
        actions={<Button size="sm" onClick={() => setCreating(true)}>{t('keys.create')}</Button>}
      />

      {keys.length === 0 ? (
        <EmptyState
          title={t('keys.empty')}
          action={<Button onClick={() => setCreating(true)}>{t('keys.create')}</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} onChanged={refresh} />
          ))}
        </div>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={refresh} />
    </div>
  )
}

function KeyRow({ apiKey, onChanged }: { apiKey: ApiKeyWithToday; onChanged: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [dailyLimit, setDailyLimit] = useState(String(apiKey.dailyTokenLimit))
  const [rpmLimit, setRpmLimit] = useState(String(apiKey.rpmLimit))

  const disabled = apiKey.disabledAt !== null
  return (
    <Card className={disabled ? 'opacity-60' : undefined}>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <div className="min-w-40">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{apiKey.prefix}…</span>
            <Badge variant={disabled ? 'muted' : 'success'}>{disabled ? t('common.disabled') : t('common.enabled')}</Badge>
            {apiKey.scopes !== null && <Badge variant="outline">{t('keys.scopesM5')}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{apiKey.name}</div>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('keys.tokensToday')}: <span className="tabular-nums text-foreground">{formatTokens(apiKey.tokensToday)}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('keys.dailyLimit')}: <span className="tabular-nums text-foreground">{apiKey.dailyTokenLimit > 0 ? formatTokens(apiKey.dailyTokenLimit) : t('keys.unlimited')}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('keys.rpmLimit')}: <span className="tabular-nums text-foreground">{apiKey.rpmLimit > 0 ? apiKey.rpmLimit : t('keys.unlimited')}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('keys.lastUsed')}: {formatTime(apiKey.lastUsedAt)}
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
            {t('common.edit')}
          </Button>
          {disabled ? (
            <Button variant="outline" size="sm" onClick={() => void api.patchKey(apiKey.id, { disabled: false }).then(onChanged).catch(showError)}>
              {t('common.enable')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (window.confirm(t('keys.disableConfirm'))) void api.patchKey(apiKey.id, { disabled: true }).then(onChanged).catch(showError)
              }}
            >
              {t('common.disable')}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (window.confirm(t('keys.deleteConfirm'))) void api.deleteKey(apiKey.id).then(onChanged).catch(showError)
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
        {editing && (
          <form
            className="flex w-full flex-wrap items-end gap-2 border-t border-border pt-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault()
              void api
                .patchKey(apiKey.id, { dailyTokenLimit: Number(dailyLimit) || 0, rpmLimit: Number(rpmLimit) || 0 })
                .then(() => {
                  toast.success(t('settings.saved'))
                  setEditing(false)
                  onChanged()
                })
                .catch(showError)
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor={`daily-${apiKey.id}`}>{t('keys.dailyTokenLimit')}</Label>
              <Input id={`daily-${apiKey.id}`} type="number" min={0} value={dailyLimit} onChange={(e) => setDailyLimit(e.currentTarget.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rpm-${apiKey.id}`}>{t('keys.rpmLimit')}</Label>
              <Input id={`rpm-${apiKey.id}`} type="number" min={0} value={rpmLimit} onChange={(e) => setRpmLimit(e.currentTarget.value)} />
            </div>
            <Button size="sm" type="submit">{t('common.save')}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function showError(error: unknown): void {
  toast.error(error instanceof ApiError ? error.message : String(error))
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [dailyLimit, setDailyLimit] = useState('0')
  const [rpmLimit, setRpmLimit] = useState('0')
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    api
      .createKey({
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        dailyTokenLimit: Number(dailyLimit) || 0,
        rpmLimit: Number(rpmLimit) || 0,
      })
      .then((created) => {
        setPlaintext(created.plaintext)
        setSaved(false)
        onCreated()
      })
      .catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : String(error)))
  }

  const close = (next: boolean): void => {
    onOpenChange(next)
    if (next === false) {
      setPlaintext(null)
      setName('')
      setDailyLimit('0')
      setRpmLimit('0')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 focus-visible:outline-ring">
          <Dialog.Title className="text-sm font-semibold">{t('keys.createTitle')}</Dialog.Title>
          {plaintext === null ? (
            <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-name">{t('keys.createName')}</Label>
                <Input id="key-name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-daily">{t('keys.dailyTokenLimit')}</Label>
                <Input id="key-daily" type="number" min={0} value={dailyLimit} onChange={(e) => setDailyLimit(e.currentTarget.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="key-rpm">{t('keys.rpmLimit')}</Label>
                <Input id="key-rpm" type="number" min={0} value={rpmLimit} onChange={(e) => setRpmLimit(e.currentTarget.value)} />
              </div>
              <Button type="submit">{t('common.create')}</Button>
            </form>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('keys.plaintextOnce')}</p>
              <code className="block overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs select-all">{plaintext}</code>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => {
                  void navigator.clipboard.writeText(plaintext).then(() => toast.success(t('common.copied')))
                }}
              >
                {t('common.copy')}
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} aria-label={t('keys.saved')} />
                {t('keys.saved')}
              </label>
              <Button disabled={!saved} onClick={() => close(false)}>
                {t('common.close')}
              </Button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}