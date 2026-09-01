// Theme (charter §9: 深/浅双主题，系统跟随 + 手动): 'dark' class on <html>,
// applied pre-paint by the inline script in index.html; the store below keeps
// the manual choice and follows the system theme while in 'system' mode.
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_KEY = 'agy_theme'

let mode: ThemeMode = readStored()
const listeners = new Set<() => void>()

function readStored(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // private mode
  }
  return 'system'
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(theme: ThemeMode): void {
  const dark = theme === 'dark' || (theme === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
}

// Follow the OS theme live while in system mode (and when no choice stored).
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (mode === 'system') apply(mode)
  })
  apply(mode)
}

export function getTheme(): ThemeMode {
  return mode
}

export function setTheme(next: ThemeMode): void {
  mode = next
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    // private mode: applies for the session only
  }
  apply(next)
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** React binding: useTheme() → [mode, setTheme]. */
export function useThemeState(): ThemeMode {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}