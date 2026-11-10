// Back / Forward on the desktop: lib/nav-history.ts bound to the store and the
// window. One store subscription records every move, wherever it came from (the
// sidebar, the palette, a notification), so nothing that navigates has to know
// about history. Going back puts the screen, the selection and the scroll
// position back; a session that no longer exists is skipped.

import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { PROVIDER_LABEL, type ProviderId, type ProviderView } from '@shared/provider'
import { SOURCE_LABELS, type SourceLabel } from '@shared/source-label'
import type { SessionSummary } from '@shared/types'
import { api } from './api'
import { envLabel, projectKey } from './filters'
import { useHotkeys } from './hotkeys'
import { NavHistory, type Direction, type NavState, type UsageTab } from './nav-history'
import { saveView } from './scope'
import { useApp, type State as AppState } from './store'

let history = new NavHistory()
/** The Settings section last linked to (the store's settingsSection clears itself once scrolled to). */
let lastSection: string | null = null
let amendPending = false
let flushQueued = false
/** Panes being scrolled back into place (their scroll events aren't recorded meanwhile). */
const restoring = new Set<string>()
let restoreToken = 0

/** Bumped whenever history changes, so the title bar's buttons follow. */
export const useNavVersion = create<{ version: number }>(() => ({ version: 0 }))
const bump = (): void => useNavVersion.setState((s) => ({ version: s.version + 1 }))

/** Start over (tests). */
export function resetNavigation(): void {
  history = new NavHistory()
  lastSection = null
  amendPending = false
  flushQueued = false
  restoring.clear()
  restoreToken++
  bump()
}

/** What's on screen now, as a history entry. */
export function snapshot(st: AppState = useApp.getState()): NavState {
  const key = st.selectedKey
  return {
    view: st.view,
    filters: st.filters,
    selectedKey: key,
    viewerTab: key && st.viewerTab.key === key ? st.viewerTab.tab : 'conversation',
    usageTab: st.usageTab,
    providerView: st.settings.providerView ?? 'all',
    settingsSection: st.view === 'settings' ? lastSection : null
  }
}

function flush(): void {
  flushQueued = false
  if (!useApp.getState().loaded) return
  const s = snapshot()
  if (amendPending) {
    amendPending = false
    history.amend(s)
    bump()
    return
  }
  if (history.record(s, performance.now()) !== 'none') {
    cancelRestore()
    bump()
  }
}

function queueFlush(): void {
  if (flushQueued) return
  flushQueued = true
  // Changes made together (a sidebar click sets the view and a filter) are one move.
  queueMicrotask(flush)
}

/**
 * Run an automatic change (selecting the first session at startup, or the first
 * visible one when a filter hides the selected one) as part of the current
 * entry instead of a move of its own.
 */
export function amendNavigation(fn: () => void): void {
  amendPending = true
  fn()
  queueFlush()
}

function onStore(st: AppState, prev: AppState): void {
  if (st.view !== 'settings') lastSection = null
  else if (st.settingsSection && st.settingsSection !== prev.settingsSection)
    lastSection = st.settingsSection
  if (
    st.loaded === prev.loaded &&
    st.view === prev.view &&
    st.filters === prev.filters &&
    st.selectedKey === prev.selectedKey &&
    st.viewerTab === prev.viewerTab &&
    st.usageTab === prev.usageTab &&
    st.settingsSection === prev.settingsSection &&
    st.settings.providerView === prev.settings.providerView
  )
    return
  queueFlush()
}

function sessionExists(key: string): boolean {
  return useApp.getState().sessions.some((s) => s.key === key)
}

/** An entry can be shown unless the session it was on is gone. */
export function validEntry(s: NavState): boolean {
  return s.view !== 'sessions' || !s.selectedKey || sessionExists(s.selectedKey)
}

/** A dialog, the palette or a menu is open: Back / Forward wait. */
export function navBlocked(): boolean {
  const st = useApp.getState()
  if (st.paletteOpen || st.shortcutsOpen || st.resume || st.summarize || st.branchIntro) return true
  return (
    typeof document !== 'undefined' &&
    !!document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
    )
  )
}

