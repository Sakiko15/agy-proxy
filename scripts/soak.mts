// Soak harness (M5, acceptance.md §3 M5 DoD): three supervised phases against
// the fake-agy upstream — never any real Google endpoint (charter red line).
//
//   P1  mixed soak   — 3 account slots, three lanes (stream / non-stream /
//                      tool-continuation), FAKE_AGY_MODE_FILE failure windows
//                      (exit-error / real-fail / rate-limit, recovered via
//                      clear-cooldown + clear-auth), /healthz 15s probes,
//                      RSS + handle sampling off the gateway's
//                      `{"debug":"metrics"}` stdout lines.
//   P2  error matrix — one short boot per failure mode.
//   P3  kill drill   — taskkill /F restart cycles with ledger reconciliation.
//
// SOAK_MINUTES scales P1 (default 60). Exit 0 only when every judgment holds;
// the transcript is archived into docs/verify/m5.md.
import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const MINUTES = Math.max(1, Number(process.env.SOAK_MINUTES ?? 60))
const BASE_PORT = Number(process.env.SOAK_PORT ?? 18400)
const NODE = process.execPath
const FAKE = join(REPO, 'test', 'fake-agy.mjs')
const ROOT_KEY = 'sk-agy-soak-root-key'

interface ServerHandle {
  name: string
  port: number
  dataDir: string
  argsFile: string
  modeFile: string
  api: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, cookie?: string) => Promise<{ status: number; body: string }>
  stdoutText: () => string
  stop: (force?: boolean) => Promise<{ code: number | null; signal: string | null }>
}

interface MetricsSample {
  rss: number
  handles: number
}

const runners: Array<{ child: ChildProcess }> = []
const dirs: string[] = []
const log: Array<{ phase: string; check: string; ok: boolean; detail: string }> = []

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function judge(phase: string, check: string, ok: boolean, detail: string): void {
  log.push({ phase, check, ok, detail })
  console.log(`    [${ok ? 'PASS' : 'FAIL'}] ${check} — ${detail}`)
}

function sanitizePath(binDir: string): string {
  // resolveAgyBin prefers a real agy.exe on PATH — keep only what the fake
  // shim needs: System32 + the node dir (the .cmd shim runs `@node`).
  return process.platform === 'win32'
    ? `C:\\Windows\\System32;${join(NODE, '..')};${binDir}`
    : `/usr/bin:/bin:${join(NODE, '..')}:${binDir}`
}

