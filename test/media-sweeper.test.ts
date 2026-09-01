// Media sweeper wiring (M5): the ported sweepDir() finally gets scheduled —
// boot sweep removes expired staged files, fresh files survive, ttl <= 0
// disables, stop() is idempotent.
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMediaSweeper } from '../src/host/media-sweeper.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* open handles */ }
  }
})

function mkMediaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-media-sweep-'))
  dirs.push(dir)
  return dir
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

describe('startMediaSweeper', () => {
  it('the boot sweep removes files past the TTL and keeps fresh ones', async () => {
    const dir = mkMediaDir()
    const stale = join(dir, 'stale-1.png')
    const fresh = join(dir, 'fresh-1.png')
    writeFileSync(stale, 'old bytes')
    writeFileSync(fresh, 'new bytes')
    // Backdate mtime 2 hours — older than the 1h TTL under test.
    utimesSync(stale, new Date(), new Date(Date.now() - 2 * 3_600_000))

    const logs: string[] = []
    const sweeper = startMediaSweeper(dir, 3_600_000, 3_600_000, (m) => logs.push(m))
    await settle()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(logs.some((m) => m.includes('removed 1 expired'))).toBe(true)
    sweeper.stop()
  })

  it('ttl <= 0 is an inert handle: no sweep, no interval, stop() safe', async () => {
    const dir = mkMediaDir()
    const stale = join(dir, 'kept.png')
    writeFileSync(stale, 'old bytes')
    utimesSync(stale, new Date(), new Date(Date.now() - 48 * 3_600_000))

    const logs: string[] = []
    const sweeper = startMediaSweeper(dir, 0, 3_600_000, (m) => logs.push(m))
    await settle()

    expect(existsSync(stale)).toBe(true)
    expect(logs.some((m) => m.includes('disabled'))).toBe(true)
    expect(() => {
      sweeper.stop()
      sweeper.stop()
    }).not.toThrow()
  })

  it('stop() clears the interval sweep', async () => {
    const dir = mkMediaDir()
    const sweeper = startMediaSweeper(dir, 1_000, 3_600_000)
    await settle()
    expect(() => sweeper.stop()).not.toThrow()
    // After stop() the module keeps no references — the directory it guarded
    // can be removed without a later sweep racing the deletion.
    rmSync(dir, { recursive: true, force: true })
    await settle()
  })
})