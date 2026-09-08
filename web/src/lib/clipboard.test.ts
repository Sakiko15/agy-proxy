// copyText contract: clipboard API preferred, execCommand fallback for
// non-secure contexts, rejection only when every mechanism fails.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { copyText } from './clipboard.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  it('prefers navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyText('sk-agy-a')
    expect(writeText).toHaveBeenCalledWith('sk-agy-a')
  })

  it('falls through to execCommand when the clipboard write rejects', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const execCommand = vi.fn((): boolean => true)
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand,
    })
    await copyText('sk-agy-w')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('covers plain-http deployments via the hidden-textarea execCommand path', async () => {
    vi.stubGlobal('navigator', {}) // non-secure context: no clipboard at all
    const execCommand = vi.fn((): boolean => true)
    const el = { value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() }
    const removeChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn(() => el),
      body: { appendChild: vi.fn(), removeChild },
      execCommand,
    })
    await copyText('sk-agy-b')
    expect(execCommand).toHaveBeenCalledWith('copy')
    // the offscreen textarea is always cleaned up
    expect(removeChild).toHaveBeenCalledWith(el)
  })

  it('rejects only when every mechanism fails', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ value: '', style: {}, setAttribute: vi.fn(), select: vi.fn() })),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn((): boolean => false),
    })
    await expect(copyText('sk-agy-z')).rejects.toThrow('execCommand rejected the copy')
  })
})