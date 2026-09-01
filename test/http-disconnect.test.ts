// HTTP-level client-disconnect drill (S-H2 regression): a streaming client
// that destroys its socket mid-turn must cascade the abort into the agy
// process tree. app.inject() has no socket to destroy, so this suite really
// listens and uses a raw net socket. fake-agy `hang` mode never prints and
// never exits — only the disconnect kill (NOT the idle watchdog, whose
// timeout is set far beyond the test deadline) can end it.
//
// Pre-fix, the close listener sat on request.raw — whose 'close' fires at
// body-parse completion in modern Node, before the handler even registers —
// and guarded on `reply.sent`, always true after hijack. Either trap made the
// abort a no-op, so the fake process survived the drill. The fix listens on
// reply.raw (ServerResponse 'close' = premature termination) with a
// writableEnded guard, and SseWriter.open() flushes the head so the drill can
// actually see the stream is live before disconnecting.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { defaultConfig, type GatewayConfig } from '../src/common/types.ts'
import { AgyEngine, type EngineDeps } from '../src/host/engine.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { buildServer } from '../src/server/app.ts'
import { buildLogger } from '../src/server/logger.ts'
import { GatewaySemaphore } from '../src/server/semaphore.ts'

const fakeBin = process.execPath
const fakeScript = join(import.meta.dirname, 'fake-agy.mjs')

const dirs: string[] = []

function makeServer(cfgOverrides: Partial<GatewayConfig> = {}, deps: Partial<EngineDeps> = {}) {
  const cfg: GatewayConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 120_000, ...cfgOverrides }
  const dir = mkdtempSync(join(tmpdir(), 'agy-disconnect-'))
  dirs.push(dir)
  process.env.AGY_PROXY_CONVERSATIONS_DIR = join(dir, 'convs')
  const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
  const sem = new GatewaySemaphore(() => cfg.maxConcurrent, () => cfg.maxQueueDepth)
  const engine = new AgyEngine({
    getConfig: () => cfg,
    catalog,
    store: new SessionStore(join(dir, 'sessions.json')),
    bin: () => fakeBin,
    binArgs: [fakeScript],
    acquire: () => sem.acquire(),
    runs: new RunRegistry(),
    retryDelay: async () => {},
    ...deps,
  })
  const built = buildServer({ getConfig: () => cfg, engine, catalog, log: buildLogger({ AGY_PROXY_LOG_LEVEL: 'warn' }) })
  return { built, dir, cfg }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* lingering handles */ }
  }
})

describe('S-H2 regression: streaming client disconnect kills the agy run', () => {
  it('destroying the client socket mid-SSE ends the fake-agy process', async () => {
    const { built, dir } = makeServer()
    process.env.FAKE_AGY_MODE = 'hang'
    const pidFile = join(dir, 'pids.json')
    process.env.FAKE_AGY_PID_FILE = pidFile

    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const address = built.app.server.address()
    if (address === null || typeof address === 'string') throw new Error('no listen address')
    const port = address.port

    const body = JSON.stringify({ model: 'gemini-3.7-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const socket = connect(port, '127.0.0.1')
    let headText = ''
    socket.on('data', (d: Buffer) => { headText += d.toString('utf8') })
    socket.on('error', () => undefined) // the destroy below races the reader
    socket.write(
      'POST /v1/chat/completions HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
    )

    // The SSE head must have reached the client — proves the request entered
    // the hijacked streaming leg whose close listener this drill exercises.
    const headDeadline = Date.now() + 10_000
    while (!headText.includes('\r\n\r\n') && Date.now() < headDeadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(headText.startsWith('HTTP/1.1 200')).toBe(true)
    if (!headText.startsWith('HTTP/1.1 200')) console.error('HEAD:', JSON.stringify(headText.slice(0, 400)))

    // The hang run is alive: wait for its pid, then confirm it stays up.
    let pid = 0
    const deadline = Date.now() + 10_000
    while (pid === 0 && Date.now() < deadline) {
      try {
        pid = Number(readFileSync(pidFile, 'utf8').trim().split('\n').at(-1))
      } catch { /* not written yet */ }
      if (pid) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)

    // Disconnect mid-turn.
    socket.destroy()
    const killDeadline = Date.now() + 8_000
    let dead = false
    while (Date.now() < killDeadline) {
      if (!alive(pid)) { dead = true; break }
      await new Promise((r) => setTimeout(r, 50))
    }
    // Pre-fix this stayed alive until the 120s watchdog (test deadline 8s).
    expect(dead).toBe(true)

    await built.app.close()
  }, 20_000)
})