function bootServer(name: string, opts: { port: number; dataDir: string; rateLimit?: number; timeoutMs?: number }): { child: ChildProcess; stdoutText: () => string; argsFile: string; modeFile: string } {
  const dir = mkdtempSync(join(tmpdir(), `agy-soak-${name}-`))
  dirs.push(dir)
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const modeFile = join(dir, 'fake-mode')
  const argsFile = join(dir, 'args.jsonl')
  writeFileSync(modeFile, 'ok\n')
  if (process.platform === 'win32') writeFileSync(join(binDir, 'agy.cmd'), `@node "${FAKE}" %*\r\n`)
  else writeFileSync(join(binDir, 'agy'), `#!/bin/sh\nexec "${NODE}" "${FAKE}" "$@"\n`, { mode: 0o755 })

  const child = spawn(NODE, [join(REPO, 'dist', 'index.js')], {
    env: {
      ...process.env,
      AGY_PROXY_DATA_DIR: opts.dataDir,
      AGY_PROXY_PORT: String(opts.port),
      AGY_PROXY_HOST: '127.0.0.1',
      AGY_PROXY_BIN: join(binDir, process.platform === 'win32' ? 'agy.cmd' : 'agy'),
      AGY_PROXY_MODE: 'plan',
      AGY_PROXY_WEB_DIST: 'none',
      AGY_PROXY_DEBUG_METRICS_MS: '500',
      AGY_PROXY_ADMIN_PASSWORD: ADMIN_PASSWORD,
      ...(opts.timeoutMs !== undefined ? { AGY_PROXY_TIMEOUT_MS: String(opts.timeoutMs) } : {}),
      ...(opts.rateLimit !== undefined ? { AGY_PROXY_RATE_LIMIT_PER_MINUTE: String(opts.rateLimit) } : {}),
      AGY_PROXY_API_KEY: ROOT_KEY,
      FAKE_AGY_MODE_FILE: modeFile,
      FAKE_AGY_ARGS_FILE: argsFile,
      PATH: sanitizePath(binDir),
      LOCALAPPDATA: join(dir, 'appdata'),
      APPDATA: join(dir, 'appdata'),
    },
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => chunks.push(c))
  child.stderr.on('data', (c: Buffer) => chunks.push(c))
  runners.push({ child })
  return { child, stdoutText: () => Buffer.concat(chunks).toString('utf8'), argsFile, modeFile }
}

const ADMIN_PASSWORD: string = process.env.SOAK_ADMIN_PASSWORD ?? 'soak-admin'

/** Boot + healthz wait; when slots > 0, seed them first via the pool manager
 *  (the pool file's only legitimate writer). */
async function startServer(name: string, opts: { port: number; slots?: number; dataDir?: string; rateLimit?: number; timeoutMs?: number } = {}): Promise<ServerHandle> {
  const dataDir = opts.dataDir ?? join(mkdtempSync(join(tmpdir(), `agy-soak-${name}-data-`)), 'data')
  mkdirSync(dataDir, { recursive: true })
  if ((opts.slots ?? 0) > 0) {
    const { AccountPoolManager } = await import('../src/host/pool.ts')
    process.env.AGY_PROXY_DATA_DIR = dataDir
    const pool = new AccountPoolManager()
    for (let i = 0; i < (opts.slots ?? 0); i++) pool.createAccountSlot(`${name}${i}`)
  }
  const { child, stdoutText, argsFile, modeFile } = bootServer(name, {
    port: opts.port,
    dataDir,
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  const t0 = Date.now()
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server ${name} exited early:\n${stdoutText().slice(-600)}`)
    if (Date.now() - t0 > 30_000) throw new Error(`server ${name} did not start:\n${stdoutText().slice(-600)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${String(opts.port)}/healthz`)
      if (res.ok) break
    } catch { /* not yet */ }
    await sleep(100)
  }

  const api = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: string }> => {
    const res = await fetch(`http://127.0.0.1:${String(opts.port)}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie !== undefined ? { cookie } : {}),
        'x-requested-with': 'soak',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, body: await res.text() }
  }

  return {
    name,
    port: opts.port,
    dataDir,
    argsFile,
    modeFile,
    api,
    stdoutText,
    stop: (force = false) =>
      new Promise((resolveStop) => {
        child.once('exit', (code, signal) => resolveStop({ code, signal }))
        if (force) {
          try { execSync(`taskkill /pid ${String(child.pid)} /T /F`, { stdio: 'ignore' }) } catch { /* gone */ }
        } else {
          child.kill()
        }
      }),
  }
}

async function login(h: ServerHandle): Promise<string> {
  const raw = await fetch(`http://127.0.0.1:${String(h.port)}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'soak' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  })
  if (!raw.ok) throw new Error(`admin login failed (${String(raw.status)})`)
  return raw.headers.get('set-cookie') ?? ''
}

function setMode(handle: ServerHandle, mode: string): void {
  writeFileSync(handle.modeFile, mode + '\n')
}

function spawnCount(argsFile: string): number {
  try { return readFileSync(argsFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length } catch { return 0 }
}

let seq = 0
function reqId(): string {
  seq++
  return `soak-${String(process.pid)}-${String(seq)}`
}

interface ChatResult {
  status: number
  body: string
  ms: number
  firstDeltaMs: number
}

async function chatStream(h: ServerHandle, stream: boolean, content: string, extraBody: Record<string, unknown> = {}): Promise<ChatResult> {
  const t0 = Date.now()
  const res = await fetch(`http://127.0.0.1:${String(h.port)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ROOT_KEY}` },
    body: JSON.stringify({ model: 'gemini-3-6-flash', stream, messages: [{ role: 'user', content }], ...extraBody }),
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
  return { status: res.status, body: text, ms: Date.now() - t0, firstDeltaMs: firstDelta }
}

function healthz(h: ServerHandle): Promise<boolean> {
  return fetch(`http://127.0.0.1:${String(h.port)}/healthz`).then((r) => r.ok).catch(() => false)
}

function percent(values: number[], p: number): number {
  if (values.length === 0) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? -1
}

function parseMetrics(stdout: string): MetricsSample[] {
  const out: MetricsSample[] = []
  for (const line of stdout.split('\n')) {
    if (!line.includes('"debug":"metrics"')) continue
    try {
      const m = JSON.parse(line) as { rss?: number; handles?: number }
      if (typeof m.rss === 'number' && typeof m.handles === 'number') out.push({ rss: m.rss, handles: m.handles })
    } catch { /* interleaved write — skip */ }
  }
  return out
}
// ---- P1: mixed load with failure windows ------------------------------------

interface LaneStats {
  total: number
  ok: number
  server5xxOutOfWindow: number
  firstDeltas: number[]
}

async function runPhase1(): Promise<void> {
  console.log('--- P1: mixed load + failure windows')
  const phaseStart = Date.now()
  const h = await startServer('p1', { port: BASE_PORT + 1, slots: 3 })

  // lane bookkeeping; the failure-window flag is read via a mutable closure.
  let inFailureWindow = false
  const stats: Record<'stream' | 'plain' | 'tool', { total: number; ok: number; server5xx: number; firstDeltas: number[] }> = {
    stream: { total: 0, ok: 0, server5xx: 0, firstDeltas: [] },
    plain: { total: 0, ok: 0, server5xx: 0, firstDeltas: [] },
    tool: { total: 0, ok: 0, server5xx: 0, firstDeltas: [] },
  }

  const deadline = Date.now() + MINUTES * 60_000
  const failures = ['exit-error', 'real-fail', 'rate-limit']
  const sliceMs = MINUTES * 60_000 >= 600_000 ? 120_000 : 12_000

  const driver = (async (kind: 'stream' | 'plain' | 'tool'): Promise<void> => {
    while (Date.now() < deadline) {
      let done = false
      if (kind === 'tool') {
        const first = await chatStream(h, false, `tool lane ${String(Date.now())}`)
        stats.tool.total++
        if (first.status === 200) {
          const parsed = JSON.parse(first.body) as { choices?: Array<{ message?: { tool_calls?: Array<{ id: string; function?: { name?: string } }> } }> }
          const call = parsed.choices?.[0]?.message?.tool_calls?.[0]
          if (call !== undefined && call.id !== '') {
            const cont = await fetch(`http://127.0.0.1:${String(h.port)}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${ROOT_KEY}` },
              body: JSON.stringify({
                model: 'gemini-3-6-flash',
                stream: false,
                messages: [
                  { role: 'user', content: 'tool lane' },
                  { role: 'tool', tool_call_id: call.id, content: 'mirrored output' },
                ],
              }),
            })
            await cont.text()
            stats.tool.total++
            if (cont.status === 200) stats.tool.ok++
            else if (cont.status >= 500 && !inFailureWindow) stats.tool.server5xx++
          }
        } else if (first.status >= 500 && !inFailureWindow) {
          stats.tool.server5xx++
        }
        done = true
      } else {
        const r = await chatStream(h, kind === 'stream', `${kind} lane ${String(Date.now())}`)
        stats[kind].total++
        if (r.status === 200) stats[kind].ok++
        else if (r.status >= 500 && !inFailureWindow) stats[kind].server5xx++
      }
      void done
      await sleep(80)
    }
  })

  const lanes = Promise.all([driver('stream'), driver('plain'), driver('tool')])

  // failure-window scheduler + recovery: ok → [failure → recover]… → ok
  const scheduler = (async (): Promise<void> => {
    let slice = 0
    while (Date.now() < deadline) {
      const windowMs = slice === 0 ? 30_000 : 15_000
      inFailureWindow = slice > 0
      const mode = slice === 0 ? 'ok' : failures[(slice - 1) % failures.length]!
      setMode(h, mode)
      const windowEnd = Math.min(Date.now() + windowMs, deadline)
      console.log(`    window: FAKE_AGY_MODE=${mode} for ${String(Math.round(windowMs / 1000))}s (out-of-window 5xx counts as failure)`)
      while (Date.now() < windowEnd) await sleep(1_000)
      slice++
      if (inFailureWindow) {
        const cookie = await login(h)
        setMode(h, 'ok')
        const poolRes = await h.api('GET', '/admin/pool', undefined, cookie)
        const accounts = (JSON.parse(poolRes.body) as { pool?: { accounts?: Array<{ id: string }> } }).pool?.accounts ?? []
        for (const acc of accounts) {
          await h.api('POST', '/admin/pool/accounts/' + acc.id + '/clear-cooldown', {}, cookie)
          await h.api('POST', '/admin/pool/accounts/' + acc.id + '/clear-auth', {}, cookie)
        }
        inFailureWindow = false
      }
    }
    setMode(h, 'ok')
  })()
  await Promise.all([lanes, scheduler.catch(() => undefined)])
  const wallSec = Math.round((Date.now() - phaseStart) / 1000)

  const samples = parseMetrics(h.stdoutText())
  console.log(`    lanes: stream=${String(stats.stream.total)} ok=${String(stats.stream.ok)} plain=${String(stats.plain.total)} ok=${String(stats.plain.ok)} tool=${String(stats.tool.total)} ok=${String(stats.tool.ok)}; spawns=${String(spawnCount(h.argsFile))}; wall=${String(wallSec)}s`)

  // judgments — RSS judges the STEADY-STATE slope (median of the middle third
  // vs median of the last third): boot-time warmup inflates early samples and
  // a real leak keeps growing through the second half; handles tolerate small
  // drift but fail on sustained growth.
  const rssValues = samples.map((m) => m.rss)
  const growth = steadySlope(rssValues)
  judge('P1', 'rss steady-state slope < 5%', growth < 0.05, `${String(Math.round(growth * 100))}% over the back half (${String(samples.length)} samples, window ${String(wallSec)}s)`)
  const late = samples.slice(Math.floor(samples.length * 0.75)).map((m) => m.handles)
  const early = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.25))).map((m) => m.handles)
  const lateMax = late.length > 0 ? Math.max(...late) : -1
  const earlyMin = early.length > 0 ? Math.min(...early) : -1
  judge('P1', 'handles do not climb', lateMax >= 0 && lateMax <= earlyMaxBound(earlyMin), `early min=${String(earlyMin)} late max=${String(lateMax)} (tolerance 5)`)
  const outWindow5xx = stats.stream.server5xx + stats.plain.server5xx + stats.tool.server5xx
  judge('P1', 'zero 5xx outside failure windows', outWindow5xx === 0, `out-of-window 5xx=${String(outWindow5xx)}`)
  judge('P1', 'stream lane made progress', stats.stream.total > 0, `${String(stats.stream.total)} requests`)
  const stopped = await h.stop()
  judge('P1', 'graceful shutdown', stopped.code === 0 || stopped.code === null, `exit code ${String(stopped.code)} signal ${String(stopped.signal)}`)
}

