// Client-boundary token scrub (M5): terminal failure messages cross to API
// clients through EventMapper.emitFailure — token-shaped material must be
// scrubbed there while URLs (validation_url feature passthrough) survive.
// Deliberately NOT redactLine(): its accounts.google.com rule would destroy
// the validation_url and its `\b[0-9]{4,}/` rule mangles ordinary prose.
import { describe, it, expect } from 'vitest'
import { EventMapper } from '../src/host/mapper.ts'
import { scrubTokenMaterial, redactLine } from '../src/host/diagnostics.ts'

describe('scrubTokenMaterial', () => {
  it('scrubs OAuth access tokens, bearer headers and length-anchored 4/ codes', () => {
    expect(scrubTokenMaterial('token ya29.abcdefghijklmnop')).toBe('token <oauth-token-redacted>')
    expect(scrubTokenMaterial('Bearer abc.def.ghi failed')).toBe('Bearer <redacted> failed')
    expect(scrubTokenMaterial('Invalid grant 4/0AbCdEfGhIjKlMnOpQrStUv')).toBe('Invalid grant <code-redacted>')
    // Short "4/" runs are ordinary prose — the 20-char anchor keeps them.
    expect(scrubTokenMaterial('read 4/5 of the source files')).toBe('read 4/5 of the source files')
    expect(scrubTokenMaterial('1234/ ordinary digits stay')).toContain('1234/')
  })

  it('leaves URLs untouched — the validation_url passthrough is a feature', () => {
    const msg =
      'Your account needs review (VALIDATION_REQUIRED) (validation_url: ' +
      'https://accounts.google.com/gdpr/compliance?dest=100&url=x)'
    const scrubbed = scrubTokenMaterial(msg)
    expect(scrubbed).toBe(msg)
    // The contrast that justifies a separate scrub: redactLine destroys it.
    expect(redactLine(msg)).not.toBe(msg)
    expect(scrubTokenMaterial('see https://example.com/4/0AbCdEfGhIjKlMnOpQrSt/path')).toContain('/path')
  })

  it('emitFailure scrubs token material on the terminal failure chunk', () => {
    const m = new EventMapper({ runId: 'r-scrub', cutOnTool: false })
    const chunks = [...m.emitFailure('error', 'AGY_ERROR', 'upstream 401 with ya29.SUPERSECRET')]
    const finish = chunks.find((c) => c.type === 'finish') as {
      reason: { kind: string; failure?: { message: string; code: string } }
    }
    expect(finish.reason.failure?.code).toBe('AGY_ERROR')
    expect(finish.reason.failure?.message).toBe('upstream 401 with <oauth-token-redacted>')
    expect(JSON.stringify(chunks)).not.toContain('SUPERSECRET')
  })

  it('emitFailure keeps an embedded validation_url verbatim', () => {
    const m = new EventMapper({ runId: 'r-url', cutOnTool: false })
    const url = 'https://accounts.google.com/gdpr/compliance?dest=100'
    const chunks = [...m.emitFailure('error', 'VALIDATION_REQUIRED', 'review needed (validation_url: ' + url + ')')]
    const finish = chunks.find((c) => c.type === 'finish') as {
      reason: { failure?: { message: string } }
    }
    expect(finish.reason.failure?.message).toContain(url)
  })
})