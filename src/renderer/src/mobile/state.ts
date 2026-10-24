// Phone-only state: who this phone is, and its own theme (a per-phone choice,
// kept in this browser; the PC's theme is the PC's).

import { create } from 'zustand'
import type { MobileMe } from '@shared/mobile'
import type { TerminalAccessInfo } from '@shared/terminal'
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
  /** Terminal access on the PC (SSH over Tailscale); null until known. */
  terminal: TerminalAccessInfo | null
  setMe: (me: MobileMe) => void
  setTerminal: (t: TerminalAccessInfo) => void
  setTheme: (t: ThemePref) => void
}

export const useMobile = create<MobileState>((set) => ({
  me: null,
  theme: readTheme(),
  terminal: null,
  setMe: (me) => set({ me }),
  setTerminal: (terminal) => set({ terminal }),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // per-phone convenience only
    }
    set({ theme })
  }
}))
