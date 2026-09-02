// Process runner: every request spawns a short-lived `agy -p` process as its
// own process group; abort and watchdog kill the whole tree (agy re-spawns
// exec children). stderr is captured as a tail for error attribution; stdout
// is streamed line-by-line to the caller.
// Ported from dsh-agy-link src/host/runner.ts @ 46984db (verbatim except:
// resolveAgyBin signature takes the bin-hint string instead of PluginConfig;
// probeProcess returns {ok,version,error} for the startup report).
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

const IS_WIN = process.platform === 'win32'

/** Executable candidates for one PATH entry, per-platform. Exported for tests. */
export function binCandidates(dir: string, platform: string = process.platform): string[] {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  return exts.map((e) => join(dir, 'agy' + e))
}

/** True when the resolved bin is a Windows cmd shim (never spawnable here). */
export function isCmdShim(bin: string): boolean {
  return /\.(cmd|bat)$/i.test(bin)
}

/**
 * Environment that relocates the agy home directory for account isolation.
 * On Unix, HOME suffices. On Windows, libuv (Node) and Go both resolve the
 * home directory from USERPROFILE / HOMEDRIVE+HOMEPATH and IGNORE $HOME, so
 * omitting them silently breaks account isolation (every account would share
 * the real user profile). GEMINI_CLI_HOME is honored by the agy CLI on all
 * platforms for its .gemini dir.
 */
export function isolatedHomeEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dir,
    GEMINI_CLI_HOME: join(dir, '.gemini'),
  }
  if (IS_WIN) {
    env.USERPROFILE = dir
    const m = dir.match(/^([A-Za-z]:)(.*)$/)
    if (m) {
      env.HOMEDRIVE = m[1] as string
      env.HOMEPATH = m[2] as string
    }
  }
  return env
}

export const MIN_AGY_VERSION = '1.1.8'

export function resolveAgyBin(binHint: string): string | null {
  const candidates: string[] = []
  if (binHint !== '') candidates.push(binHint)
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (dir !== '') candidates.push(...binCandidates(dir))
  }
  // Per-platform default install locations (GUI apps lack user shell PATH).
  const home = homedir()
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? ''
    const appData = process.env.APPDATA ?? ''
    if (local !== '') {
      candidates.push(join(local, 'Programs', 'agy', 'agy.exe'))
      candidates.push(join(local, 'pnpm', 'agy.cmd'))
      candidates.push(join(local, 'pnpm', 'agy.exe'))
    }
    if (appData !== '') {
      candidates.push(join(appData, 'npm', 'agy.cmd'))
      candidates.push(join(appData, 'Roaming', 'npm', 'agy.cmd'))
    }
    candidates.push(join(home, '.local', 'bin', 'agy.exe'))
    candidates.push(join(home, '.local', 'bin', 'agy.cmd'))
    candidates.push(join(home, '.bun', 'bin', 'agy.exe'))
    candidates.push(join(home, '.cargo', 'bin', 'agy.exe'))
    candidates.push(join(home, 'scoop', 'shims', 'agy.exe'))
  } else {
    // macOS / Linux standard system and package manager paths
    candidates.push(join(home, '.local', 'bin', 'agy'))
    candidates.push('/usr/local/bin/agy')
    candidates.push('/opt/homebrew/bin/agy')
    candidates.push('/opt/homebrew/sbin/agy')
    candidates.push('/home/linuxbrew/.linuxbrew/bin/agy')
    candidates.push(join(home, '.bun', 'bin', 'agy'))
    candidates.push(join(home, '.cargo', 'bin', 'agy'))
    candidates.push(join(home, '.local', 'share', 'pnpm', 'agy'))
    candidates.push(join(home, 'Library', 'pnpm', 'agy'))
    candidates.push(join(home, '.yarn', 'bin', 'agy'))
    candidates.push(join(home, '.npm-global', 'bin', 'agy'))
    candidates.push(join(home, '.volta', 'bin', 'agy'))
    candidates.push(join(home, '.asdf', 'shims', 'agy'))
    candidates.push(join(home, '.nix-profile', 'bin', 'agy'))
    candidates.push('/run/current-system/sw/bin/agy')

    // NVM version directories (~/.nvm/versions/node/*/bin/agy)
    try {
      const nvmNodeDir = join(home, '.nvm', 'versions', 'node')
      if (existsSync(nvmNodeDir)) {
        for (const v of readdirSync(nvmNodeDir)) {
          candidates.push(join(nvmNodeDir, v, 'bin', 'agy'))
        }
      }
    } catch {
      // ignore
    }

    // FNM version directories
    candidates.push(join(home, '.local', 'share', 'fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, '.fnm', 'current', 'bin', 'agy'))
    candidates.push(join(home, 'Library', 'Application Support', 'fnm', 'current', 'bin', 'agy'))
  }
  // Prefer a real executable over a cmd shim: keep the first hit of each
  // PATH dir but rank .exe/extensionless before .cmd/.bat.
  const hits: string[] = []
  for (const c of candidates) {
    try {
      accessSync(c, constants.F_OK)
      hits.push(c)
    } catch {
      continue
    }
  }
  return hits.find((h) => !isCmdShim(h)) ?? hits[0] ?? null
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/\./).map(Number)
  const pb = b.split(/\./).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * A-M1: resolveAgyBin scans every PATH dir + the per-platform default
 * locations (accessSync per candidate, plus an nvm readdir) — far too much
 * synchronous work to redo per spawn on the request path. The cache memoizes
 * the resolved binary until `invalidate()`, which the engine calls after any
 * failed attempt so the retry (or the next run) re-scans — preserving the
 * exact seam semantics the dispatch loop relies on: a retry may find a
 * (re)installed binary even when attempt 0 failed to spawn.
 */
export function createBinCache(resolve: () => string | null): {
  resolve: () => string | null
  invalidate: () => void
} {
  let cached: string | null | undefined
  return {
    resolve: () => {
      if (cached === undefined) cached = resolve()
      return cached
    },
    invalidate: () => {
      cached = undefined
    },
  }
}

export function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+\.\d+)/)
  return m?.[1] ?? null
}

