// App shell (charter §9 layout): sidebar nav + header (theme/language/live
// status), the app-wide skip-permissions banner (data rides /admin/status.
// gateway.permissionMode), and the page outlet.
import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  CreditCard,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  MonitorSmartphone,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'
import { api } from '../api/client.ts'
import { useAdminEvents } from '../sse/useAdminEvents.ts'
import { currentLanguage, setLanguage } from '../i18n/index.ts'
import { setTheme, useThemeState, type ThemeMode } from '../theme.ts'
import { Badge, Button } from '../components/ui.tsx'

const NEXT_THEME: Record<ThemeMode, ThemeMode> = { light: 'dark', dark: 'system', system: 'light' }

const NAV = [
  { to: '/', icon: LayoutDashboard, key: 'nav.dashboard' },
  { to: '/accounts', icon: CreditCard, key: 'nav.accounts' },
  { to: '/keys', icon: KeyRound, key: 'nav.keys' },
  { to: '/usage', icon: List, key: 'nav.usage' },
  { to: '/settings', icon: Settings, key: 'nav.settings' },
] as const

export function AppShell(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const theme = useThemeState()
  const events = useAdminEvents()
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: () => api.status() })
  const skipMode = statusQuery.data?.gateway.permissionMode === 'skip'

  const logout = (): void => {
    api
      .logout()
      .then(() => {
        void navigate({ to: '/login' })
      })
      .catch((error: unknown) => {
        toast.error(String(error instanceof Error ? error.message : error))
      })
  }

  return (
    <div className="flex min-h-dvh flex-col">
      {skipMode && (
        <Link
          to="/settings"
          className="bg-amber-500/20 px-3 py-2 text-center text-xs font-medium text-amber-800 underline-offset-4 hover:underline dark:text-amber-300"
        >
          {t('settings.skipBanner')}
        </Link>
      )}
      <div className="mx-auto flex w-full max-w-7xl flex-1">
        <aside className="hidden w-52 shrink-0 flex-col border-r border-border p-3 md:flex">
          <div className="px-2 py-2 text-sm font-semibold">{t('common.appName')}</div>
          <nav className="mt-2 flex-1" aria-label={t('common.appName')}>
            <ul className="flex flex-col gap-1">
              {NAV.map((item) => (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    activeProps={{ className: 'bg-accent text-accent-foreground font-medium' }}
                  >
                    <item.icon className="size-4" aria-hidden />
                    {t(item.key)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-4 flex flex-col items-start gap-2 border-t border-border pt-3">
            <Badge variant={events.status === 'online' ? 'success' : events.status === 'offline' ? 'warning' : 'muted'}>
              {events.status === 'online' ? t('nav.connected') : t('nav.reconnecting')}
            </Badge>
            <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
              <LogOut className="size-4" aria-hidden />
              {t('nav.logout')}
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 items-center justify-between gap-2 border-b border-border px-3">
            <span className="text-sm font-semibold md:hidden">{t('common.appName')}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('nav.theme')}
                title={t('nav.theme')}
                onClick={() => setTheme(NEXT_THEME[theme])}
              >
                {theme === 'dark' ? (
                  <Moon className="size-4" aria-hidden />
                ) : theme === 'system' ? (
                  <MonitorSmartphone className="size-4" aria-hidden />
                ) : (
                  <Sun className="size-4" aria-hidden />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLanguage(currentLanguage() === 'zh-CN' ? 'en' : 'zh-CN')
                }}
              >
                {i18n.language === 'en' ? 'EN' : '中'}
              </Button>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label={t('nav.logout')} onClick={logout}>
                <LogOut className="size-4" aria-hidden />
              </Button>
            </div>
          </header>
          <main className="min-w-0 flex-1 p-3 sm:p-4">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}