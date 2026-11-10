// The phone's history rules (no DOM or store here; mobile/nav.ts binds them to
// window.history and the store): each tab, an open session and the Usage tabs
// are browser history entries, so Back goes to the previous screen instead of
// leaving the app. A session that no longer exists is skipped going back
// (going forward, its tab shows instead).

import type { UsageTab, View } from '@/lib/nav-history'

export interface PhoneNavState {
  view: View
  key: string | null
  usageTab: UsageTab
}

/** An entry as kept in history.state: `i` counts up from the app's first entry. */
interface Stamped extends PhoneNavState {
  i: number
}

const MARK = 'csdNav'
const VIEWS: readonly View[] = ['sessions', 'settings', 'usage', 'running']
const USAGE_TABS: readonly UsageTab[] = ['trends', 'limits', 'credits', 'raw']
/** Usage tabs tapped through quickly are one entry. */
const COLLAPSE_MS = 500

export interface HistoryLike {
  readonly state: unknown
  pushState(data: unknown, unused: string): void
  replaceState(data: unknown, unused: string): void
  back(): void
}

export interface PhoneNavDeps {
  history: HistoryLike
  /** Calls back with each popstate's state (the window's Back / Forward); returns an unsubscribe. */
  onPopState: (cb: (state: unknown) => void) => () => void
  get: () => PhoneNavState
  apply: (s: PhoneNavState) => void
  subscribe: (cb: () => void) => () => void
  exists: (key: string) => boolean
  now?: () => number
}

export interface PhoneNav {
  /** Close the open session: back to the screen it was opened from. */
  close: () => void
  stop: () => void
}

function readStamp(state: unknown): Stamped | null {
  const s = (state as Record<string, unknown> | null)?.[MARK] as Partial<Stamped> | undefined
  if (!s || typeof s !== 'object') return null
  if (!VIEWS.includes(s.view as View)) return null
  if (!Number.isInteger(s.i) || (s.i as number) < 0) return null
  return {
    view: s.view as View,
    key: typeof s.key === 'string' ? s.key : null,
    usageTab: USAGE_TABS.includes(s.usageTab as UsageTab) ? (s.usageTab as UsageTab) : 'trends',
    i: s.i as number
  }
}

function same(a: PhoneNavState, b: PhoneNavState): boolean {
  return a.view === b.view && a.key === b.key && a.usageTab === b.usageTab
}

export function startPhoneHistory(d: PhoneNavDeps): PhoneNav {
  const now = d.now ?? (() => performance.now())
  const wrap = (s: Stamped): Record<string, Stamped> => ({ [MARK]: s })
  // After a reload the entry keeps its number, so older entries still line up.
  let current: Stamped = { ...d.get(), i: readStamp(d.history.state)?.i ?? 0 }
  d.history.replaceState(wrap(current), '')
  let lastAt = -Infinity
  let lastWasTab = false

  const onChange = (): void => {
    const s = d.get()
    if (same(s, current)) return
    const tabOnly = s.view === current.view && s.key === current.key
    if (tabOnly && lastWasTab && now() - lastAt < COLLAPSE_MS && current.i > 0) {
      current = { ...s, i: current.i }
      d.history.replaceState(wrap(current), '')
    } else {
      current = { ...s, i: current.i + 1 }
      d.history.pushState(wrap(current), '')
    }
    lastAt = now()
    lastWasTab = tabOnly
  }

  const onPop = (state: unknown): void => {
    const st = readStamp(state)
    if (!st) return
    lastAt = -Infinity
    if (st.key && !d.exists(st.key)) {
      // Going back past a session that's gone, if there's an earlier screen.
      if (st.i < current.i && st.i > 0) {
        current = st
        d.history.back()
        return
      }
      const fixed: Stamped = { ...st, key: null }
      d.history.replaceState(wrap(fixed), '')
      current = fixed
      d.apply(fixed)
      return
    }
    current = st
    d.apply(st)
  }

  const unsub = d.subscribe(onChange)
  const offPop = d.onPopState(onPop)
  return {
    close: () => {
      if (current.key && current.i > 0) d.history.back()
      else d.apply({ ...current, key: null })
    },
    stop: () => {
      unsub()
      offPop()
    }
  }
}