export interface RunOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderrTail: string
  durationMs: number
}

export interface RunOptions {
  bin: string
  args: readonly string[]
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  onLine?: (line: string) => void
  /**
   * A-M5: raw stdout chunks straight from the utf8-decoded pipe. When a chunk
   * consumer is wired the runner skips its own line splitting AND its
   * full-stream capture: the consumer (the engine) feeds the chunk straight
   * into the NDJSON parser instead of re-splitting line-by-line, and the
   * outcome's `stdout` keeps only a head-4KB + tail-64KB excerpt (the engine
   * sniffs the first 4KB for auth banners; nothing reads more). WITHOUT a
   * chunk consumer the full stdout is still captured — `agy models`
   * discovery and the --version probe parse the complete stream.
   */
  onChunk?: (chunk: string) => void
  /** stdin stays writable (auth code injection). */
  keepStdin?: boolean
  /**
   * POSIX-only: how long a SIGTERM'd process group gets to exit before the
   * kill ladder escalates to SIGKILL (A-H1). Windows ignores it — taskkill /F
   * is already fatal. Defaults to GRACE_MS.
   */
  killGraceMs?: number
}

export interface RunningProcess {
  child: ChildProcess
  outcome: Promise<RunOutcome>
  kill(reason: 'timeout' | 'abort'): void
}

const GRACE_MS = 5000

/** One kill blow against the process tree. `force` escalates SIGTERM→SIGKILL
 *  on POSIX; on Windows both blow via taskkill /F (already fatal). */
