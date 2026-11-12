// The Settings page's own state, shared by the page and the sidebar's Settings
// menu: the search, which sections are folded, the section in view
// (scroll-spy), the setting a link points at, and what each setting on the
// page reports (changed, and how to reset it).
//
// Folded sections and the last section are per-viewer conveniences kept in
// localStorage (like the list width); everything else lives in memory.

import { create } from 'zustand'
import {
  matchSetting,
  resolveTarget,
  SECTIONS,
  settingDef,
  type SectionId,
  type SettingDef
} from '@shared/settings-registry'

export const COLLAPSED_KEY = 'csd.settings.collapsed'
export const LAST_SECTION_KEY = 'csd.settings.lastSection'

/** What a setting on the page reports about itself. */
export interface MountedSetting {
  changed: boolean
  /** Puts it back to its default; resolves to an Undo (absent: no reset). */
  reset?: () => Promise<() => Promise<void>>
}

export interface SettingsUiState {
  query: string
  collapsed: Partial<Record<SectionId, boolean>>
  /** Scroll-spy: the section and sub-heading in view. */
  active: { section: SectionId; sub: string | null }
  /** Settings on the page now (rendered, maybe hidden by search or folding). */
  mounted: Record<string, MountedSetting>
  /** The setting (or heading) a link just went to, briefly highlighted. */
  highlight: { id: string; token: number } | null
  /** Bumped to move focus to the search field (Ctrl+F, Ctrl+, while open). */
  focusSearch: number
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // per-viewer convenience only
  }
}

export function readLastSection(): string | null {
  const v = readJson<unknown>(LAST_SECTION_KEY, null)
  return typeof v === 'string' && resolveTarget(v) ? v : null
}

export function saveLastSection(target: string): void {
  writeJson(LAST_SECTION_KEY, target)
}

function readCollapsed(): Partial<Record<SectionId, boolean>> {
  const v = readJson<unknown>(COLLAPSED_KEY, {})
  if (!v || typeof v !== 'object') return {}
  const out: Partial<Record<SectionId, boolean>> = {}
  for (const s of SECTIONS) if ((v as Record<string, unknown>)[s.id] === true) out[s.id] = true
  return out
}

export const useSettingsUi = create<SettingsUiState>(() => ({
  query: '',
  collapsed: readCollapsed(),
  active: { section: SECTIONS[0].id, sub: null },
  mounted: {},
  highlight: null,
  focusSearch: 0
}))

let highlightToken = 0
/** The newest link into Settings; one still waiting for its setting stops when it changes. */
let linkEpoch = 0

export const settingsUi = {
  setQuery(query: string): void {
    useSettingsUi.setState({ query })
  },
  toggleCollapsed(id: SectionId, collapsed?: boolean): void {
    const cur = useSettingsUi.getState().collapsed
    const next = { ...cur }
    if (collapsed ?? !cur[id]) next[id] = true
    else delete next[id]
    useSettingsUi.setState({ collapsed: next })
    writeJson(COLLAPSED_KEY, next)
  },
  setActive(section: SectionId, sub: string | null): void {
    const a = useSettingsUi.getState().active
    if (a.section === section && a.sub === sub) return
    useSettingsUi.setState({ active: { section, sub } })
  },
  mount(id: string, m: MountedSetting): void {
    const cur = useSettingsUi.getState().mounted[id]
    if (cur && cur.changed === m.changed && cur.reset === m.reset) return
    useSettingsUi.setState((s) => ({ mounted: { ...s.mounted, [id]: m } }))
  },
  unmount(id: string): void {
    if (!(id in useSettingsUi.getState().mounted)) return
    useSettingsUi.setState((s) => {
      const next = { ...s.mounted }
      delete next[id]
      return { mounted: next }
    })
  },
  highlight(id: string): void {
    useSettingsUi.setState({ highlight: { id, token: ++highlightToken } })
  },
  clearHighlight(token: number): void {
    if (useSettingsUi.getState().highlight?.token === token)
      useSettingsUi.setState({ highlight: null })
  },
  focusSearch(): void {
    useSettingsUi.setState((s) => ({ focusSearch: s.focusSearch + 1 }))
  },
  /** A new link starts: returns its number (see linkCurrent). */
  startLink(): number {
    return ++linkEpoch
  },
  /** Still the newest link (nothing since cancelled it)? */
  linkCurrent(n: number): boolean {
    return n === linkEpoch
  },
  /**
   * Stop a link that's still waiting for its setting: another link, Back /
   * Forward putting an earlier place back, you scrolling, or leaving Settings.
   */
  cancelLink(): void {
    linkEpoch++
  },
  /** For tests. */
  reset(): void {
    useSettingsUi.setState({
      query: '',
      collapsed: {},
      active: { section: SECTIONS[0].id, sub: null },
      mounted: {},
      highlight: null,
      focusSearch: 0
    })
  }
}

/** The settings on the page that match the search (all of them without one). */
export function visibleSettingIds(
  mounted: Record<string, MountedSetting>,
  query: string
): string[] {
  return Object.keys(mounted).filter((id) => {
    const d = settingDef(id)
    return !!d && matchSetting(d, query).match
  })
}

export function settingsIn(
  ids: string[],
  where: { section?: SectionId; sub?: string }
): SettingDef[] {
  const out: SettingDef[] = []
  for (const id of ids) {
    const d = settingDef(id)
    if (!d) continue
    if (where.section && d.section !== where.section) continue
    if (where.sub && d.sub !== where.sub) continue
    out.push(d)
  }
  return out
}

/** How many settings on the page match, per section and sub-heading (no search: all). */
export function useMatchCounts(): {
  total: number
  bySection: Partial<Record<SectionId, number>>
  bySub: Record<string, number>
} {
  const mounted = useSettingsUi((s) => s.mounted)
  const query = useSettingsUi((s) => s.query)
  // Only the ids matter (not each setting's changed state): computed from a key string.
  const ids = visibleSettingIds(mounted, query)
  const bySection: Partial<Record<SectionId, number>> = {}
  const bySub: Record<string, number> = {}
  for (const id of ids) {
    const d = settingDef(id)!
    bySection[d.section] = (bySection[d.section] ?? 0) + 1
    if (d.sub) bySub[d.sub] = (bySub[d.sub] ?? 0) + 1
  }
  return { total: ids.length, bySection, bySub }
}

/** Settings on the page in a section that differ from their defaults. */
export function changedIn(mounted: Record<string, MountedSetting>, section: SectionId): string[] {
  return Object.entries(mounted)
    .filter(([id, m]) => m.changed && settingDef(id)?.section === section)
    .map(([id]) => id)
}
