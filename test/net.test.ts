// agyFetch timeout wiring (audit M4): every outbound Google call must abort
// on a hung endpoint instead of riding undici's 300s headersTimeout, which
// let quota-poll cycles stack past their 15 min interval.
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { agyFetch, AGY_FETCH_TIMEOUT_MS } from '../src/host/net.ts'

const servers: Server[] = []
afterAll(() => {
  for (const s of servers.splice(0)) s.close()
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

describe('agyFetch timeout (audit M4)', () => {
  it('aborts a hung endpoint after the timeout budget', async () => {
    // Accepts the connection and never answers — without the abort signal
    // undici would hold the request open for its 300s default.
    const hanging = createServer(() => {
      /* deliberately never responds */
    })
    servers.push(hanging)
    const port = await listen(hanging)
    const started = Date.now()
    await expect(agyFetch(`http://127.0.0.1:${port}/hung`, {}, undefined, 150)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('a responsive endpoint is unaffected by the timeout budget', async () => {
    const fast = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    servers.push(fast)
    const port = await listen(fast)
    const res = await agyFetch(`http://127.0.0.1:${port}/ok`, {}, undefined, 1000)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('exposes the default budget constant (10s)', () => {
    expect(AGY_FETCH_TIMEOUT_MS).toBe(10_000)
  })
})