function steadySlope(values: number[]): number {
  const mid = values.slice(Math.floor(values.length / 3), Math.floor((values.length * 2) / 3))
  const end = values.slice(Math.floor(values.length * 0.9))
  if (mid.length === 0 || end.length === 0) return 0
  const base = mid.reduce((a, b) => a + b, 0) / mid.length
  const last = end.reduce((a, b) => a + b, 0) / end.length
  return base > 0 ? Math.max(0, (last - base) / base) : 0
}

function earlyMaxBound(min: number): number {
  return min + 5 // handles drift while pino/wal rotate; sustained growth fails
}

// ---- P2: error matrix --------------------------------------------------------

async function runPhase2(): Promise<void> {
  console.log('--- P2: error matrix (fresh short boot per mode)')
  const cases: Array<{
    name: string
    mode: string
    rateLimit?: number
    timeoutMs?: number
    expect: (r: ChatResult) => boolean
    detail: string
    post?: (h: ServerHandle, r: ChatResult) => Promise<void>
    /** When set: heal the mode file as soon as one spawn is recorded, so the
     *  retry window finds a healthy fake (the engine-retry rescue shape). */
    rescue?: boolean
  }> = [
    {
      name: 'exit-error (silent upstream 502)',
      mode: 'exit-error',
      expect: (r) => r.status === 502 && r.body.includes('PROCESS_EXIT') && r.body.includes('upstream request failed while generating'),
      detail: '502 PROCESS_EXIT with the envelope error verbatim (retry exhausted)',
    },
    {
      name: 'auth (401) + clear-auth recovery',
      mode: 'auth',
      expect: (r) => r.status === 401 && r.body.includes('AUTH'),
      detail: '401 AUTH; account quarantined until the clear-auth route',
      post: async (h) => {
        const cookie = await login(h)
        const poolRes = await h.api('GET', '/admin/pool', undefined, cookie)
        const acc = (JSON.parse(poolRes.body) as { pool?: { accounts?: Array<{ id: string }> } }).pool?.accounts?.[0]
        if (acc === undefined) { judge('P2', 'clear-auth recovery', false, 'no account in pool'); return }
        await h.api('POST', '/admin/pool/accounts/' + acc.id + '/clear-auth', {}, cookie)
        const after = await h.api('GET', '/admin/pool', undefined, cookie)
        const still = (JSON.parse(after.body) as { pool: { accounts: Array<{ authRequired?: boolean }> } }).pool.accounts[0]?.authRequired ?? false
        judge('P2', 'clear-auth recovery', still === false, 'account returned to the selectable pool after clear-auth')
      },
    },
    {
      name: 'validation (403 challenge URL passthrough)',
      mode: 'validation',
      expect: (r) => r.status === 403 && r.body.includes('https://accounts.google.com/'),
      detail: '403 with the validation_url verbatim',
    },
    {
      name: 'kill-early (engine retry rescue)',
      mode: 'kill-early',
      rescue: true,
      // the ok-mode span cuts on a tool step, so a non-stream client sees the
      // mirror tool_calls message — 200 without an error surface is the pin
      expect: (r) => r.status === 200 && !r.body.includes('"error"'),
      detail: 'silent SIGKILL on attempt 0, rescue window heals the mode file → 200 (two spawns)',
    },
    {
      name: 'kill-mid (no-replay guard)',
      mode: 'kill-mid',
      expect: (r) => r.status === 502 && r.body.includes('PROCESS_EXIT'),
      detail: 'partial output terminated the run after ONE spawn → 502',
    },
    {
      name: 'hang (watchdog TIMEOUT, one retry)',
      mode: 'hang',
      timeoutMs: 900,
      expect: (r) => r.status === 502 && r.body.includes('TIMEOUT'),
      detail: 'watchdog kills both attempts → 502 TIMEOUT',
    },
]
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    if (c === undefined) continue
    const h = await startServer('p2-' + String(i), { port: BASE_PORT + 10 + i, slots: 1, timeoutMs: c.timeoutMs })
    setMode(h, c.mode)
    if (c.rescue === true) {
      void (async (): Promise<void> => {
        const t0 = Date.now()
        while (spawnCount(h.argsFile) < 1 && Date.now() - t0 < 10_000) await sleep(40)
        setMode(h, 'ok')
      })()
    }
    const r = await chatStream(h, false, 'matrix leg ' + c.name)
    judge('P2', c.name, c.expect(r), c.detail + ` (got ${String(r.status)}; body ${r.body.slice(0, 80).replace(/\s+/g, ' ')})`)
    if (c.post !== undefined) await c.post(h, r)
    await h.stop()
  }
}

