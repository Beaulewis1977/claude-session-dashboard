// IPC for git links (the viewer's Changes tab, Settings → Git).

import { BrowserWindow } from 'electron'
import { sanitizeGitSettings } from '@shared/git/types'
import type { JsonStore } from './core/json-store'
import { handle } from './ipc-guard'
import type { GitLinksService } from './git/service'
import type { SettingsFile } from './services/store'

export interface GitIpcDeps {
  git: GitLinksService
  settings: JsonStore<SettingsFile>
  onSettingsChanged?: () => void
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

const key = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 300) throw new Error('Expected a session key')
  return v
}
const sha = (v: unknown): string => {
  if (typeof v !== 'string' || !SHA.test(v)) throw new Error('Expected a commit SHA')
  return v
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const { git, settings } = deps
  git.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('git:changed')
  })
  handle('git:session', (_e, k) => git.view(key(k)))
  handle('git:diff', (_e, k, s, path, all) =>
    git.diff(
      key(k),
      sha(s),
      typeof path === 'string' && path.length <= 4096 ? path : undefined,
      all === true
    )
  )
  handle('git:unlink', (_e, k, s) => git.unlink(key(k), sha(s)))
  handle('git:relink', (_e, k, s) => git.relink(key(k), sha(s)))
  handle('git:refresh', async (_e, k) => {
    await git.refresh(typeof k === 'string' ? key(k) : undefined)
  })
  handle('git:status', () => git.status())
  // Settings → Git and the Changes tab's one-time question. Desktop only (not on a phone's allow-list).
  handle('git:settings', async (_e, patch) => {
    settings.update((s) => {
      s.gitLinks = sanitizeGitSettings({ ...sanitizeGitSettings(s.gitLinks), ...(patch ?? {}) })
    })
    git.settingsChanged()
    deps.onSettingsChanged?.()
    return git.status()
  })
}