/** Go Back (-1) or Forward (1). Returns false when there's nowhere to go. */
export function navigate(dir: Direction): boolean {
  if (navBlocked()) return false
  flush()
  const entry = history.go(dir, validEntry, snapshot())
  if (!entry) return false
  const s = entry.state
  const st = useApp.getState()
  // A session that's gone (only possible here outside the session list) keeps the current one.
  const key = s.selectedKey && sessionExists(s.selectedKey) ? s.selectedKey : st.selectedKey
  const patch: Partial<AppState> = {
    view: s.view,
    filters: s.filters,
    selectedKey: key,
    viewerTab: { key, tab: s.viewerTab },
    usageTab: s.usageTab
  }
  if (key !== st.selectedKey) {
    patch.anchorKey = key
    patch.checked = []
  }
  // The search isn't part of history: if it would hide the session, it's cleared.
  if (key && st.hits && !st.hits.has(key) && st.query.trim()) {
    patch.query = ''
    patch.hits = null
    patch.sort = st.sortBeforeSearch
  }
  lastSection = s.view === 'settings' ? s.settingsSection : null
  // Never scrolled there: jump to the section like the link did.
  if (s.view === 'settings' && s.settingsSection && entry.scroll.main === undefined)
    patch.settingsSection = s.settingsSection
  st.set(patch)
  if (s.providerView !== (useApp.getState().settings.providerView ?? 'all'))
    saveView(s.providerView)
  // What's shown now is this entry (e.g. a gone session left out).
  history.amend(snapshot())
  bump()
  restoreScroll(entry.scroll)
  return true
}

function cancelRestore(): void {
  restoreToken++
  restoring.clear()
}

/**
 * Put the panes back where they were: the main pane (top if it never scrolled)
 * and the session list. A transcript loads after the screen shows, so this
 * waits up to 1.5 s for it to be tall enough; scrolling or clicking stops it.
 */
function restoreScroll(saved: Record<string, number>): void {
  cancelRestore()
  const token = restoreToken
  const targets = new Map<string, number>([['main', saved.main ?? 0]])
  if (saved.list !== undefined) targets.set('list', saved.list)
  for (const pane of targets.keys()) restoring.add(pane)
  const start = performance.now()
  let frames = 0
  const tick = (): void => {
    if (token !== restoreToken) return
    // Two frames first: the new screen (and the list's keep-selection-in-view) render.
    if (++frames > 2) {
      const late = performance.now() - start > 1500
      for (const [pane, top] of targets) {
        const el = document.querySelector<HTMLElement>(`[data-nav-scroll="${pane}"]`)
        if (!el) {
          if (late) targets.delete(pane)
          continue
        }
        if (el.scrollHeight - el.clientHeight >= top - 1 || late) {
          el.scrollTop = top
          history.setScroll(pane, el.scrollTop)
          targets.delete(pane)
          restoring.delete(pane)
        }
      }
    }
    if (targets.size) requestAnimationFrame(tick)
    else restoring.clear()
  }
  requestAnimationFrame(tick)
}

const DEDUPE_MS = 400
let lastMouseNav = -Infinity
let lastCommandNav = -Infinity

/** A mouse's side button (3 = Back, 4 = Forward). */
export function onMouseButton(e: MouseEvent): void {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  if (e.type !== 'mouseup') return
  const now = performance.now()
  // Windows may also send the same click as an app command.
  if (now - lastCommandNav < DEDUPE_MS) return
  lastMouseNav = now
  navigate(e.button === 3 ? -1 : 1)
}

/** Windows' Back / Forward app command (from the main process). */
export function onAppCommand(dir: 'back' | 'forward'): void {
  const now = performance.now()
  if (now - lastMouseNav < DEDUPE_MS) return
  lastCommandNav = now
  navigate(dir === 'back' ? -1 : 1)
}

function onScroll(e: Event): void {
  const el = e.target
  if (!(el instanceof HTMLElement)) return
  const pane = el.dataset.navScroll
  if (pane && !restoring.has(pane)) history.setScroll(pane, el.scrollTop)
}

function stopRestore(): void {
  if (restoring.size) cancelRestore()
}

const canNavigate = (): boolean => !navBlocked()

/**
 * Record moves for this window and handle Back / Forward from the keyboard
 * (Alt+← / Alt+→, Backspace; never while typing in a field) and the mouse's
 * side buttons. Mounted once, in App.
 */
