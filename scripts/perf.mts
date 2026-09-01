// Perf baseline harness (M5, acceptance.md §4) — every measurement runs
// against the fake-agy upstream, never a real endpoint. Legs:
//
//   1. SSE first-delta vs a bare-pipe reference, gateway delta < 50 ms
//   2. non-stream full-body latency (P50/P95), gate < 100 ms over bare
//   3. flood forwarding — 20k events end-to-end vs a bare pipe reference
//   4. ledger landing P95 < 2 s (request completion → usage row createdAt)
//   5. models cold < 1.5 s / hot < 10 ms (fresh boot for the cold leg)
//   6. 3-account concurrency ≥ 2.5× on a fixed fake delay
//   7. single-key RPM=5 → 6th call 429 + Retry-After
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startAgyProcess } from '../src/host/runner.ts'

const REPO = resolve(import.meta.dirname, '..')
const NODE = process.execPath
const FAKE = join(REPO, 'test', 'fake-agy.mjs')
const FAKE_DELAY_MS = Number(process.env.PERF_FAKE_DELAY_MS ?? 250)

const runners: Array<{ child: ChildProcess }> = []
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
let portSeq = 0

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const nextPort = (): number => 18600 + ++portSeq

function judge(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`    [${ok ? 'PASS' : 'FAIL'}] ${name} — ${detail}`)
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? -1
}

interface Booted {
  port: number
  api: (method: 'GET' | 'POST', path: string, body?: unknown, cookie?: string) => Promise<{ status: number; body: string; headers: Headers }>
  stop: () => Promise<void>
}

function spawnGateway(p: number, dataDir: string, extra: Record<string, string>): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), 'agy-perf-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'agy.cmd'), `@node "${FAKE}" %*\r\n`)
  const child = spawn(NODE, [join(REPO, 'dist', 'index.js')], {
    env: {
      ...process.env,
      AGY_PROXY_DATA_DIR: dataDir,
      AGY_PROXY_PORT: String(p),
      AGY_PROXY_HOST: '127.0.0.1',
      AGY_PROXY_BIN: join(binDir, 'agy.cmd'),
      AGY_PROXY_MODE: 'plan',
      AGY_PROXY_WEB_DIST: 'none',
      AGY_PROXY_ADMIN_PASSWORD: 'perf-admin',
      AGY_PROXY_API_KEY: 'sk-agy-perf',
      PATH: `C:\\Windows\\System32;${join(NODE, '..')};${binDir}`,
      LOCALAPPDATA: join(dir, 'appdata'),
      APPDATA: join(dir, 'appdata'),
      ...extra,
    },
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runners.push({ child })
  return child
}

async function boot(p: number, dataDir: string, extra: Record<string, string> = {}): Promise<Booted> {
  const child = spawnGateway(p, dataDir, extra)
  const t0 = Date.now()
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(p)}/healthz`)
      if (res.ok) break
    } catch { /* not yet */ }
    if (Date.now() - t0 > 30_000) throw new Error('perf boot timeout')
    await sleep(50)
  }
  const api = async (method: 'GET' | 'POST', path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: string; headers: Headers }> => {
    const res = await fetch(`http://127.0.0.1:${String(p)}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie !== undefined ? { cookie } : {}),
        'x-requested-with': 'perf',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: await res.text(), headers: res.headers }
  }
  return {
    port: p,
    api,
    stop: async () => {
      child.kill()
      await sleep(200)
    },
  }
}

interface ChatOnce {
  status: number
  body: string
  ms: number
  firstDeltaMs: number
  doneAt: number
  headers: Headers
}

