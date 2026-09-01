// i18n completeness (M4 DoD discipline made mechanical): zh-CN and en must
// carry identical key sets with non-empty values — this is what keeps the
// "no hardcoded CJK in .tsx" rule checkable.
import { describe, it, expect } from 'vitest'
import { zhCN } from './zh-CN.ts'
import { en } from './en.ts'

type Resource = Record<string, unknown>

function flatten(node: Resource, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object') keys.push(...flatten(value as Resource, path))
    else keys.push(path)
  }
  return keys.sort()
}

function leafValues(node: Resource): string[] {
  const out: string[] = []
  for (const value of Object.values(node)) {
    if (typeof value === 'object' && value !== null) out.push(...leafValues(value as Resource))
    else if (typeof value === 'string') out.push(value)
  }
  return out
}

const zhKeys = flatten(zhCN as unknown as Resource).sort()
const enKeys = flatten(en as unknown as Resource).sort()

describe('i18n completeness', () => {
  it('zh-CN and en have identical key sets', () => {
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
    expect(missingInEn, 'missing in en.ts').toEqual([])
    expect(missingInZh, 'missing in zh-CN.ts').toEqual([])
  })

  it('no empty translations in either language', () => {
    for (const value of [...leafValues(zhCN as unknown as Resource), ...leafValues(en as unknown as Resource)]) {
      expect(value.trim(), `empty translation: "${value}"`).not.toBe('')
    }
  })
})