// Session actions shared by buttons, menus, the command palette and shortcuts.

import { toast } from 'sonner'
import type { SessionMeta } from '@shared/types'
import { api } from './api'
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
    await api.copyText(which === 'launch' ? p.commandLine : p.claudeCommand)
    toast.success(which === 'launch' ? 'Resume command copied' : 'Claude command copied', {
      description: which === 'claude' && p.cwd ? `Run it from ${p.cwd}` : undefined
    })
  } catch (err) {
    toast.error('Could not build the command', { description: String((err as Error).message) })
  }
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

export function showFile(key: string): void {
  void api.showSessionFile(key)
}
