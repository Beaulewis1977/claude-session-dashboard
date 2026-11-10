// The phone's back gesture / button follows the app's screens (the rules are
// in nav-rules.ts): this binds them to window.history and the store.

import { useEffect } from 'react'
import { useApp } from '@/lib/store'
import { startPhoneHistory, type PhoneNav } from './nav-rules'

let active: PhoneNav | null = null

/** Close the open session screen (its Back button and the edge swipe). */
export function closeSession(): void {
  if (active) active.close()
  else useApp.getState().select(null)
}

/** Keep the phone's screens in browser history while it's paired. */
export function usePhoneHistory(paired: boolean): void {
  useEffect(() => {
    if (!paired) return
    const nav = startPhoneHistory({
      history: window.history,
      onPopState: (cb) => {
        const listener = (e: PopStateEvent): void => cb(e.state)
        window.addEventListener('popstate', listener)
        return () => window.removeEventListener('popstate', listener)
      },
      get: () => {
        const st = useApp.getState()
        return { view: st.view, key: st.selectedKey, usageTab: st.usageTab }
      },
      apply: (s) =>
        useApp.getState().set({ view: s.view, selectedKey: s.key, usageTab: s.usageTab }),
      subscribe: (cb) =>
        useApp.subscribe((st, prev) => {
          if (
            st.view !== prev.view ||
            st.selectedKey !== prev.selectedKey ||
            st.usageTab !== prev.usageTab
          )
            cb()
        }),
      exists: (key) => useApp.getState().sessions.some((s) => s.key === key),
      loaded: () => useApp.getState().loaded
    })
    const offLoaded = useApp.subscribe((st, prev) => {
      if (st.loaded && !prev.loaded) nav.checkLoaded()
    })
    active = nav
    return () => {
      offLoaded()
      nav.stop()
      if (active === nav) active = null
    }
  }, [paired])
}
