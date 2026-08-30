// M0 acceptance tests (acceptance.md §3 M0): config layer resolution,
// version probe/dormant startup, runner kill/watchdog behavior via fake-agy.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/common/config.ts'
import { compareVersions, parseVersion, binCandidates, windowsQuote, isCmdShim, isolatedHomeEnv, probeProcess } from '../src/host/runner.ts'
import { compareVersions as cmp2 } from '../src/index.ts'

const NODE = process.execPath
// fileURLToPath handles Windows drive letters correctly (URL.pathname yields
// "/D:/..." which node cannot spawn).
const FAKE = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url))

describe('config layering (env > overrides > defaults)', () => {
  it('defaults apply with no env and no overrides', () => {
    const cfg = resolveConfig({}, {})
    expect(cfg.enabled).toBe(true)
    expect(cfg.permissionMode).toBe('plan')
    expect(cfg.timeoutMs).toBe(600_000)
    expect(cfg.port).toBe(8080)
    expect(cfg.quotaPollIntervalMs).toBe(15 * 60_000)
    expect(cfg.fallbackModels.length).toBeGreaterThan(0)
  })

  it('overrides file wins over defaults', () => {
    const cfg = resolveConfig({}, { timeoutMs: 5_000, defaultModel: 'gemini-3.7-flash' })
    expect(cfg.timeoutMs).toBe(5_000)
    expect(cfg.defaultModel).toBe('gemini-3.7-flash')
  })

  it('env wins over overrides', () => {
    const cfg = resolveConfig({ AGY_PROXY_TIMEOUT_MS: '99_000' as never as string } as NodeJS.ProcessEnv, { timeoutMs: 5_000 })
    // asNum accepts numeric strings; '99_000' is not numeric so falls through.
    expect(cfg.timeoutMs).toBe(5_000)
    const cfg2 = resolveConfig({ AGY_PROXY_TIMEOUT_MS: '99000' } as NodeJS.ProcessEnv, { timeoutMs: 5_000 })
    expect(cfg2.timeoutMs).toBe(99_000)
  })

  it('AGY_PROXY_MODE maps onto permissionMode', () => {
    expect(resolveConfig({ AGY_PROXY_MODE: 'accept-edits' } as NodeJS.ProcessEnv, {}).permissionMode).toBe('accept-edits')
    expect(resolveConfig({ AGY_PROXY_SKIP_PERMISSIONS: 'true' } as NodeJS.ProcessEnv, {}).permissionMode).toBe('skip')
    expect(resolveConfig({ AGY_PROXY_SKIP_PERMISSIONS: 'false' } as NodeJS.ProcessEnv, {}).permissionMode).toBe('plan')
  })

  it('invalid env values are ignored (fall through to lower layers)', () => {
    const cfg = resolveConfig({ AGY_PROXY_MODE: 'bogus', AGY_PROXY_PORT: '99999' } as NodeJS.ProcessEnv, {})
    expect(cfg.permissionMode).toBe('plan')
    expect(cfg.port).toBe(8080)
  })

  it('dataDir honors AGY_PROXY_DATA_DIR', () => {
    const cfg = resolveConfig({ AGY_PROXY_DATA_DIR: '/tmp/agy-data' } as NodeJS.ProcessEnv, {})
    expect(cfg.dataDir).toBe('/tmp/agy-data')
  })

  it('extraArgs split on whitespace from env', () => {
    const cfg = resolveConfig({ AGY_PROXY_EXTRA_ARGS: '--foo bar --baz' } as NodeJS.ProcessEnv, {})
    expect(cfg.extraArgs).toEqual(['--foo', 'bar', '--baz'])
  })
})

