// API Keys page (charter §9 page 4): list with prefix/tokensToday/limits,
// create-once dialog (plaintext shown exactly once, "I saved it" gates the
// close), disable/enable + limits + model-whitelist (M5 scopes) edits via
// PATCH, delete with confirm. Empty scopes = unrestricted (the placeholder
// says so); a configured whitelist shows its model count on the row badge.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as Dialog from '@radix-ui/react-dialog'
import { api, ApiError } from '../api/client.ts'
import type { ApiKeyWithToday } from '../api/types.ts'
import { formatTime, formatTokens } from '../lib/format.ts'
import { copyText } from '../lib/clipboard.ts'
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
  const [rotatedPlaintext, setRotatedPlaintext] = useState<string | null>(null)
  const [dailyLimit, setDailyLimit] = useState(String(apiKey.dailyTokenLimit))
  const [rpmLimit, setRpmLimit] = useState(String(apiKey.rpmLimit))
  const [scopes, setScopes] = useState(apiKey.scopes ?? '')

  const scopeModels = parseModels(apiKey.scopes)
  const disabled = apiKey.disabledAt !== null
  return (
    <Card className={disabled ? 'opacity-60' : undefined}>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <div className="min-w-40">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{apiKey.prefix}…</span>
            <Badge variant={disabled ? 'muted' : 'success'}>{disabled ? t('common.disabled') : t('common.enabled')}</Badge>
            <Badge variant="outline">
              {scopeModels === null ? t('keys.scopesAll') : t('keys.scopesModels', { n: scopeModels.length })}
            </Badge>
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
          {/* Copy affordance: null plaintext = the key predates reversible
              storage — point the admin at "Regenerate" instead of erroring. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void api.revealKeySecret(apiKey.id).then((r) => {
                if (r.plaintext === null) {
                  toast.info(t('keys.legacyNoSecret'))
                  return
                }
                void copyText(r.plaintext)
                  .then(() => toast.success(t('common.copied')))
                  .catch(() => toast.error(t('keys.copyFailed')))
              }).catch(showError)
            }}
          >
            {t('keys.copyKey')}
          </Button>
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (window.confirm(t('keys.rotateConfirm'))) {
                void api.rotateKey(apiKey.id).then((r) => {
                  setRotatedPlaintext(r.plaintext)
                  onChanged()
                }).catch(showError)
              }
            }}
          >
            {t('keys.rotate')}
          </Button>
        </div>
        {editing && (
          <form
            className="flex w-full flex-wrap items-end gap-2 border-t border-border pt-3"
            onSubmit={(e: FormEvent<HTMLFormElement>) => {
              e.preventDefault()
              const daily = Number(dailyLimit)
              const rpm = Number(rpmLimit)
              // A non-finite input ("1,000" → NaN, "1e999" → Infinity) used
              // to fall through `|| 0` into 0 = unlimited with a "saved"
              // toast — reject instead of silently unlimiting the key. The
              // integer/non-negative half mirrors the server's 400 predicate
              // (code-review #4): a negative used to reach the store as
              // unlimited, a fraction was floored.
              if (!Number.isFinite(daily) || !Number.isFinite(rpm) || !Number.isInteger(daily) || !Number.isInteger(rpm) || daily < 0 || rpm < 0) {
                toast.error(t('keys.invalidLimit'))
                return
              }
              void api
                .patchKey(apiKey.id, {
                  dailyTokenLimit: daily,
                  rpmLimit: rpm,
                  // '' clears the whitelist (server stores NULL) — the input's
                  // empty state IS the "unrestricted" affordance.
                  scopes,
                })
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
            <div className="flex min-w-64 flex-1 flex-col gap-1">
              <Label htmlFor={`scopes-${apiKey.id}`}>{t('keys.scopesEdit')}</Label>
              <Input
                id={`scopes-${apiKey.id}`}
                value={scopes}
                placeholder={t('keys.scopesHint')}
                onChange={(e) => setScopes(e.currentTarget.value)}
                className="font-mono text-xs"
              />
            </div>
            <Button size="sm" type="submit">{t('common.save')}</Button>
          </form>
        )}
        {rotatedPlaintext !== null && <RotateDialog plaintext={rotatedPlaintext} onClose={() => setRotatedPlaintext(null)} />}
      </CardContent>
    </Card>
  )
}

function showError(error: unknown): void {
  toast.error(error instanceof ApiError ? error.message : String(error))
}

/** Mirror of the server's parseKeyScopes for display: null = unrestricted. */
function parseModels(scopes: string | null): string[] | null {
  if (scopes === null) return null
  const parts = scopes.split(/[\n,;]/).map((s) => s.trim()).filter((s) => s !== '')
  return parts.length > 0 ? parts : null
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
    const daily = Number(dailyLimit)
    const rpm = Number(rpmLimit)
    // Same guard as the row edit form: "1,000" must not become an unlimited
    // budget (0) with a success toast, and a negative/fractional limit must
    // not ride the old isFinite-only check into the server (which 400s on
    // non-integer/negative since code-review #4).
    if (!Number.isFinite(daily) || !Number.isFinite(rpm) || !Number.isInteger(daily) || !Number.isInteger(rpm) || daily < 0 || rpm < 0) {
      toast.error(t('keys.invalidLimit'))
      return
    }
    api
      .createKey({
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        dailyTokenLimit: daily,
        rpmLimit: rpm,
      })
      .then((created) => {
        setPlaintext(created.plaintext)
        onCreated()
      })
      .catch((error: unknown) => toast.error(error instanceof ApiError ? error.message : String(error)))
  }

  const close = (next: boolean): void => {
    onOpenChange(next)
    if (next === false) {
      setPlaintext(null)
      setSaved(false)
      setName('')
      setDailyLimit('0')
      setRpmLimit('0')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 focus-visible:outline-ring"
          /* code-review #1: the dismissal gate guards the plaintext-reveal
           * phase only. The form phase has nothing to lose yet used to carry
           * the gate too — with saved=false from the start, Esc/outside-click
           * were preventDefault'd and the create dialog was inescapable
           * except by submitting. RotateDialog keeps the unconditional gate:
           * its whole body IS the reveal step. */
          {...(plaintext !== null ? guardedDismissal(saved) : {})}
        >
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
            <PlaintextReveal plaintext={plaintext} saved={saved} onSavedChange={setSaved} onClose={() => close(false)} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Shared plaintext-reveal step (create-once + rotate): the value shows
 *  exactly once per issuance; the copy button survives non-secure contexts
 *  (copyText fallback) and the "I saved it" checkbox gates the explicit
 *  close. `saved` lives in the caller so its Dialog.Content can also block
 *  Esc / outside-click dismissal until it is checked (audit: Esc used to
 *  bypass the gate and discard the plaintext forever). */
function PlaintextReveal({
  plaintext,
  saved,
  onSavedChange,
  onClose,
}: {
  plaintext: string
  saved: boolean
  onSavedChange: (saved: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('keys.plaintextOnce')}</p>
      <code className="block overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs select-all">{plaintext}</code>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          void copyText(plaintext)
            .then(() => toast.success(t('common.copied')))
            .catch(() => toast.error(t('keys.copyFailed')))
        }}
      >
        {t('common.copy')}
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => onSavedChange(e.currentTarget.checked)} aria-label={t('keys.saved')} />
        {t('keys.saved')}
      </label>
      <Button disabled={!saved} onClick={onClose}>
        {t('common.close')}
      </Button>
    </div>
  )
}

/** Radix fires onEscapeKeyDown / onInteractOutside before closing; until the
 *  "I saved it" gate is checked we preventDefault so the one-shot plaintext
 *  cannot be dismissed by accident (audit: Esc discarded it permanently). */
function guardedDismissal(saved: boolean) {
  return {
    onEscapeKeyDown: (event: KeyboardEvent) => {
      if (!saved) event.preventDefault()
    },
    onInteractOutside: (event: Event) => {
      if (!saved) event.preventDefault()
    },
  }
}

/** Post-rotate reveal: the new plaintext, same once-only gates as create. */
function RotateDialog({ plaintext, onClose }: { plaintext: string; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  return (
    <Dialog.Root
      open
      onOpenChange={(next: boolean) => {
        if (next === false && saved) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 focus-visible:outline-ring"
          {...guardedDismissal(saved)}
        >
          <Dialog.Title className="text-sm font-semibold">{t('keys.rotate')}</Dialog.Title>
          <PlaintextReveal plaintext={plaintext} saved={saved} onSavedChange={setSaved} onClose={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}