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
import type { LiveSnapshot } from '@shared/live'
import { EMPTY_SUMMARY_QUEUE, type SummaryQueueState } from '@shared/summary-queue'
import { EMPTY_FILTERS, type Filters, type SortKey } from './filters'

export type FocusField = 'name' | 'description' | 'tags' | 'find' | 'search' | null

export interface BranchTarget {
  /** Transcript message id. */
  at: string
  mode: 'include' | 'before'
}

interface ResumeRequest {
  key: string
  fork: boolean
  /** Start a new session in the same folder. */
  newSession?: boolean
  /** Branch from a message (creates a new session file first). */
  branch?: BranchTarget
  /** Continue fresh: a new session started from this session's summary. */
  continueFresh?: boolean
}

/** The Summarize dialog: the one-time notice, the estimate and the preview. */
export interface SummarizeRequest {
  keys: string[]
  origin: 'manual' | 'bulk'
  /** Open on "what is sent" (the preview). */
  preview?: boolean
}

const GROUP_KEY = 'csd.groupBranches'

function readGroupBranches(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) !== '0'
  } catch {
    return true
  }
}

export function saveGroupBranches(v: boolean): void {
  try {
    localStorage.setItem(GROUP_KEY, v ? '1' : '0')
  } catch {
    // per-viewer convenience only
  }
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
  /** Running now (null until loaded). */
  live: LiveSnapshot | null

  view: 'sessions' | 'settings' | 'usage' | 'running'
  /** Settings section to scroll to when Settings opens (e.g. 'accounts'). */
  settingsSection: string | null
  selectedKey: string | null
  /** Sessions picked with Ctrl/Shift+click for a bulk action (includes the selected one). */
  checked: string[]
  /** Where a Shift+click / Shift+arrow range starts. */
  anchorKey: string | null
  filters: Filters
  sort: SortKey
  sortBeforeSearch: SortKey
  query: string
  hits: Map<string, SearchHit> | null
  sidebarOpen: boolean

  paletteOpen: boolean
  shortcutsOpen: boolean
  resume: ResumeRequest | null
  /** First "Branch from here": explain what it writes before going on. */
  branchIntro: { key: string; branch: BranchTarget } | null
  summarize: SummarizeRequest | null
  /** Session summaries being written (and recently finished). */
  summaryQueue: SummaryQueueState
  /** Show branches under their parent in the session list. */
  groupBranches: boolean
  focus: { field: FocusField; nonce: number }

  set: (patch: Partial<State>) => void
  setFilters: (patch: Partial<Filters>) => void
  select: (key: string | null) => void
  requestFocus: (field: FocusField) => void
  patchSession: (s: SessionSummary) => void
  /** Add or replace a session (e.g. a branch that was just created). */
  upsertSession: (s: SessionSummary) => void
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
  live: null,

  view: 'sessions',
  settingsSection: null,
  selectedKey: null,
  checked: [],
  anchorKey: null,
  filters: EMPTY_FILTERS,
  sort: 'activity',
  sortBeforeSearch: 'activity',
  query: '',
  hits: null,
  sidebarOpen: true,

  paletteOpen: false,
  shortcutsOpen: false,
  resume: null,
  branchIntro: null,
  summarize: null,
  summaryQueue: EMPTY_SUMMARY_QUEUE,
  groupBranches: readGroupBranches(),
  focus: { field: null, nonce: 0 },

  set: (patch) => set(patch),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  // A focus request belongs to the session it was made for. A plain selection ends a multi-selection.
  select: (key) =>
    set((s) => ({
      selectedKey: key,
      anchorKey: key,
      checked: [],
      focus: { field: null, nonce: s.focus.nonce }
    })),
  requestFocus: (field) => set((s) => ({ focus: { field, nonce: s.focus.nonce + 1 } })),
  patchSession: (updated) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.key === updated.key ? updated : x)) })),
  upsertSession: (updated) =>
    set((s) =>
      s.sessions.some((x) => x.key === updated.key)
        ? { sessions: s.sessions.map((x) => (x.key === updated.key ? updated : x)) }
        : { sessions: [...s.sessions, updated] }
    )
}))
