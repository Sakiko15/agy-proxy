// /admin/events SSE hook (M4): one EventSource per app instance. The browser
// reconnects automatically and re-sends Last-Event-ID — that replay path is
// the server's contract (snapshot XOR replay), never duplicated here. Events:
// snapshot (initial pool), run (live feed, newest-first, capped buffer), pool
// (debounced full snapshots from the mutation hook).
import { useEffect, useState } from 'react'
import type { AccountPoolData, AdminEvent, RunEventPayload } from '../api/types.ts'

export interface AdminEventsState {
  /** 'connecting' until the first event; 'online' after; 'offline' on error. */
  status: 'connecting' | 'online' | 'offline'
  /** Newest-first — the dashboard feed and recent-error stream. */
  runs: RunEventPayload[]
  pool: AccountPoolData | null
  /** Last received event seq (from the SSE id line). */
  lastEventId: number
}

const RUNS_BUFFER = 100

export function useAdminEvents(): AdminEventsState {
  const [state, setState] = useState<AdminEventsState>({ status: 'connecting', runs: [], pool: null, lastEventId: 0 })

  useEffect(() => {
    const source = new EventSource('/admin/events')

    const parse = (ev: Event): AdminEvent | null => {
      const data = (ev as MessageEvent<string>).data
      try {
        return data !== undefined && data !== '' ? (JSON.parse(data) as AdminEvent) : null
      } catch {
        return null
      }
    }
    const seqOf = (ev: Event): number => {
      const raw = (ev as MessageEvent<string>).lastEventId
      const id = Number(raw)
      return Number.isFinite(id) ? id : NaN
    }
    const apply = (patch: Partial<AdminEventsState>): void => {
      setState((previous) => ({ ...previous, ...patch }))
    }

    const handler = (event: Event): void => {
      const seq = seqOf(event)
      const data = parse(event)
      const seqPatch = Number.isFinite(seq) ? { lastEventId: seq } : {}
      if (data === null) return
      switch (data.type) {
        case 'snapshot':
          apply({ status: 'online', ...(data.pool !== undefined ? { pool: data.pool } : {}), ...seqPatch })
          break
        case 'pool':
          setState((previous) => ({ ...previous, status: 'online', ...(data.pool !== undefined ? { pool: data.pool as AccountPoolData } : {}), ...seqPatch }))
          break
        case 'run':
          setState((previous) => ({
            ...previous,
            status: 'online',
            runs: [data.run as RunEventPayload, ...previous.runs].slice(0, RUNS_BUFFER),
            ...seqPatch,
          }))
          break
      }
    }
    for (const name of ['snapshot', 'run', 'pool']) source.addEventListener(name, handler)

    source.onopen = () => apply({ status: 'online' })
    source.onerror = () => {
      setState((previous) => (previous.status === 'online' ? { ...previous, status: 'offline' } : previous))
    }

    return () => {
      source.close()
    }
  }, [])

  return state
}