describe('runner helpers', () => {
  it('compareVersions orders semver-ish versions', () => {
    expect(compareVersions('1.1.9', '1.1.8')).toBeGreaterThan(0)
    expect(compareVersions('1.1.8', '1.1.8')).toBe(0)
    expect(compareVersions('1.2.0', '1.1.100')).toBeGreaterThan(0)
    expect(cmp2('0.9.0', '1.0.0')).toBeLessThan(0)
  })

  it('parseVersion extracts x.y.z', () => {
    expect(parseVersion('agy version 1.1.22 (build 1234)')).toBe('1.1.22')
    expect(parseVersion('no version here')).toBeNull()
  })

  it('binCandidates covers platform extensions', () => {
    expect(binCandidates('/usr/bin', 'linux')).toEqual([join('/usr/bin', 'agy')])
    expect(binCandidates('C:\\bin', 'win32')).toEqual([
      join('C:\\bin', 'agy.exe'),
      join('C:\\bin', 'agy.cmd'),
      join('C:\\bin', 'agy.bat'),
    ])
  })

  it('isCmdShim detects Windows shims', () => {
    expect(isCmdShim('C:\\x\\agy.cmd')).toBe(true)
    expect(isCmdShim('/usr/bin/agy')).toBe(false)
  })

  it('windowsQuote quotes args with spaces', () => {
    expect(windowsQuote('plain')).toBe('plain')
    expect(windowsQuote('a b')).toBe('"a b"')
    expect(windowsQuote('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('isolatedHomeEnv sets USERPROFILE family on win32', () => {
    const env = isolatedHomeEnv('D:\\acc1')
    expect(env.HOME).toBe('D:\\acc1')
    expect(env.GEMINI_CLI_HOME).toContain('.gemini')
  })
})

describe('agy version probe (fake-agy)', () => {
  it('probeProcess parses the version from a successful run', async () => {
    // fake-agy exits 0 for non-model calls; version output comes from stdout.
    const r = await probeProcess(NODE, [FAKE, '--version'])
    expect(r.ok).toBe(true)
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/)
  }, 30_000)

  it('probeProcess reports failure with stderr tail on nonzero exit', async () => {
    const r = await probeProcess(NODE, [FAKE, 'models'], 30_000, undefined, {
      ...process.env,
      FAKE_AGY_MODELS: 'fail',
    } as NodeJS.ProcessEnv)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Please sign in')
  }, 30_000)
})

describe('runner line streaming + argv recording (fake-agy)', () => {
  it('streams stdout lines and records argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-test-'))
    const argsFile = join(dir, 'args.jsonl')
    const lines: string[] = []
    const { startAgyProcess } = await import('../src/host/runner.ts')
    const p = startAgyProcess({
      bin: NODE,
      args: [FAKE],
      env: { ...process.env, FAKE_AGY_MODE: 'ok', FAKE_AGY_ARGS_FILE: argsFile } as NodeJS.ProcessEnv,
      onLine: (l) => lines.push(l),
    })
    const out = await p.outcome
    expect(out.code).toBe(0)
    expect(lines.length).toBe(4)
    expect(lines[0]).toContain('"event":"init"')
    // fake-agy appends one JSON argv array per line; the last run passed no
    // arguments (the default `ok` mode run).
    const recorded = readFileSync(argsFile, 'utf8').trim().split('\n')
    expect(JSON.parse(recorded.at(-1) ?? '[]')).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  }, 30_000)

  it('abort kills the process tree (watchdog path)', async () => {
    const { startAgyProcess } = await import('../src/host/runner.ts')
    const ac = new AbortController()
    const p = startAgyProcess({
      bin: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 60_000,
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 200)
    const out = await p.outcome
    expect(out.aborted).toBe(true)
  }, 30_000)

  it('watchdog fires on idle timeout', async () => {
    const { startAgyProcess } = await import('../src/host/runner.ts')
    const p = startAgyProcess({
      bin: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 400,
    })
    const out = await p.outcome
    expect(out.timedOut).toBe(true)
  }, 30_000)
})

describe('runtime overrides file', () => {
  it('readOverrides tolerates missing and corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-proxy-test-'))
    const missing = join(dir, 'nope.json')
    writeFileSync(join(dir, 'bad.json'), '{not json')
    const { readOverrides, overridesPath } = await import('../src/common/config.ts')
    expect(Object.keys(readOverrides(missing))).toHaveLength(0)
    expect(Object.keys(readOverrides(join(dir, 'bad.json')))).toHaveLength(0)
    expect(overridesPath()).toContain('runtime-overrides.json')
    rmSync(dir, { recursive: true, force: true })
  })
})
