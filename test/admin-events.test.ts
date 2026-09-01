// /admin/events SSE (M4): real-listen tests — app.inject() is unreliable for
// hijacked replies. Covers the guard, id-stamped frames, Last-Event-ID replay
// (snapshot XOR replay), ring eviction → snapshot fallback, concurrent
// clients, abort cleanup, pool.onChange → debounced `pool` event, and
// closeAll() terminating every stream (shutdown contract).
import { describe, it, expect, afterEach } from 'vitest'
import { AccountPoolManager } from '../src/host/pool.ts'
import { AdminEventBus } from '../src/server/events.ts'
import { makeAdminServer, login } from './helpers.admin.ts'

async function listen(built: ReturnType<typeof makeAdminServer>['built']): Promise<string> {
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = built.app.server?.address()
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no listen port')
  return `http://127.0.0.1:${addr.port}`
}

/** Parse an SSE text stream into frames: {event?, id?, data}. */
async function* sseFrames(res: Response, signal?: AbortSignal): AsyncGenerator<{ event: string; id: number; data: any }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        let event = 'message'
        let id: number | undefined
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('id: ')) id = Number(line.slice(4))
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
          else if (line === '' || line.startsWith(': ping')) continue
        }
        if (dataLines.length > 0) yield { event, id: id ?? -1, data: JSON.parse(dataLines.join('\n')) }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // reader already cancelled
    }
  }
}

async function collectFrames(res: Response, count: number): Promise<Array<{ event: string; id: number; data: any }>> {
  const frames: Array<{ event: string; id: number; data: any }> = []
  for await (const frame of sseFrames(res)) {
    frames.push(frame)
    if (frames.length >= count) {
      void res.body?.cancel().catch(() => undefined)
      break
    }
  }
  return frames
}

const runners = Array<{ built: any; stop: () => Promise<void> }>()

afterEach(async () => {
  while (runners.length > 0) {
    const r = runners.pop()!
    await r.stop()
  }
})

const sampleRun = (reqId: string) => ({
  ok: true,
  status: 'OK',
  durationMs: 42,
  model: 'gemini-3.7-flash',
  accountId: 'acc_1',
  keyId: null,
  protocol: 'openai' as const,
  reqId,
  usage: { promptTokens: 10, completionTokens: 5 },
})

describe('GET /admin/events', () => {
  it('requires a session (401 without cookie)', async () => {
    const { built } = makeAdminServer()
    const res = await built.app.inject({ method: 'GET', url: '/admin/events' })
    expect(res.statusCode).toBe(401)
  })

  it('initial frame is an id-stamped snapshot; live runs follow with increasing ids', async () => {
    const { built, events } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const res = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const got = collectFrames(res, 3)
    events.publishRun(sampleRun('r1'))
    events.publishRun(sampleRun('r2'))
    const frames = await got

    expect(frames[0]!.event).toBe('snapshot')
    expect(frames[0]!.id).toBeGreaterThan(0)
    expect(frames[1]!.event).toBe('run')
    expect(frames[1]!.data.run.reqId).toBe('r1')
    expect(frames[1]!.id).toBe(frames[0]!.id + 1)
    expect(frames[2]!.data.run.reqId).toBe('r2')
    expect(frames[2]!.id).toBe(frames[1]!.id + 1)
  })

  it('Last-Event-ID within the ring replays exactly the missed events (no snapshot)', async () => {
    const { built, events } = makeAdminServer()
    events.publishRun(sampleRun('r1'))
    events.publishRun(sampleRun('r2'))
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    // Pretend the client already holds everything through r1 (seq = newest - 1).
    const res = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie, 'last-event-id': String(events.currentSeq() - 1) } })
    const frames = await collectFrames(res, 1)
    expect(frames).toHaveLength(1)
    expect(frames.some((f) => f.event === 'snapshot')).toBe(false)
    expect(frames[0]!.event).toBe('run')
    expect(frames[0]!.data.run.reqId).toBe('r2')
  })

  it('out-of-range Last-Event-ID falls back to a snapshot only', async () => {
    const { built, events } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const res = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie, 'last-event-id': '999999' } })
    const frames = await collectFrames(res, 1)
    expect(frames[0]!.event).toBe('snapshot')
  })

  it('two concurrent clients both receive live events', async () => {
    const { built, events } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const resA = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    const resB = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    await collectFrames(resA, 1) // snapshot consumed
    await collectFrames(resB, 1)

    events.publishRun(sampleRun('r-live'))
    const [a, b] = await Promise.all([collectFrames(resA, 1), collectFrames(resB, 1)])
    expect(a[0]!.data.run.reqId).toBe('r-live')
    expect(b[0]!.data.run.reqId).toBe('r-live')
  })

  it('client abort unregisters the subscriber; later publishes do not throw', async () => {
    const { built, events } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const res = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    await collectFrames(res, 1)
    expect(events.subscriberCount).toBe(1)
    await res.body!.cancel()
    await new Promise((r) => setTimeout(r, 100)) // raw close → unregister
    expect(events.subscriberCount).toBe(0)
    expect(() => events.publishRun(sampleRun('after'))).not.toThrow()
  })

  it('pool.onChange feeds a debounced pool event through the SSE stream', async () => {
    const { built, pool } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const res = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    await collectFrames(res, 1) // snapshot

    pool.createAccountSlot('drill-slot')
    const frames: Array<{ event: string; id: number; data: any }> = []
    for await (const frame of sseFrames(res)) {
      frames.push(frame)
      if (frame.event === 'pool') break
    }
    const poolFrame = frames.find((f) => f.event === 'pool')
    expect(poolFrame).toBeDefined()
    expect(poolFrame!.data.pool.accounts.some((a: { alias: string }) => a.alias === 'drill-slot')).toBe(true)
  })

  it('closeAll() ends every stream and empties the subscriber set (shutdown contract)', async () => {
    const { built, events } = makeAdminServer()
    const cookie = (await login(built)).cookie
    const base = await listen(built)
    runners.push({ built, stop: () => built.app.close() })

    const resA = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    const resB = await fetch(`${base}/admin/events`, { signal: AbortSignal.timeout(8000), headers: { cookie } })
    await collectFrames(resA, 1)
    await collectFrames(resB, 1)
    expect(events.subscriberCount).toBe(2)

    const endedA = collectFrames(resA, 1) // will reject on body end → race below
    events.closeAll()
    await new Promise((r) => setTimeout(r, 100))
    expect(events.subscriberCount).toBe(0)
    // readers see the stream end (reader.read() resolves {done:true})
    const readerA = resA.body!.getReader()
    const blockA = await readerA.read()
    expect(blockA.done).toBe(true)
    await endedA.catch(() => undefined)
  })
})

