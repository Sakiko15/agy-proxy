// Ported from dsh-agy-link test/v02.test.ts media-staging tests @ 46984db
// (converted: node:test/assert → vitest describe/it/expect). The
// mcp-bridge/inlineFiles/schemaArgs portions are dsh-host-specific and were
// not ported (schemaArgs lives inside the engine's --json-schema branch).
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageImages, sweepDir, stagedPath, defaultMediaDir } from '../src/host/media.ts'

describe('media staging', () => {
  it('stageImages writes files and builds prompt lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-media-'))
    try {
      const png = Buffer.from('89504e470d0a1a0a', 'hex')
      const res = await stageImages({
        dir,
        key: 'sess-1',
        images: [
          { attachmentId: 'a1', mediaType: 'image/png', bytes: png.length, width: 10, height: 20, name: 'shot.png' },
          { attachmentId: 'a2', mediaType: 'image/jpeg', bytes: png.length, width: 5, height: 5 },
          { attachmentId: 'dead', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 },
        ],
        readImage: async (ref) => (ref.attachmentId === 'dead' ? null : png),
        maxImages: 4,
        maxBytes: 1024,
      })
      expect(res.staged.length).toBe(2)
      expect(res.skipped).toBe(1)
      expect(res.promptSuffix).toContain('[image attached: "shot.png"')
      const p0 = res.staged[0]!
      expect(p0.path).toBe(join(dir, 'sess-1-0.png'))
      const written = await readFile(p0.path)
      expect(written).toEqual(png)
      // unreadable image -> note line, still counts as skipped
      expect(res.promptSuffix).toContain('image unavailable')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stageImages enforces count and byte caps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-media-'))
    try {
      const png = Buffer.alloc(16, 1)
      const res = await stageImages({
        dir,
        key: 'k',
        images: [
          { attachmentId: 'a', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
          { attachmentId: 'b', mediaType: 'image/png', bytes: 9999, width: 1, height: 1 },
        ],
        readImage: async () => png,
        maxImages: 2,
        maxBytes: 100,
      })
      // first staged; second over byte cap
      expect(res.staged.length).toBe(1)
      expect(res.skipped).toBe(1)
      expect(res.promptSuffix).toContain('exceeds mediaMaxBytes')
      // count cap: two fine images, maxImages 1
      const res2 = await stageImages({
        dir,
        key: 'k2',
        images: [
          { attachmentId: 'x', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
          { attachmentId: 'y', mediaType: 'image/png', bytes: 16, width: 1, height: 1 },
        ],
        readImage: async () => png,
        maxImages: 1,
        maxBytes: 100,
      })
      expect(res2.staged.length).toBe(1)
      expect(res2.skipped).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sweepDir removes only stale files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agy-sweep-'))
    try {
      const fresh = join(dir, 'fresh.png')
      const stale = join(dir, 'stale.png')
      await writeFile(fresh, 'x')
      await writeFile(stale, 'x')
      const now = Date.now()
      // stale: mtime 2h ago, ttl 1h
      const old = new Date(now - 2 * 3600_000)
      await utimes(stale, old, old)
      const removed = await sweepDir(dir, 3600_000, now)
      expect(removed).toBe(1)
      let freshGone = false
      try { await readFile(fresh) } catch { freshGone = true }
      expect(freshGone).toBe(false)
      // ttl<=0 disables
      expect(await sweepDir(dir, 0)).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stagedPath and defaultMediaDir are deterministic', () => {
    expect(stagedPath('/m', 'k', 2, 'image/jpeg')).toBe(join('/m', 'k-2.jpg'))
    expect(defaultMediaDir('/s')).toBe(join('/s', 'media'))
  })
})