export function useNavigation(): void {
  useHotkeys([
    { combo: 'alt+arrowleft', handler: () => navigate(-1), when: canNavigate },
    { combo: 'alt+arrowright', handler: () => navigate(1), when: canNavigate },
    { combo: 'backspace', handler: () => navigate(-1), when: canNavigate }
  ])
  useEffect(() => {
    const unsub = useApp.subscribe(onStore)
    queueFlush()
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('mousedown', onMouseButton, true)
    window.addEventListener('mouseup', onMouseButton, true)
    window.addEventListener('wheel', stopRestore, { capture: true, passive: true })
    window.addEventListener('pointerdown', stopRestore, true)
    const offCommand = api.onNavigate?.(onAppCommand)
    return () => {
      unsub()
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('mousedown', onMouseButton, true)
      window.removeEventListener('mouseup', onMouseButton, true)
      window.removeEventListener('wheel', stopRestore, true)
      window.removeEventListener('pointerdown', stopRestore, true)
      offCommand?.()
    }
  }, [])
}

const VISIBILITY: Record<string, string> = {
  visible: 'All sessions',
  all: 'All sessions',
  archived: 'Archived only',
  hidden: 'Hidden'
}
const USAGE_TABS: Record<UsageTab, string> = {
  trends: 'Trends',
  limits: 'Limit history',
  credits: 'Credits',
  raw: 'Raw table'
}
const SECTIONS: Record<string, string> = {
  accounts: 'Accounts & API credits',
  alerts: 'Session alerts',
  backup: 'Backup',
  'codex-usage': 'Codex usage & limits',
  context: 'Context size',
  git: 'Git',
  providers: 'Providers',
  summaries: 'Summaries'
}

function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

function providerLabel(v: ProviderView): string {
  return v === 'all' ? 'All agents' : (PROVIDER_LABEL[v as ProviderId] ?? v)
}

/** Where an entry leads, for the Back / Forward tooltips. */
export function describeEntry(
  s: NavState,
  sessions: Pick<SessionSummary, 'key' | 'title' | 'projectName' | 'cwd' | 'projectDir' | 'env'>[],
  shown?: NavState
): string {
  let text: string
  if (s.view === 'settings')
    text = s.settingsSection
      ? `Settings › ${SECTIONS[s.settingsSection] ?? s.settingsSection}`
      : 'Settings'
  else if (s.view === 'usage') text = `Usage & limits › ${USAGE_TABS[s.usageTab]}`
  else if (s.view === 'running') text = 'Running now'
  else {
    const f = s.filters
    const parts = [VISIBILITY[f.visibility] ?? 'All sessions']
    if (f.project) {
      const p = f.project
      const match = sessions.find((x) => projectKey(x) === p)
      parts.push(match?.projectName ?? p.split(/[\\/]/).filter(Boolean).pop() ?? p)
    }
    if (f.env) parts.push(envLabel(f.env))
    if (f.source) parts.push(SOURCE_LABELS[f.source as SourceLabel] ?? f.source)
    if (f.tag) parts.push(`#${f.tag}`)
    if (f.date) parts.push('date range')
    text = parts.join(' · ')
    const session = s.selectedKey ? sessions.find((x) => x.key === s.selectedKey) : undefined
    if (session) {
      text += ` › ${cut(session.title, 48)}`
      if (s.viewerTab === 'changes') text += ' (Changes)'
    }
  }
  if (shown && shown.providerView !== s.providerView)
    text = `${providerLabel(s.providerView)}: ${text}`
  return text
}

/** The title bar's Back / Forward: where each leads (null: nowhere). */
export function useNavTargets(): { back: string | null; forward: string | null } {
  const version = useNavVersion((s) => s.version)
  const sessions = useApp((s) => s.sessions)
  return useMemo(() => {
    void version
    const shown = snapshot()
    const label = (dir: Direction): string | null => {
      const e = history.peek(dir, validEntry, shown)
      return e ? describeEntry(e.state, sessions, shown) : null
    }
    return { back: label(-1), forward: label(1) }
  }, [version, sessions])
}

/** For tests: the recorded states, and where the current one is. */
export function navDebug(): { states: NavState[]; position: number } {
  return { states: history.list(), position: history.position }
}