describe('AdminEventBus unit: ring + replay edge cases', () => {
  it('ring eviction: ids past capacity stop replaying and fall back to snapshot', () => {
    const bus = new AdminEventBus({ getPool: () => AccountPoolManagerStub(), capacity: 3 })
    bus.publishRun(sampleRun('a'))
    bus.publishRun(sampleRun('b'))
    bus.publishRun(sampleRun('c'))
    expect(bus.canReplayFrom(bus.currentSeq() - 3)).toBe(false) // a evicted
    expect(bus.canReplayFrom(bus.currentSeq() - 2)).toBe(true)
    expect(bus.replayAfter(bus.currentSeq() - 2).map((e) => (e.type === 'run' ? e.run.reqId : ''))).toEqual(['b', 'c'])
    bus.publishRun(sampleRun('d')) // evicts 'b'
    expect(bus.canReplayFrom(bus.currentSeq() - 3)).toBe(false)
  })

  it('non-integer / negative / future ids never replay', () => {
    const bus = new AdminEventBus({ getPool: () => AccountPoolManagerStub() })
    bus.publishRun(sampleRun('a'))
    expect(bus.canReplayFrom(-1)).toBe(false)
    expect(bus.canReplayFrom(1.5)).toBe(false)
    expect(bus.canReplayFrom(bus.currentSeq() + 1)).toBe(false)
    expect(bus.canReplayFrom(bus.currentSeq())).toBe(true)
    expect(bus.replayAfter(bus.currentSeq())).toEqual([])
  })
})

describe('AdminEventBus unit: half-open client sweep', () => {
  it('force-recycles aged registrations exactly once; fresh ones survive', () => {
    const bus = new AdminEventBus({ getPool: () => AccountPoolManagerStub() })
    const ended: number[] = []
    bus.registerClient(() => {
      ended.push(1)
    })
    // A freshly registered client is inside the default TTL — untouched.
    expect(bus.sweepStaleClients(24 * 3_600_000)).toBe(0)
    expect(ended).toEqual([])
    // Past the TTL: end() runs exactly once even though the plain callback
    // (unlike the route's end()) never unregisters itself.
    expect(bus.sweepStaleClients(0)).toBe(1)
    expect(ended).toEqual([1])
    expect(bus.sweepStaleClients(0)).toBe(0)
    expect(ended).toEqual([1])
    bus.closeAll()
  })

  it('the sweep ends clients but never touches subscribers; end() owns both', () => {
    const bus = new AdminEventBus({ getPool: () => AccountPoolManagerStub() })
    const unsubscribe = bus.subscribe(() => {})
    bus.registerClient(() => {})
    bus.sweepStaleClients(0)
    // Subscribers are removed only through their route's end() or closeAll();
    // the sweeper must not silently drop a possibly-live subscriber.
    expect(bus.subscriberCount).toBe(1)
    unsubscribe()
    expect(bus.subscriberCount).toBe(0)
    bus.closeAll()
  })
})

// Pool data shape for bus unit tests — a tiny literal AccountPoolData stub.
function AccountPoolManagerStub(): any {
  return { version: 1, mode: 'sequential', defaultCooldownMs: 900_000, maxCooldownMs: 3_600_000, accounts: [] }
}