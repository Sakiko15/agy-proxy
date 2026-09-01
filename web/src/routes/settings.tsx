// Settings page (charter §9 page 6, charter §10 red line): the 9 writable
// keys with effective/requested display, envLocked lock hints, and the
// permissionMode=skip double-confirmation (consequence dialog → typed
// confirmation → PUT). The app-wide warning banner reads the saved mode from
// /admin/status in the shell.
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import * as Dialog from '@radix-ui/react-dialog'
import { Lock } from 'lucide-react'
import { api, ApiError } from '../api/client.ts'
import { Button, Card, CardContent, Input, PageHeader } from '../components/ui.tsx'

interface Field {
  key: string
  i18n: string
  kind: 'string' | 'number' | 'bool' | 'mode'
  min?: number
}

export const SETTINGS_FIELDS: Field[] = [
  { key: 'defaultModel', i18n: 'defaultModel', kind: 'string' },
  { key: 'defaultEffort', i18n: 'defaultEffort', kind: 'string' },
  { key: 'timeoutMs', i18n: 'timeoutMs', kind: 'number', min: 1 },
  { key: 'maxConcurrent', i18n: 'maxConcurrent', kind: 'number', min: 1 },
  { key: 'maxQueueDepth', i18n: 'maxQueueDepth', kind: 'number', min: 0 },
  { key: 'quotaPollIntervalMs', i18n: 'quotaPollIntervalMs', kind: 'number', min: 60_000 },
  { key: 'autoFallbackModel', i18n: 'autoFallbackModel', kind: 'bool' },
  { key: 'enabled', i18n: 'enabled', kind: 'bool' },
  { key: 'permissionMode', i18n: 'permissionMode', kind: 'mode' },
]

const NUMBER_KEYS = new Set(SETTINGS_FIELDS.filter((f) => f.kind === 'number').map((f) => f.key))
const BOOL_KEYS = new Set(SETTINGS_FIELDS.filter((f) => f.kind === 'bool').map((f) => f.key))

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.settings() })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [skipDialog, setSkipDialog] = useState(false)
  const [skipTyped, setSkipTyped] = useState('')

  const effective = settings.data?.effective ?? {}
  const requested = settings.data?.requested ?? {}
  const envLocked = new Set(settings.data?.envLocked ?? [])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const patch: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(draft)) {
      if (NUMBER_KEYS.has(key)) {
        if (raw === '') continue
        patch[key] = Number(raw)
      } else if (BOOL_KEYS.has(key)) {
        patch[key] = raw === 'true'
      } else {
        patch[key] = raw
      }
    }
    if (patch.permissionMode === 'skip' && effective.permissionMode !== 'skip') {
      setSkipDialog(true) // the double confirm decides below
      return
    }
    void put(patch)
  }

  const put = (patch: Record<string, unknown>): void => {
    api
      .putSettings(patch)
      .then(() => {
        toast.success(t('settings.saved'))
        setDraft({})
        void queryClient.invalidateQueries({ queryKey: ['settings'] })
        void queryClient.invalidateQueries({ queryKey: ['status'] })
      })
      .catch((error: unknown) => {
        const message = error instanceof ApiError ? error.message : String(error)
        toast.error(`${t('settings.invalid', { error: message })}`)
      })
  }

  return (
    <div>
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
        {SETTINGS_FIELDS.map((field) => {
          const locked = envLocked.has(field.key)
          const req = requested[field.key]
          const value = draft[field.key] ?? (req !== undefined ? String(req) : '')
          const label = t(`settings.${field.i18n}`)
          return (
            <Card key={field.key}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {label}
                  {locked && <Lock className="size-3.5 text-amber-600" aria-label={t('settings.envLocked')} />}
                </div>
                {field.kind === 'mode' ? (
                  <select
                    value={value === '' ? 'plan' : value}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.currentTarget.value })}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    aria-label={label}
                  >
                    <option value="plan">{t('settings.permissionModePlan')}</option>
                    <option value="accept-edits">{t('settings.permissionModeAcceptEdits')}</option>
                    <option value="skip">{t('settings.permissionModeSkip')}</option>
                  </select>
                ) : field.kind === 'bool' ? (
                  <select
                    value={value === '' ? 'false' : value}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.currentTarget.value })}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    aria-label={label}
                  >
                    <option value="false">{t('common.no')}</option>
                    <option value="true">{t('common.yes')}</option>
                  </select>
                ) : (
                  <Input
                    type={field.kind === 'number' ? 'number' : 'text'}
                    min={field.min}
                    value={value}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.currentTarget.value })}
                    aria-label={label}
                  />
                )}
                <div className="text-xs text-muted-foreground">
                  {t('settings.effective')}: <span className="text-foreground">{fmt(effective[field.key])}</span>
                  {locked && <span className="ml-2 text-amber-600">🔒 {t('settings.envLocked')}</span>}
                  {req !== undefined && String(req) !== fmt(effective[field.key]) && (
                    <span className="ml-2">({t('settings.requested')}: {String(req)})</span>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
        <div className="md:col-span-2">
          <Button type="submit" disabled={Object.keys(draft).length === 0}>
            {t('common.save')}
          </Button>
        </div>
      </form>

      <SkipConfirmDialog
        open={skipDialog}
        typed={skipTyped}
        onTyped={setSkipTyped}
        onCancel={() => {
          setSkipDialog(false)
          setSkipTyped('')
          setDraft((previous) => {
            const next = { ...previous }
            delete next.permissionMode
            return next
          })
        }}
        onConfirm={() => {
          setSkipDialog(false)
          setSkipTyped('')
          void put({ permissionMode: 'skip' })
        }}
      />
    </div>
  )
}

function SkipConfirmDialog({
  open,
  typed,
  onTyped,
  onCancel,
  onConfirm,
}: {
  open: boolean
  typed: string
  onTyped: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-destructive/40 bg-card p-5">
          <Dialog.Title className="text-sm font-semibold text-destructive">{t('settings.skipConfirmTitle')}</Dialog.Title>
          <p className="mt-2 text-sm">{t('settings.skipConfirmBody')}</p>
          <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">{t('settings.skipWarning')}</p>
          <Input
            className="mt-3"
            placeholder={t('settings.skipConfirmType')}
            value={typed}
            onChange={(e) => onTyped(e.currentTarget.value)}
            aria-label={t('settings.skipConfirmType')}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={typed !== 'SKIP'} onClick={onConfirm}>
              {t('common.confirm')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function fmt(value: unknown): string {
  if (value === undefined || value === null) return '—'
  return String(value)
}