function sendKill(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined) return
  if (IS_WIN) {
    // No Unix process groups on Windows: kill the whole tree via taskkill.
    try {
      // An unhandled 'error' on the spawned killer (taskkill missing/blocked)
      // surfaces as an async throw and would crash the gateway mid-kill —
      // swallow it; taskkill ships with every Windows install, and the
      // process usually exits on its own regardless.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

export function startAgyProcess(opts: RunOptions): RunningProcess {
  const started = Date.now()
  // S-H4 fail-closed: a Windows .cmd/.bat shim can only execute through
  // cmd.exe, whose quoting cannot neutralize hostile text (Node itself
  // refuses to spawn .bat/.cmd without a shell since CVE-2024-27980). The
  // prompt and — on fallback catalogs — the model slug are request-controlled
  // argv values, so the old cross-spawn quoting left a shell-injection
  // surface on shim-only Windows installs. Refuse the spawn; the engine
  // classifies the throw like any other spawn failure and the message names
  // the fix. resolveAgyBin still surfaces shims so diagnostics can report
  // exactly this instead of a generic "not installed".
  if (IS_WIN && isCmdShim(opts.bin)) {
    throw new Error(
      'Windows: agy resolved to a cmd shim (' +
        opts.bin +
        ') — install the official agy.exe; spawning through cmd.exe would let API request text inject shell commands',
    )
  }
  const env = opts.env ?? process.env
  const child = spawn(opts.bin, opts.args, {
    cwd: opts.cwd,
    env,
    detached: !IS_WIN,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  let aborted = false
  let settled = false

  // agy reads stdin when it is a pipe and never sees EOF (observed on
  // 1.1.15: `agy models` hangs forever with an open pipe stdin, which is
  // why model discovery silently timed out). Close stdin immediately for
  // every spawn that does not explicitly need to write to it.
  if (!opts.keepStdin) {
    try {
      child.stdin?.end()
    } catch {
      // ignore — child may have exited already
    }
  }

  // A-H1 kill ladder. The first blow is SIGTERM (graceful: agy children may
  // flush); if the tree is still alive after killGraceMs it escalates to a
  // group SIGKILL, then a direct child SIGKILL after a second grace. A
  // SIGTERM-immune hung tree used to survive every kill attempt — the
  // watchdog fires once and `await proc.outcome` (and with it the semaphore
  // slot, the busy mark and the per-account queue task) hung forever.
  // Windows is unaffected: taskkill /F has no graceful stage to escalate.
  const graceMs = Math.max(0, opts.killGraceMs ?? GRACE_MS)
  let escalated = false
  let escalationTimer: NodeJS.Timeout | null = null
  let finalKillTimer: NodeJS.Timeout | null = null
  const killTree = (force: boolean): void => {
    sendKill(child, force)
    if (force || escalated || settled || graceMs === 0) return
    escalated = true
    escalationTimer = setTimeout(() => {
      escalationTimer = null
      if (!settled) sendKill(child, true)
    }, graceMs)
    escalationTimer.unref()
    finalKillTimer = setTimeout(() => {
      finalKillTimer = null
      if (!settled) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, graceMs * 2)
    finalKillTimer.unref()
  }
  const disarmEscalation = (): void => {
    if (escalationTimer !== null) clearTimeout(escalationTimer)
    escalationTimer = null
    if (finalKillTimer !== null) clearTimeout(finalKillTimer)
    finalKillTimer = null
  }

  let watchdog: NodeJS.Timeout | null = null
  const refreshWatchdog = () => {
    if (!opts.timeoutMs || opts.timeoutMs <= 0 || settled) return
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      timedOut = true
      killTree(false)
    }, opts.timeoutMs)
  }
  refreshWatchdog()

  const onAbort = () => {
    aborted = true
    killTree(false)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  if (child.stdout) child.stdout.setEncoding('utf8')
  if (child.stderr) child.stderr.setEncoding('utf8')
  // A-L6: a throwing line consumer (parser bug, mirrored-tool crash) must not
  // take the gateway down from inside a stdout 'data' handler. Park the error
  // in the stderr tail, where failure classification already looks.
  const safeOnLine = (line: string): void => {
    try {
      opts.onLine?.(line)
    } catch (err) {
      stderr = (stderr + '[onLine] ' + String(err)).slice(-4096)
    }
  }
  const safeOnChunk = (chunk: string): void => {
    try {
      opts.onChunk?.(chunk)
    } catch (err) {
      stderr = (stderr + '[onChunk] ' + String(err)).slice(-4096)
    }
  }
  // A-M5: with a chunk consumer the run's stdout copy is bounded to the head
  // 4KB + tail 64KB the engine actually reads; without one, models discovery
  // and --version need the whole stream, so capture stays unbounded (with the
  // old 4MB→2MB trim as the runaway guard).
  const hasChunkConsumer = opts.onChunk !== undefined
  const HEAD_KEEP = 4096
  const TAIL_KEEP = 65_536
  let stdoutHead = ''
  let stdoutTail = ''
  let stdoutTotal = 0
  let pending = ''
  child.stdout?.on('data', (chunk: string) => {
    refreshWatchdog()
    if (hasChunkConsumer) {
      stdoutTotal += chunk.length
      if (stdoutHead.length < HEAD_KEEP) stdoutHead = (stdoutHead + chunk).slice(0, HEAD_KEEP)
      stdoutTail = (stdoutTail + chunk).slice(-TAIL_KEEP)
      safeOnChunk(chunk)
      return
    }
    stdout += chunk
    if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, '')
      pending = pending.slice(nl + 1)
      safeOnLine(line)
    }
  })
  child.stderr?.on('data', (chunk: string) => {
    refreshWatchdog()
    stderr = (stderr + chunk).slice(-4096)
  })

  const outcome = new Promise<RunOutcome>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      disarmEscalation()
      opts.signal?.removeEventListener('abort', onAbort)
      if (pending !== '') {
        safeOnLine(pending)
        pending = ''
      }
      resolve({
        code,
        signal,
        timedOut,
        aborted,
        // A-M5: chunk-consuming runs report only the head+tail excerpt (the
        // tail is skipped when the whole stream fit in the head window —
        // otherwise short streams would be duplicated).
        stdout: hasChunkConsumer ? (stdoutTotal <= HEAD_KEEP ? stdoutHead : stdoutHead + stdoutTail) : stdout,
        stderrTail: stderr,
        durationMs: Date.now() - started,
      })
    }
    child.on('exit', (code, signal) => finish(code, signal))
    child.on('error', (err) => {
      stderr = (stderr + String(err)).slice(-4096)
      finish(null, null)
    })
  })

  return {
    child,
    outcome,
    kill: (reason) => {
      if (reason === 'timeout') timedOut = true
      else aborted = true
      if (watchdog) clearTimeout(watchdog)
      killTree(false)
    },
  }
}

export interface ProbeResult {
  ok: boolean
  version?: string
  error?: string
}

/** One-shot --version probe for the startup report. */
export async function probeProcess(
  bin: string,
  args: readonly string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  let p: RunningProcess
  try {
    p = startAgyProcess({ bin, args, timeoutMs, signal, env })
  } catch (e) {
    // The S-H4 shim refusal throws synchronously; the probe's contract is a
    // report, so surface it as a failed probe instead of crashing startup.
    return { ok: false, error: String(e) }
  }
  const out = await p.outcome
  if (out.code !== 0) {
    return { ok: false, error: out.stderrTail.trim() !== '' ? out.stderrTail.trim() : `exited with code ${out.code}` }
  }
  const version = parseVersion(out.stdout)
  if (!version) return { ok: false, error: `unparsable version output: ${out.stdout.slice(0, 200)}` }
  return { ok: true, version }
}
