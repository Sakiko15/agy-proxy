// Admin API client: same-origin fetch with the session cookie; every
// mutating call carries the x-requested-with CSRF header (the server 403s
// without it — a missing header here is a hard failure class, hence tested).
import type {
  AccountPoolData,
  AdminStatus,
  ApiKeyWithToday,
  ApiKeyRecord,
  PoolAuthStatus,
  SettingsView,
  UsageRow,
  UsageSummary,
  ManagedAccount,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Query-string builder for the /admin/usage filters: skips empty values,
 *  keeps insertion order, never URL-escapes blindly (values are encoded). */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text()
  let body: unknown = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    throw new ApiError(res.status, text === '' ? `HTTP ${res.status}` : text.slice(0, 200))
  }
  const bodyOk = body !== null && typeof body === 'object' && 'ok' in body && (body as { ok?: unknown }).ok === true
  if (!res.ok && !bodyOk) {
    const message =
      body !== null && typeof body === 'object' && 'error' in (body as object) && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

export async function apiGet<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { credentials: 'include' }))
}

export type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function apiSend<T>(method: Method, url: string, body?: unknown): Promise<T> {
  return parse<T>(
    await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        'x-requested-with': 'agy-proxy-webui',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

// ---- typed admin API surface (mirrors src/server/admin-api.ts) ----

export interface LoginPage {
  ok: boolean
  expiresAt?: number
}

export const api = {
  login: (password: string) => apiSend<LoginPage>('POST', '/admin/login', { password }),
  logout: () => apiSend<{ ok: boolean }>('POST', '/admin/logout'),
  me: () => apiGet<{ ok: boolean }>('/admin/me'),
  status: () => apiGet<{ ok: boolean } & AdminStatus>('/admin/status'),
  pool: () => apiGet<{ ok: boolean; pool: AccountPoolData }>('/admin/pool'),
  authBegin: (alias?: string) => apiSend<PoolAuthStatus>('POST', '/admin/pool/auth/begin', alias !== undefined ? { alias } : {}),
  authStatus: () => apiGet<PoolAuthStatus>('/admin/pool/auth/status'),
  authComplete: (code: string) => apiSend<PoolAuthStatus & { pool?: AccountPoolData }>('POST', '/admin/pool/auth/complete', { code }),
  authCancel: () => apiSend<PoolAuthStatus>('POST', '/admin/pool/auth/cancel', {}),
  patchAccount: (id: string, patch: { alias?: string; enabled?: boolean; proxyUrl?: string | null }) =>
    apiSend<{ ok: boolean; account: ManagedAccount }>('PATCH', `/admin/pool/accounts/${encodeURIComponent(id)}`, patch),
  deleteAccount: (id: string) => apiSend<{ ok: boolean }>('DELETE', `/admin/pool/accounts/${encodeURIComponent(id)}`),
  clearCooldown: (id: string, family?: string) =>
    apiSend<{ ok: boolean }>('POST', `/admin/pool/accounts/${encodeURIComponent(id)}/clear-cooldown`, family !== undefined ? { family } : {}),
  refreshAccountQuota: (id: string) => apiSend<{ ok: boolean }>('POST', `/admin/pool/accounts/${encodeURIComponent(id)}/refresh-quota`, {}),
  refreshQuota: () => apiSend<{ ok: boolean }>('POST', '/admin/pool/quota/refresh', {}),
  poolMode: (mode: 'sequential' | 'round-robin') => apiSend<{ ok: boolean }>('POST', '/admin/pool/mode', { mode }),
  keys: () => apiGet<{ ok: boolean; keys: ApiKeyWithToday[] }>('/admin/keys'),
  createKey: (body: { name?: string; dailyTokenLimit?: number; rpmLimit?: number }) =>
    apiSend<{ ok: boolean; key: ApiKeyRecord; plaintext: string }>('POST', '/admin/keys', body),
  patchKey: (id: string, patch: { name?: string; disabled?: boolean; dailyTokenLimit?: number; rpmLimit?: number; scopes?: string | null }) =>
    apiSend<{ ok: boolean; key: ApiKeyRecord }>('PATCH', `/admin/keys/${encodeURIComponent(id)}`, patch),
  deleteKey: (id: string) => apiSend<{ ok: boolean }>('DELETE', `/admin/keys/${encodeURIComponent(id)}`),
  usage: (query: string) => apiGet<{ ok: boolean; total: number; rows: UsageRow[] }>(`/admin/usage${query}`),
  usageSummary: () => apiGet<{ ok: boolean; today: UsageSummary }>('/admin/usage/summary'),
  settings: () => apiGet<{ ok: boolean } & SettingsView>('/admin/settings'),
  putSettings: (patch: Record<string, unknown>) => apiSend<{ ok: boolean } & SettingsView>('PUT', '/admin/settings', patch),
}