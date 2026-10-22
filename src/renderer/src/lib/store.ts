import { create } from 'zustand'
import type { SearchHit } from '@shared/api'
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type AppSettings,
  type ScanState,
  type SessionSummary,
  type SourceInfo
} from '@shared/types'
import type { CreditsState } from '@shared/usage/credits'
import type { LimitsState } from '@shared/usage/limits'
import { EMPTY_FILTERS, type Filters, type SortKey } from './filters'

export type FocusField = 'name' | 'description' | 'tags' | 'find' | 'search' | null

interface ResumeRequest {
  key: string
  fork: boolean
  /** Start a new session in the same folder. */
  newSession?: boolean
}

interface State {
  info: AppInfo | null
  sessions: SessionSummary[]
  sources: SourceInfo[]
  scan: ScanState
  settings: AppSettings
  loaded: boolean
  limits: LimitsState | null
  credits: CreditsState | null

  view: 'sessions' | 'settings' | 'usage'
  selectedKey: string | null
  filters: Filters
  sort: SortKey
  sortBeforeSearch: SortKey
  query: string
  hits: Map<string, SearchHit> | null
  sidebarOpen: boolean

  paletteOpen: boolean
  shortcutsOpen: boolean
  resume: ResumeRequest | null
  focus: { field: FocusField; nonce: number }

  set: (patch: Partial<State>) => void
  setFilters: (patch: Partial<Filters>) => void
  select: (key: string | null) => void
  requestFocus: (field: FocusField) => void
  patchSession: (s: SessionSummary) => void
}

export const useApp = create<State>((set) => ({
  info: null,
  sessions: [],
  sources: [],
  scan: { phase: 'idle', done: 0, total: 0 },
  settings: DEFAULT_SETTINGS,
  loaded: false,
  limits: null,
  credits: null,

  view: 'sessions',
  selectedKey: null,
  filters: EMPTY_FILTERS,
  sort: 'activity',
  sortBeforeSearch: 'activity',
  query: '',
  hits: null,
  sidebarOpen: true,

  paletteOpen: false,
  shortcutsOpen: false,
  resume: null,
  focus: { field: null, nonce: 0 },

  set: (patch) => set(patch),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  select: (key) => set({ selectedKey: key }),
  requestFocus: (field) => set((s) => ({ focus: { field, nonce: s.focus.nonce + 1 } })),
  patchSession: (updated) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.key === updated.key ? updated : x)) }))
}))
