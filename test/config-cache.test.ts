// B-M3: readOverrides mtime+size memo. The host resolves the config on every
// request, so the overrides read must not pay a full readFileSync+parse each
// time — one statSync on a cache hit instead. These tests pin both halves of
// the contract: the cache short-circuits a stat-identical re-read, and a
// real change (or the writer's explicit invalidate) still lands immediately —
// the no-restart semantics the admin UI relies on.
//
// The trick for forcing a cache hit despite different content: write a new
// body of the SAME byte length, then utimesSync the mtime back to a value
// the cache has already seen. NTFS keeps 100ns mtime precision and the
// float→filesystem conversion is deterministic, so feeding the identical
// float to both utimesSync calls reproduces the exact statSync mtimeMs the
// memo recorded. Without the memo the re-read would see the new bytes.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOverrides, invalidateOverridesCache } from '../src/common/config.ts'
import { writeOverridesPatch } from '../src/server/settings.ts'

const dirs: string[] = []
afterEach(() => {
  invalidateOverridesCache() // never leak a memo across tests (module state)
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ }
  }
})

function mkFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-'))
  dirs.push(dir)
  return join(dir, 'runtime-overrides.json')
}

/** A fixed past mtime (epoch seconds, sub-ms float) to pin through utimesSync. */
const PINNED = (Date.now() - 60_000) / 1000
function pinMtime(file: string): void {
  utimesSync(file, PINNED, PINNED)
}

describe('readOverrides mtime+size cache (B-M3)', () => {
  it('returns the new value when the file actually changes (no-restart semantics)', () => {
    const file = mkFile()
    writeFileSync(file, '{"timeoutMs": 111}\n')
    expect(readOverrides(file)).toEqual({ timeoutMs: 111 })
    // A genuine rewrite (size differs) is visible on the very next read.
    writeFileSync(file, '{"timeoutMs": 222}\n')
    expect(readOverrides(file)).toEqual({ timeoutMs: 222 })
  })

  it('serves the memo when a same-size rewrite keeps the same mtime (cache hit)', () => {
    const file = mkFile()
    // Both bodies are exactly 22 bytes; only the digits differ.
    writeFileSync(file, '{"timeoutMs": 111}\n')
    pinMtime(file)
    const first = readOverrides(file)
    expect(first).toEqual({ timeoutMs: 111 })

    // Same length, same pinned mtime → the cache cannot distinguish it from
    // the first read; the memo (not the new bytes) is what comes back.
    writeFileSync(file, '{"timeoutMs": 999}\n')
    pinMtime(file)
    expect(readOverrides(file)).toEqual({ timeoutMs: 111 })
  })

  it('invalidateOverridesCache drops the memo — the writer seam unblocks reads', () => {
    const file = mkFile()
    writeFileSync(file, '{"timeoutMs": 111}\n')
    pinMtime(file)
    expect(readOverrides(file)).toEqual({ timeoutMs: 111 })
    writeFileSync(file, '{"timeoutMs": 999}\n')
    pinMtime(file)
    // Stale by mtime+size…
    expect(readOverrides(file)).toEqual({ timeoutMs: 111 })
    // …and the explicit invalidate is the seam that catches it up.
    invalidateOverridesCache()
    expect(readOverrides(file)).toEqual({ timeoutMs: 999 })
  })

  it('writeOverridesPatch invalidates after its rename (same-tick same-size rewrite)', () => {
    const file = mkFile()
    writeFileSync(file, '{"timeoutMs": 111, "note": "keep"}\n')
    pinMtime(file)
    expect(readOverrides(file)).toEqual({ timeoutMs: 111, note: 'keep' })

    // The patch produces the same byte size (111→222) and we pin the mtime
    // back — without the writer-side invalidate the next read would serve
    // the stale memo.
    writeOverridesPatch({ timeoutMs: 222 }, file)
    pinMtime(file)
    expect(readOverrides(file)).toEqual({ timeoutMs: 222, note: 'keep' })
  })

  it('missing and corrupt files stay tolerated and never poison the cache', () => {
    const file = mkFile()
    expect(readOverrides(file)).toEqual({})
    writeFileSync(file, 'not json at all {{{')
    expect(readOverrides(file)).toEqual({})
    // Repaired in place — picked up immediately (corrupt data is not cached).
    writeFileSync(file, '{"timeoutMs": 333}\n')
    expect(readOverrides(file)).toEqual({ timeoutMs: 333 })
  })
})