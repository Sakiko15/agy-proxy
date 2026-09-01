// Doctor report hygiene (S-H3): the report lands in a file on the /data
// volume — key material must never rest there.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig } from '../src/common/types.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { writeDoctorReport } from '../src/host/diagnostics.ts'

const dirs: string[] = []
const envBackup = process.env.AGY_PROXY_DATA_DIR

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* handles */ }
  }
  if (envBackup === undefined) delete process.env.AGY_PROXY_DATA_DIR
  else process.env.AGY_PROXY_DATA_DIR = envBackup
})

describe('S-H3 regression: the doctor report never contains key material', () => {
  it('redacts the bootstrap root key and the admin password from the config snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-doctor-'))
    dirs.push(dir)
    process.env.AGY_PROXY_DATA_DIR = dir
    const cfg = {
      ...defaultConfig(),
      apiKey: 'sk-agy-root-secret-value',
      adminPassword: 'drill-admin-passphrase',
      extraArgs: [],
    }
    const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
    const file = writeDoctorReport({
      cfg: () => cfg,
      bin: () => null,
      version: () => null,
      catalog: () => catalog,
      store: () => new SessionStore(join(dir, 'sessions.json')),
      recentLines: () => [],
    })
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('sk-agy-root-secret-value')
    expect(text).not.toContain('drill-admin-passphrase')
    expect(text).toContain('"apiKey":"<redacted>"')
    expect(text).toContain('"adminPassword":"<redacted>"')
  })
})