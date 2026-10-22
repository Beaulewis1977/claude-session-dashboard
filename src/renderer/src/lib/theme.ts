import { useEffect, useState } from 'react'
import type { ThemePref } from '@shared/types'
import { api } from './api'

const media = window.matchMedia('(prefers-color-scheme: dark)')

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref
}

/** Applies the theme to <html> and the native title bar. */
export function useThemeEffect(pref: ThemePref): 'light' | 'dark' {
  const [resolved, setResolved] = useState(() => resolveTheme(pref))
  useEffect(() => {
    const apply = (): void => {
      const r = resolveTheme(pref)
      setResolved(r)
      document.documentElement.classList.toggle('dark', r === 'dark')
      void api.setTheme(pref, r)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [pref])
  return resolved
}
