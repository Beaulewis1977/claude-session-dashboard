// IPC for Settings → Backup (desktop only: a phone can't reach any of these,
// see mobile/rpc.ts).

import { BrowserWindow, dialog, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { isBackupError } from '@shared/backup'
import { handle } from './ipc-guard'
import { isInside } from './core/safe-paths'
import type { BackupService } from './services/backup'

export interface BackupIpcDeps {
  backup: BackupService
  dataDir: string
  /** After a restore was staged: restart the app so it's applied. */
  restart: () => void
  /** False in development, where the app can only quit (start it again by hand). */
  canRelaunch: boolean
}

const str = (v: unknown, max = 4096): string => (typeof v === 'string' ? v.slice(0, max) : '')
const pass = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 1024 ? v : undefined

export function registerBackupIpc(deps: BackupIpcDeps): void {
  const { backup } = deps
  backup.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('backup:changed')
  })
  const win = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0]

  handle('backup:status', () => backup.status())
  handle('backup:pickFolder', async () => {
    const w = win()
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose where to keep backups',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    const folder = res.filePaths[0]
    if (res.canceled || !folder) return null
    return backup.candidate(folder)
  })
  handle('backup:connect', (_e, folder, opts) => {
    const o = (opts ?? {}) as Record<string, unknown>
    return backup.connect(str(folder), {
      encrypt: o.encrypt === true,
      password: pass(o.password),
      remember: o.remember === true,
      accept: o.accept === true
    })
  })
  handle('backup:takeOver', () => backup.takeOver())
  handle('backup:disconnect', () => backup.disconnect())
  handle('backup:update', (_e, patch) => {
    const p = (patch ?? {}) as Record<string, unknown>
    return backup.update({ schedule: p.schedule, keep: p.keep })
  })
  handle('backup:run', () => backup.runNow('manual'))
  handle('backup:setPassword', (_e, password, remember) =>
    backup.setPassword(password === null ? null : (pass(password) ?? ''), remember === true)
  )
  handle('backup:unlock', (_e, password, remember) =>
    backup.unlock(pass(password) ?? '', remember === true)
  )
  handle('backup:forget', () => backup.forget())
  handle('backup:snapshots', () => backup.snapshots())
  handle('backup:preview', (_e, id, password) => backup.preview(str(id, 100), pass(password)))
  handle('backup:restore', async (_e, token) => {
    const r = await backup.restore(str(token, 100))
    if (isBackupError(r)) return r
    // Answer first, so the window can say what happens next; then restart.
    setTimeout(() => deps.restart(), 2500)
    return { ...r, relaunch: deps.canRelaunch }
  })
  handle('backup:openFolder', async () => {
    const st = await backup.status()
    if (st.setDir && (await stat(st.setDir).catch(() => undefined))?.isDirectory())
      await shell.openPath(st.setDir)
  })
  handle('backup:openSafety', async () => {
    const dir = (await backup.status()).lastRestore?.safetyDir
    // Only ever the app's own folder.
    if (dir && isInside(dir, deps.dataDir) && (await stat(dir).catch(() => undefined)))
      await shell.openPath(dir)
  })
}
