// i18n init (charter §8: react-i18next, zh-CN default; 首次访问语言探测 +
// 手动切换持久化). Detection: stored choice → navigator.languages → zh-CN.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { zhCN } from './zh-CN.ts'
import { en } from './en.ts'

export type Language = 'zh-CN' | 'en'

export const LANG_KEY = 'agy_lang'

function detectStoredLanguage(): Language | null {
  try {
    const stored = localStorage.getItem(LANG_KEY)
    if (stored === 'zh-CN' || stored === 'en') return stored
  } catch {
    // fall through to navigator detection
  }
  return null
}

function detectNavigatorLanguage(): Language {
  if (typeof navigator === 'undefined') return 'zh-CN'
  const candidates = navigator.languages ?? (navigator.language !== undefined ? [navigator.language] : [])
  for (const lang of candidates) {
    const lower = lang.toLowerCase()
    if (lower.startsWith('en')) return 'en'
    if (lower.startsWith('zh')) return 'zh-CN'
  }
  return 'zh-CN'
}

function detectLanguage(): Language {
  return detectStoredLanguage() ?? detectNavigatorLanguage()
}

export function currentLanguage(): Language {
  return (i18n.language === 'en' ? 'en' : 'zh-CN') as Language
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang)
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    // private mode: switch applies for the session only
  }
  document.documentElement.lang = lang
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false }, // React escapes by itself
})

export default i18n