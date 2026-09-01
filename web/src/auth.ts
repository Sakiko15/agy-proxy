// Auth guard: protected routes call requireAuth in beforeLoad; an expired
// session redirects to /login. TanStack Router's thrown-redirect protocol.
import { redirect } from '@tanstack/react-router'
import { api, ApiError } from './api/client.ts'

export async function requireAuth(): Promise<void> {
  try {
    await api.me()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: '/login' })
    }
    throw error
  }
}