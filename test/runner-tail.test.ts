// B2/P1: the runner's stdout/stderr excerpt windows (head 4KB + tail 64KB,
// stderr 4KB) were reworked from per-chunk window slicing to amortized
// trimming (grow to 2x the window, trim there, slice at resolve). These tests
// pin the excerpt contract against directly computed expectations — the
// resolve-time result must be the exact head/tail of the stream the child
// printed, regardless of how the pipe chunked it.
import { describe, it, expect } from 'vitest'
import { startAgyProcess } from '../src/host/runner.ts'

const NODE = process.execPath

describe('runner excerpt windows (B2/P1 amortized trim)', () => {
  const LINE = 'x'.repeat(1000) + '\n'

  it('a large stdout stream reports exactly head-4K + tail-64K', async () => {
    // ~300KB total, far past both windows; the child writes in 1001-char
    // lines so real pipe chunks land mid-line. Expectations come from the
    // known full stream, not from observed chunk boundaries.
    const full = LINE.repeat(300)
    const script = `for (let i = 0; i < 300; i++) process.stdout.write(${JSON.stringify(LINE)}); process.stderr.write('y'.repeat(9000));`
    const chunks: string[] = []
    const p = startAgyProcess({ bin: NODE, args: ['-e', script], onChunk: (c) => chunks.push(c) })
    const out = await p.outcome
    expect(out.code).toBe(0)
    // The chunk consumer still sees the complete stream, unmodified.
    expect(chunks.join('')).toBe(full)
    // Excerpt = first 4096 + last 65536 of the full stream (byte-identical to
    // the per-chunk window slice the old algorithm produced).
    expect(out.stdout).toBe(full.slice(0, 4096) + full.slice(-65_536))
    // stderr: 9000 chars printed, tail window is 4096.
    expect(out.stderrTail).toBe('y'.repeat(4096))
  }, 30_000)

  it('a stream past the head window but inside the tail window keeps the pre-existing overlap', async () => {
    // 4096 < total ≤ 65536: the tail holds the WHOLE stream (nothing was
    // trimmed) and the head is still prepended — the first 4KB appears twice.
    // That overlap predates B2 and is preserved byte-for-byte (changing it
    // would be a behavior change outside this batch's equivalence mandate).
    const full = LINE.repeat(12) // 12,012 chars
    const script = `for (let i = 0; i < 12; i++) process.stdout.write(${JSON.stringify(LINE)});`
    const p = startAgyProcess({ bin: NODE, args: ['-e', script], onChunk: () => {} })
    const out = await p.outcome
    expect(out.code).toBe(0)
    expect(out.stdout).toBe(full.slice(0, 4096) + full)
  }, 30_000)

  it('a stream fitting the head window is reported whole (dedup rule)', async () => {
    const full = LINE.repeat(2) // 2,002 chars ≤ 4096
    const script = `for (let i = 0; i < 2; i++) process.stdout.write(${JSON.stringify(LINE)});`
    const p = startAgyProcess({ bin: NODE, args: ['-e', script], onChunk: () => {} })
    const out = await p.outcome
    expect(out.code).toBe(0)
    expect(out.stdout).toBe(full)
  }, 30_000)

  it('stderr lines interleaved with stdout still end in the exact 4K tail', async () => {
    // Amortized stderr trimming must never lose the final 4096 chars, even
    // when stdout floods between stderr writes.
    const script = [
      `process.stderr.write('e'.repeat(5000));`,
      `for (let i = 0; i < 100; i++) process.stdout.write(${JSON.stringify(LINE)});`,
      `process.stderr.write('end-marker');`,
    ].join('')
    const p = startAgyProcess({ bin: NODE, args: ['-e', script], onChunk: () => {} })
    const out = await p.outcome
    expect(out.code).toBe(0)
    expect(out.stderrTail.endsWith('end-marker')).toBe(true)
    expect(out.stderrTail.length).toBe(4096)
  }, 30_000)
})