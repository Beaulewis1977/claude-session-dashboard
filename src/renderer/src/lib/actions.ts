// Session actions shared by buttons, menus, the command palette and shortcuts.

import { toast } from 'sonner'
import type { SessionDetail, SessionMeta, SessionSummary } from '@shared/types'
import { sessionToMarkdown } from '@shared/markdown'
import { canUseClaudeName } from '@shared/title'
import { api } from './api'
import { projectKey } from './filters'
import { useApp } from './store'

const get = () => useApp.getState()

export async function updateMeta(key: string, patch: Partial<SessionMeta>): Promise<void> {
  const updated = await api.updateMeta(key, patch)
  if (updated) get().patchSession(updated)
}

/** Imported claude.ai conversations can be read but not resumed. */
function viewOnly(key: string): boolean {
  if (get().sessions.find((s) => s.key === key)?.availability !== 'imported') return false
  toast('This conversation was imported from claude.ai', {
    description: 'It can be read, searched and exported, but not resumed in Claude Code.'
  })
  return true
}

export function openResume(key: string, fork: boolean): void {
  if (viewOnly(key)) return
  get().set({ resume: { key, fork } })
}

/**
 * Branch from a message. The first time, explain what it does (it adds a new
 * session file in Claude's project folder) before opening the launch dialog.
 */
export function openBranch(key: string, at: string, mode: 'include' | 'before' = 'include'): void {
  if (viewOnly(key)) return
  const branch = { at, mode }
  if (get().settings.branchConfirmed) get().set({ resume: { key, fork: false, branch } })
  else get().set({ branchIntro: { key, branch } })
}

/** Show a session that was just created (a branch) and open its rename box. */
export function showNewSession(s: SessionSummary): void {
  const st = get()
  st.upsertSession(s)
  // Make sure a search or filter doesn't hide it.
  if (st.query.trim()) st.set({ query: '', hits: null, sort: st.sortBeforeSearch })
  st.set({ view: 'sessions' })
  st.select(s.key)
  setTimeout(() => get().requestFocus('name'), 60)
}

/** Start a fresh Claude Code session in the same folder as `key`. */
export function openNewSession(key: string): void {
  if (viewOnly(key)) return
  get().set({ resume: { key, fork: false, newSession: true } })
}

export async function copyResumeCommand(
  key: string,
  which: 'launch' | 'claude' = 'launch'
): Promise<void> {
  if (viewOnly(key)) return
  const { settings } = get()
  try {
    const p = await api.previewLaunch({
      key,
      fork: false,
      skipPermissions: settings.skipPermissionsDefault
    })
    const text = which === 'launch' ? p.commandLine : p.claudeCommand
    if (!text) {
      toast.error('Could not build the command', { description: p.launchError })
      return
    }
    await api.copyText(text)
    toast.success(which === 'launch' ? 'Resume command copied' : 'Claude command copied', {
      description: which === 'claude' && p.cwd ? `Run it from ${p.cwd}` : undefined
    })
  } catch (err) {
    toast.error('Could not build the command', { description: String((err as Error).message) })
  }
}

/** Copies text from the viewer's copy buttons and confirms with a toast. */
export async function copyText(text: string, message = 'Copied ✓'): Promise<boolean> {
  try {
    await api.copyText(text)
    toast(message, { duration: 1500 })
    return true
  } catch (err) {
    toast.error("Couldn't copy, select the text manually", { description: (err as Error).message })
    return false
  }
}

/** The whole conversation as Markdown, the same text "Export to Markdown" writes. */
export function copyConversation(detail: SessionDetail, summary: SessionSummary): void {
  void copyText(sessionToMarkdown({ ...detail, summary }), 'Conversation copied ✓')
}

export async function copySessionId(sessionId: string): Promise<void> {
  await api.copyText(sessionId)
  toast.success('Session ID copied')
}

export async function exportMarkdown(key: string): Promise<void> {
  const res = await api.exportMarkdown(key)
  if (res.saved) toast.success('Exported to Markdown', { description: res.path })
  else if (res.error) toast.error('Export failed', { description: res.error })
}

export async function toggleHidden(key: string): Promise<void> {
  const s = get().sessions.find((x) => x.key === key)
  if (!s) return
  const hidden = !s.meta.hidden
  await updateMeta(key, { hidden })
  toast(hidden ? 'Session hidden' : 'Session visible again', {
    description: hidden ? 'Find it under "Hidden" in the sidebar.' : undefined,
    action: { label: 'Undo', onClick: () => void updateMeta(key, { hidden: !hidden }) }
  })
}

/**
 * "Use name from Claude Code": clear my dashboard names so the names given in
 * Claude Code (`/rename`) show. Only sessions that have one: a name with
 * nothing from Claude Code to fall back on stays. Nothing is written to
 * Claude's files.
 */
export async function applyClaudeNames(keys: string[]): Promise<void> {
  const st = get()
  const before = new Map(
    st.sessions
      .filter((s) => keys.includes(s.key) && canUseClaudeName(s))
      .map((s) => [s.key, s.meta.name!])
  )
  if (!before.size) {
    toast('Nothing to change', {
      description: 'These sessions already show their Claude Code name, or have none.'
    })
    return
  }
  const list = [...before.keys()]
  try {
    // One session: patched in place. Several: the list follows the change event.
    if (list.length === 1) await updateMeta(list[0], { name: '' })
    else await api.applyClaudeNames(list)
  } catch (err) {
    toast.error('Could not change the names', { description: (err as Error).message })
    return
  }
  const n = before.size
  toast(n === 1 ? 'Using the name from Claude Code' : `Using Claude Code names for ${n} sessions`, {
    action: {
      label: 'Undo',
      onClick: () => {
        for (const [key, name] of before) void updateMeta(key, { name })
      }
    }
  })
}

export async function togglePinned(key: string): Promise<void> {
  const s = get().sessions.find((x) => x.key === key)
  if (!s) return
  await updateMeta(key, { pinned: !s.meta.pinned })
}

/** A local terminal (Settings → Terminal) in the session's folder. No Claude, just a shell. */
export async function openTerminalHere(key: string): Promise<void> {
  try {
    const r = await api.openTerminalHere(key)
    if (!r.ok) toast.error('Could not open a terminal', { description: r.error })
    else if (r.simulated)
      toast('Fixtures mode: nothing was started', { description: r.commandLine })
  } catch (err) {
    toast.error('Could not open a terminal', { description: (err as Error).message })
  }
}

/** The most recent session in a project (its folder and environment open the terminal). */
export function projectSessionKey(projectKeyValue: string): string | undefined {
  const at = (s: SessionSummary): number => Date.parse(s.lastActivityAt ?? s.startedAt ?? '') || 0
  return get()
    .sessions.filter(
      (s) => s.availability !== 'imported' && s.cwd && projectKey(s) === projectKeyValue
    )
    .sort((a, b) => at(b) - at(a))[0]?.key
}

export function showFile(key: string): void {
  void api.showSessionFile(key)
}