// ---- P3: kill drill (taskkill /F cycles + ledger reconciliation) --------------

async function runPhase3(): Promise<void> {
  console.log('--- P3: taskkill /F ×3 with ledger reconciliation (docker-kill equivalent)')
  const port = BASE_PORT + 40
  const dataDir = join(mkdtempSync(join(tmpdir(), 'agy-soak-p3-')), 'data')
  mkdirSync(dataDir, { recursive: true })
  // root key comes from env per boot; seed one slot through the manager
  const { AccountPoolManager } = await import('../src/host/pool.ts')
  process.env.AGY_PROXY_DATA_DIR = dataDir
  new AccountPoolManager().createAccountSlot('p3')
  await startServer('p3-warm', { port, dataDir }).then((h) => h.stop())

  let rows = 0
  for (let cycle = 1; cycle <= 3; cycle++) {
    const h = await startServer('p3-' + String(cycle), { port, dataDir })
    const r = await chatStream(h, false, 'kill drill cycle ' + String(cycle))
    judge('P3', 'request served (cycle ' + String(cycle) + ')', r.status === 200, `status ${String(r.status)}`)
    const cookie = await login(h)
    const landed = await (async (): Promise<number> => {
      const t0 = Date.now()
      for (;;) {
        const usage = await h.api('GET', '/admin/usage?limit=1', undefined, cookie)
        const total = (JSON.parse(usage.body) as { total?: number }).total ?? 0
        if (total >= rows + 1) return total
        if (Date.now() - t0 > 10_000) return -1
        await sleep(200)
      }
    })()
    judge('P3', 'rows land before force kill (cycle ' + String(cycle) + ')', landed === rows + 1, 'row count grows by exactly 1 → ' + String(landed) + ' (expected ' + String(rows + 1) + ')')
    const killed = await h.stop(true)
    judge('P3', 'taskkill /F ends the tree (cycle ' + String(cycle) + ')', killed.code === 1 || killed.code === null, 'code=' + String(killed.code) + ' signal=' + String(killed.signal) + ' (TerminateProcess on win32)')
    rows = rows + 1
    await sleep(300)
  }
  // final reboot + reconciliation
  const h = await startServer('p3-final', { port, dataDir, slots: 0 })
  const cookie = await login(h)
  const usage = await h.api('GET', '/admin/usage?limit=500', undefined, cookie)
  const total = (JSON.parse(usage.body) as { total?: number }).total ?? -1
  judge('P3', 'all 3 rows survive three force kills', total === 3, `usage total after reboots = ${String(total)}`)
  judge('P3', 'healthz green after final boot', await healthz(h), 'gateway healthy after crash recovery')
  await h.stop()
}

// ---- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`=== soak run: P1=${String(MINUTES)}min + P2 error matrix + P3 kill drill (fake-agy only) ===`)
  try {
    await runPhase1()
    await runPhase2()
    await runPhase3()
  } finally {
    for (const r of runners.splice(0)) {
      if (r.child.exitCode === null) r.child.kill()
    }
  }
  const failed = log.filter((r) => !r.ok)
  console.log(`=== soak summary: ${String(log.length - failed.length)} passed / ${String(failed.length)} failed ===`)
  if (failed.length > 0) process.exit(1)
}

main().catch((e: unknown) => {
  console.error('soak harness failed:', e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
