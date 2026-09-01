// Entry: theme init (pre-paint ran in index.html), i18n, router, query cache.
// Code-based TanStack Router tree (no codegen step). Protected pages call
// requireAuth in beforeLoad; /login renders bare (no sidebar shell).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRoute, createRoute, createRouter, redirect, RouterProvider } from '@tanstack/react-router'
import { Toaster } from 'sonner'
import './i18n/index.ts'
import { requireAuth } from './auth.ts'
import { AppShell } from './shell/AppShell.tsx'
import { LoginPage } from './routes/login.tsx'
import { DashboardPage } from './routes/dashboard.tsx'
import './app.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
})

const rootRoute = createRootRoute({})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app', // layout route: auth-guarded, renders the shell
  beforeLoad: async () => {
    await requireAuth()
  },
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
})

// Page stubs — replaced one per M4 commit (accounts/keys/usage/settings).
function pageStub(name: string) {
  return () => <div className="text-sm text-muted-foreground">{name} placeholder</div>
}

const accountsRoute = createRoute({ getParentRoute: () => appRoute, path: '/accounts', component: pageStub('accounts') })
const keysRoute = createRoute({ getParentRoute: () => appRoute, path: '/keys', component: pageStub('keys') })
const usageRoute = createRoute({ getParentRoute: () => appRoute, path: '/usage', component: pageStub('usage') })
const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings', component: pageStub('settings') })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async () => {
    // Already signed in → skip the form.
    try {
      await requireAuth()
      throw redirect({ to: '/' })
    } catch (error) {
      if ((error as { to?: string }).to === '/') throw error
      // 401: fall through and show the form
    }
  },
  component: LoginPage,
})

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([indexRoute, accountsRoute, keysRoute, usageRoute, settingsRoute]),
  loginRoute,
])
const router = createRouter({ routeTree, context: { queryClient } })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const root = document.getElementById('root')
if (root === null) throw new Error('#root missing from index.html')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" />
    </QueryClientProvider>
  </StrictMode>,
)