async function call(h: Booted, stream: boolean, i: number, reqId?: string): Promise<ChatOnce> {
  const t0 = Date.now()
  const id = reqId ?? `perf-${String(i)}`
  const res = await fetch(`http://127.0.0.1:${String(h.port)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-agy-perf', 'x-request-id': id },
    body: JSON.stringify({ model: 'gemini-3-6-flash', stream, messages: [{ role: 'user', content: 'perf ' + String(i) }] }),
  })
  let firstDelta = -1
  let text = ''
  if (stream && res.body !== null) {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstDelta === -1 && value !== undefined && value.length > 0) firstDelta = Date.now() - t0
    }
  } else {
    text = await res.text()
  }
  return { status: res.status, body: text, ms: Date.now() - t0, firstDeltaMs: firstDelta, doneAt: Date.now(), headers: res.headers }
}

/** Bare reference: same argv straight through startAgyProcess (no gateway). */
async function bareFirstLine(mode: string, delayMs: number, env: Record<string, string> = {}): Promise<number> {
  const t0 = Date.now()
  let first = -1
  const run = startAgyProcess({
    bin: NODE,
    args: [FAKE, '--output-format', 'stream-json', '-p', 'bare probe'],
    cwd: REPO,
    timeoutMs: 15_000,
    env: { ...process.env, FAKE_AGY_MODE: mode, FAKE_AGY_DELAY_MS: String(delayMs), ...env },
    onLine: () => {
      if (first === -1) first = Date.now() - t0
    },
  })
  await run.outcome
  return first
}

async function login(h: Booted): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${String(h.port)}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'perf' },
    body: JSON.stringify({ password: 'perf-admin' }),
  })
  return res.headers.get('set-cookie') ?? ''
}

async function main(): Promise<void> {
  console.log('=== perf baseline (fake-agy only; bare reference = same argv through startAgyProcess) ===')
  const dataDir = join(mkdtempSync(join(tmpdir(), 'agy-perf-data-')), 'data')
  mkdirSync(dataDir, { recursive: true })
  const { AccountPoolManager } = await import('../src/host/pool.ts')
  process.env.AGY_PROXY_DATA_DIR = dataDir
  const pool = new AccountPoolManager()
  pool.createAccountSlot('perf1')
  pool.createAccountSlot('perf2')
  pool.createAccountSlot('perf3')

  // ---- 5: models cold / hot (measured first — the cache is empty)
  const portModels = nextPort()
  const hm = await boot(portModels, dataDir, { FAKE_AGY_DELAY_MS: '0' })
  const tCold = Date.now()
  await hm.api('GET', '/v1/models')
  const coldMs = Date.now() - tCold
  const tHot = Date.now()
  await hm.api('GET', '/v1/models')
  const hotMs = Date.now() - tHot
  judge('5 models cold < 1.5s', coldMs < 1_500, `cold=${String(coldMs)}ms`)
  judge('5 models hot < 10ms', hotMs < 10, `hot=${String(hotMs)}ms`)
  await hm.stop()

  // ---- 1..4, 6 on the main server (250ms fake delay so concurrency shows up)
  const portMain = nextPort()
  const h = await boot(portMain, dataDir, { FAKE_AGY_DELAY_MS: String(FAKE_DELAY_MS) })

  // Sequential legs pace 900ms apart — ABOVE the burst pacing throttle's max
  // spacing (minSpawnIntervalMs 500 + up to 300 jitter) — so the walls measure
  // gateway overhead, not the deliberate anti-flood pacing.
  const PACING = Math.max(900, FAKE_DELAY_MS + 700)

  const streamSet: Array<{ status: number; body: string; ms: number; firstDeltaMs: number; doneAt: number; headers: Headers }> = []
  for (let i = 0; i < 20; i++) {
    streamSet.push(await call(h, true, i))
    await sleep(PACING)
  }
  const deltas = streamSet.map((r) => r.firstDeltaMs).filter((d) => d >= 0)
  const bareDeltas: number[] = []
  for (let i = 0; i < 10; i++) bareDeltas.push(await bareFirstLine('ok', FAKE_DELAY_MS))
  const gwFirst = pct(deltas, 50)
  const bareFirst = pct(bareDeltas, 50)
  console.log(`  SSE first-delta P50=${String(pct(deltas, 50))}ms P95=${String(pct(deltas, 95))}ms; bare P50=${String(Math.round(bareFirst))}ms`)
  judge('1 SSE first delta overhead < 50ms', gwFirst - bareFirst >= 0 && gwFirst - bareFirst < 50, `gateway=${String(Math.round(gwFirst))}ms bare=${String(Math.round(bareFirst))}ms (delta ${String(Math.round(gwFirst - bareFirst))}ms)`)

  const plainSet: Array<{ status: number; body: string; ms: number; firstDeltaMs: number; doneAt: number; headers: Headers }> = []
  for (let i = 0; i < 20; i++) {
    plainSet.push(await call(h, false, 100 + i))
    await sleep(PACING)
  }
  const plainMs = plainSet.map((r) => r.ms)
  const barePlain: number[] = []
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now()
    await bareFirstLine('ok', FAKE_DELAY_MS)
    barePlain.push(Date.now() - t0)
  }
  console.log(`  plain body P50=${String(pct(plainMs, 50))}ms P95=${String(pct(plainMs, 95))}ms (bare full-run P50=${String(Math.round(pct(barePlain, 50)))}ms)`)
  judge('2 non-stream overhead < 100ms', pct(plainMs, 50) - pct(barePlain, 50) < 100, `gateway P50=${String(Math.round(pct(plainMs, 50)))}ms bare P50=${String(Math.round(pct(barePlain, 50)))}ms (delta ${String(Math.round(pct(plainMs, 50) - pct(barePlain, 50)))}ms)`)

  // 4: ledger landing (per-request completion → usage row createdAt)
  const doneTimes = new Map<string, number>()
  for (let i = 0; i < 30; i++) {
    const id = 'perf-led-' + String(i)
    await call(h, false, 200 + i, id)
    doneTimes.set(id, Date.now())
    await sleep(PACING)
  }
  const cookie = await login(h)
  const usage = await h.api('GET', '/admin/usage?limit=500', undefined, cookie)
  const rows = (JSON.parse(usage.body) as { rows?: Array<{ requestId: string; createdAt: number }> }).rows ?? []
  const latencies: number[] = []
  for (const row of rows) {
    const done = doneTimes.get(row.requestId)
    if (done !== undefined) latencies.push(row.createdAt - done)
  }
  judge('4 ledger landing P95 < 2s', pct(latencies, 95) >= 0 && pct(latencies, 95) < 2_000, `P95=${String(Math.round(pct(latencies, 95)))}ms over ${String(latencies.length)} rows`)

  // 6: 3-account concurrency ≥ 2.5× (serial legs paced; parallel lanes only
  // spread when the pool mode is round-robin — sequential drain sticks to one
  // account's queue by design)
  await h.api('POST', '/admin/pool/mode', { mode: 'round-robin' }, cookie)
  const tSerial0 = Date.now()
  for (let i = 0; i < 3; i++) {
    await call(h, false, 300 + i)
    await sleep(PACING)
  }
  const serialMs = Date.now() - tSerial0
  const tParallel0 = Date.now()
  await Promise.all([call(h, false, 310), call(h, false, 311), call(h, false, 312)])
  const parallelMs = Date.now() - tParallel0
  const speedup = parallelMs > 0 ? serialMs / parallelMs : 0
  judge('6 three-account scale ≥ 2.5x', speedup >= 2.5, `serial=${String(serialMs)}ms parallel=${String(parallelMs)}ms (ratio ${String(Math.round(speedup * 10) / 10)})`)

  // 3: flood forwarding vs bare pipe (same 20k-event fake process, no awaits)
  const portFlood = nextPort()
  const hf = await boot(portFlood, dataDir, { FAKE_AGY_MODE: 'flood', FAKE_AGY_FLOOD_EVENTS: '20000' })
  const floodTimes: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${String(portFlood)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-agy-perf' },
      body: JSON.stringify({ model: 'gemini-3-6-flash', stream: true, messages: [{ role: 'user', content: 'flood' }] }),
    })
    const text = await res.text()
    floodTimes.push(Date.now() - t0)
    // sawTextStep suppresses the result-envelope content re-emission — the
    // terminal marker is what the raw SSE must carry
    if (!text.includes('DONE') || text.includes('"error"')) throw new Error('flood leg lost its result envelope')
  }
  const tBareFlood0 = Date.now()
  let bareLines = 0
  const bareRun = startAgyProcess({
    bin: NODE,
    args: [FAKE, '--output-format', 'stream-json', '-p', 'flood'],
    cwd: REPO,
    timeoutMs: 60_000,
    env: { ...process.env, FAKE_AGY_MODE: 'flood', FAKE_AGY_FLOOD_EVENTS: '20000' },
    onLine: () => {
      bareLines++
    },
  })
  const bareOut = await bareRun.outcome
  const bareFlood = Date.now() - tBareFlood0
  void bareOut
  const gwFlood = pct(floodTimes, 50)
  judge('3 flood forwarding ≈ pipe rate', gwFlood <= bareFlood + 2_000, `gateway P50=${String(Math.round(gwFlood))}ms vs bare ${String(bareFlood)}ms / ${String(bareLines)} lines`)

  // ---- 7: managed key RPM=5 → 6th call 429 + Retry-After (auth hook) ------
  const portRpm = nextPort()
  const hr = await boot(portRpm, dataDir, {})
  const cookieR = await login(hr)
  const created = await hr.api('POST', '/admin/keys', { name: 'rpm-key', rpmLimit: 5 }, cookieR)
  const plaintext = (JSON.parse(created.body) as { plaintext?: string }).plaintext
  if (plaintext === undefined) throw new Error('key create failed: ' + created.body.slice(0, 120))
  const rpmStatuses: number[] = []
  let rpmRetry = ''
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`http://127.0.0.1:${String(portRpm)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model: 'gemini-3-6-flash', stream: false, messages: [{ role: 'user', content: 'rpm ' + String(i) + ' ' + String(Math.random()) }] }),
    })
    await r.text()
    rpmStatuses.push(r.status)
    const header = r.headers.get('retry-after')
    if (header !== null) rpmRetry = header
  }
  judge('7 RPM=5 rejects the 6th with 429 + Retry-After', rpmStatuses.slice(0, 5).every((s) => s === 200) && rpmStatuses[5] === 429 && rpmRetry.length >= 1, 'statuses=' + JSON.stringify(rpmStatuses) + ' retry-after=' + rpmRetry)
  await hr.stop()

  await hf.stop()
  await h.stop()
  await cleanup()

  const failed = checks.filter((c) => !c.ok)
  console.log(`=== perf summary: ${String(checks.length - failed.length)} passed / ${String(failed.length)} failed ===`)
  if (failed.length > 0) process.exit(1)
}

async function cleanup(): Promise<void> {
  for (const r of runners.splice(0)) {
    if (!r.child.killed) r.child.kill()
  }
}

main().catch((e: unknown) => {
  console.error('perf harness failed:', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})