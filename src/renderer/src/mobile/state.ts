// Phone-only state: who this phone is, and its own theme (a per-phone choice,
// kept in this browser; the PC's theme is the PC's).

import { create } from 'zustand'
import type { MobileMe } from '@shared/mobile'
import type { ThemePref } from '@shared/types'

const THEME_KEY = 'csd.mobile.theme'

function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

interface MobileState {
  me: MobileMe | null
  theme: ThemePref
  setMe: (me: MobileMe) => void
  setTheme: (t: ThemePref) => void
}

export const useMobile = create<MobileState>((set) => ({
  me: null,
  theme: readTheme(),
  setMe: (me) => set({ me }),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // per-phone convenience only
    }
    set({ theme })
  }
}))
