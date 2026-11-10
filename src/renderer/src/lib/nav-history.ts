// Back / Forward for the desktop window: a list of the screens and selections
// visited (no React here; lib/navigation.ts binds it to the store and the DOM).
//
// Only meaningful moves are recorded: a screen, a filter, a session, a viewer
// or Usage tab, the provider switch, a linked Settings section. Changes made
// together become one entry, and quick repeats of the same kind of move (J/K
// held down, clicking through tabs) replace the newest entry instead of adding
// one. History lives in memory only: per window, gone after a restart.

import type { ProviderView } from '@shared/provider'
import type { Filters } from './filters'

export type View = 'sessions' | 'settings' | 'usage' | 'running'
export type ViewerTab = 'conversation' | 'changes'
export type UsageTab = 'trends' | 'limits' | 'credits' | 'raw'

export interface NavState {
  view: View
  filters: Filters
  selectedKey: string | null
  /** The selected session's tab (Conversation when nothing says otherwise). */
  viewerTab: ViewerTab
  usageTab: UsageTab
  providerView: ProviderView
  /** The Settings section last linked to (only while Settings is open). */
  settingsSection: string | null
}

/** Scroll offsets by pane name (`data-nav-scroll`): the list and the main pane. */
export type ScrollMap = Record<string, number>

export interface NavEntry {
  state: NavState
  scroll: ScrollMap
  /** When this entry was last pushed or replaced (for collapsing quick repeats). */
  at: number
  /** The one field the move that made this entry changed, if it changed only one. */
  field: keyof NavState | null
}

export const NAV_LIMIT = 100
/** Two moves of the same kind closer together than this are one move. */
export const COLLAPSE_MS = 500

/** Moves that collapse when repeated quickly (stepping through the list, tabs, the switch). */
const COLLAPSIBLE: ReadonlySet<keyof NavState> = new Set<keyof NavState>([
  'selectedKey',
  'viewerTab',
  'usageTab',
  'providerView'
])

const FIELDS: (keyof NavState)[] = [
  'view',
  'filters',
  'selectedKey',
  'viewerTab',
  'usageTab',
  'providerView',
  'settingsSection'
]

function sameFilters(a: Filters, b: Filters): boolean {
  return (
    a.visibility === b.visibility &&
    a.env === b.env &&
    a.project === b.project &&
    a.tag === b.tag &&
    a.source === b.source &&
    (a.date?.from ?? null) === (b.date?.from ?? null) &&
    (a.date?.to ?? null) === (b.date?.to ?? null) &&
    (a.date?.preset ?? null) === (b.date?.preset ?? null)
  )
}

function sameField(a: NavState, b: NavState, f: keyof NavState): boolean {
  return f === 'filters' ? sameFilters(a.filters, b.filters) : a[f] === b[f]
}

/** The fields that differ between two states. */
export function changedFields(a: NavState, b: NavState): (keyof NavState)[] {
  return FIELDS.filter((f) => !sameField(a, b, f))
}

export function sameState(a: NavState, b: NavState): boolean {
  return changedFields(a, b).length === 0
}

export type Direction = -1 | 1

export class NavHistory {
  private entries: NavEntry[] = []
  private index = -1

  constructor(
    private readonly limit = NAV_LIMIT,
    private readonly collapseMs = COLLAPSE_MS
  ) {}

  get size(): number {
    return this.entries.length
  }

  get position(): number {
    return this.index
  }

  current(): NavEntry | undefined {
    return this.entries[this.index]
  }

  /** Copies, oldest first (for tests and debugging). */
  list(): NavState[] {
    return this.entries.map((e) => e.state)
  }

  /**
   * A move to `state`. Returns what happened: nothing (same as now), a new
   * entry, or the newest entry replaced (a quick repeat).
   */
  record(state: NavState, now: number): 'none' | 'push' | 'replace' {
    const cur = this.entries[this.index]
    if (!cur) {
      this.entries = [{ state, scroll: {}, at: now, field: null }]
      this.index = 0
      return 'push'
    }
    const changed = changedFields(cur.state, state)
    if (changed.length === 0) return 'none'
    const field = changed.length === 1 ? changed[0] : null
    const atTop = this.index === this.entries.length - 1
    if (
      atTop &&
      this.index > 0 &&
      field !== null &&
      field === cur.field &&
      COLLAPSIBLE.has(field) &&
      now - cur.at < this.collapseMs
    ) {
      // Back where the burst started (A → B → A quickly): no entry at all.
      if (sameState(this.entries[this.index - 1].state, state)) {
        this.entries.pop()
        this.index--
        return 'replace'
      }
      this.entries[this.index] = { state, scroll: {}, at: now, field }
      return 'replace'
    }
    // A new move drops everything ahead of here.
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push({ state, scroll: {}, at: now, field })
    if (this.entries.length > this.limit) this.entries.shift()
    this.index = this.entries.length - 1
    return 'push'
  }

  /**
   * Fold an automatic change (the app selecting the first session, or the
   * first visible one after a filter) into the current entry.
   */
  amend(state: NavState): void {
    const cur = this.entries[this.index]
    if (!cur) {
      this.entries = [{ state, scroll: {}, at: 0, field: null }]
      this.index = 0
      return
    }
    cur.state = state
  }

  /** Where the current entry is scrolled to (kept up to date while it's shown). */
  setScroll(pane: string, top: number): void {
    const cur = this.entries[this.index]
    if (cur) cur.scroll[pane] = top
  }

  /**
   * The entry Back (-1) or Forward (1) would go to: the nearest one that is
   * still valid (its session exists) and isn't the screen shown now.
   */
  peekIndex(dir: Direction, valid: (s: NavState) => boolean, shown?: NavState): number | null {
    const now = shown ?? this.entries[this.index]?.state
    for (let i = this.index + dir; i >= 0 && i < this.entries.length; i += dir) {
      const s = this.entries[i].state
      if (!valid(s)) continue
      if (now && sameState(now, s)) continue
      return i
    }
    return null
  }

  peek(dir: Direction, valid: (s: NavState) => boolean, shown?: NavState): NavEntry | null {
    const i = this.peekIndex(dir, valid, shown)
    return i === null ? null : this.entries[i]
  }

  /** Move Back or Forward. Returns the entry to show, or null when there's nowhere to go. */
  go(dir: Direction, valid: (s: NavState) => boolean, shown?: NavState): NavEntry | null {
    const i = this.peekIndex(dir, valid, shown)
    if (i === null) return null
    this.index = i
    // Arriving starts a fresh "quick repeat" window: the next move is a new entry.
    this.entries[i].at = 0
    return this.entries[i]
  }
}
