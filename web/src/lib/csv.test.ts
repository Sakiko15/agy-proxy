// CSV serialization contract (export correctness is an easy regression).
import { describe, it, expect } from 'vitest'
import { toCsv } from './csv.ts'

interface Row {
  name: string
  tokens: number
  note?: string
}

const cols = [
  { header: 'name', value: (r: Row) => r.name },
  { header: 'tokens', value: (r: Row) => r.tokens },
  { header: 'note', value: (r: Row) => r.note },
]

describe('toCsv', () => {
  it('escapes quotes, commas and newlines; headers always emitted', () => {
    const rows: Row[] = [
      { name: 'plain', tokens: 12 },
      { name: 'has,comma', tokens: 1, note: 'say "hi"\nnext line' },
    ]
    expect(toCsv(rows, cols)).toBe(['name,tokens,note', 'plain,12,', '"has,comma",1,"say ""hi""\nnext line"', ''].join('\r\n'))
  })

  it('null/undefined values render as empty fields', () => {
    expect(toCsv([{ name: '', tokens: 0, note: undefined }], cols)).toBe('name,tokens,note\r\n,0,\r\n')
  })

  it('CRLF line endings per RFC 4180', () => {
    const csv = toCsv([{ name: 'a', tokens: 1 }], cols)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv).not.toContain('\n\r,')
  })
})