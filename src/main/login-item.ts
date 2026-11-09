// Settings → "Start with Windows (minimized to tray)": off by default. Uses
// Electron's login item API, which on Windows writes or removes only this
// app's own value under HKCU\...\CurrentVersion\Run (and its own
// StartupApproved entry). Nothing else in Windows startup is touched, and the
// state shown is always read back from Windows, never remembered by the app.
//
// Installed and portable builds only: in development it would register
// electron.exe. The portable exe runs from a temporary copy, so the file
// that was started (PORTABLE_EXECUTABLE_FILE) is registered instead.

import type { StartWithWindows } from '@shared/types'

/** The Run value's name: fixed, so it never depends on the app's AppUserModelID. */
export const LOGIN_ITEM_NAME = 'Claude Session Dashboard'
/** Started at login: no window, just the tray icon. */
export const HIDDEN_ARG = '--hidden'

interface LaunchItem {
  name: string
  path: string
  args: string[]
  enabled: boolean
}

export interface LoginItemApp {
  isPackaged: boolean
  getLoginItemSettings(o: { path: string; args: string[] }): {
    openAtLogin: boolean
    executableWillLaunchAtLogin?: boolean
    launchItems?: LaunchItem[]
  }
  setLoginItemSettings(o: {
    openAtLogin: boolean
    path: string
    args: string[]
    name: string
    enabled?: boolean
  }): void
}

export interface LoginItemEnv {
  platform: NodeJS.Platform
  execPath: string
  /** process.env: PORTABLE_EXECUTABLE_FILE for the portable build. */
  env: NodeJS.ProcessEnv
}

/** What to register (undefined: not offered here, with why). */
export function loginTarget(
  app: LoginItemApp,
  e: LoginItemEnv
): { path: string; args: string[] } | { reason: string } {
  if (e.platform !== 'win32') return { reason: 'Only on Windows.' }
  if (!app.isPackaged)
    return { reason: 'Only in the installed or portable app (not while developing).' }
  const portable = e.env.PORTABLE_EXECUTABLE_FILE
  return { path: portable && /\.exe$/i.test(portable) ? portable : e.execPath, args: [HIDDEN_ARG] }
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function startWithWindows(app: LoginItemApp, e: LoginItemEnv): StartWithWindows {
  const t = loginTarget(app, e)
  if ('reason' in t) return { supported: false, on: false, reason: t.reason }
  const s = app.getLoginItemSettings(t)
  const ours = (s.launchItems ?? []).filter((i) => i.name === LOGIN_ITEM_NAME)
  const mine = ours.find((i) => samePath(i.path, t.path))
  const on = s.openAtLogin || !!mine
  return {
    supported: true,
    on,
    // Turned off in Task Manager → Startup (Windows then skips it).
    ...(on && (mine?.enabled === false || s.executableWillLaunchAtLogin === false)
      ? { disabledInTaskManager: true }
      : {}),
    // Registered for another copy of the app (e.g. the portable one).
    ...(!on && ours.length ? { otherCopy: ours[0].path } : {})
  }
}

export function setStartWithWindows(
  app: LoginItemApp,
  e: LoginItemEnv,
  on: boolean
): StartWithWindows {
  const t = loginTarget(app, e)
  if ('reason' in t) return { supported: false, on: false, reason: t.reason }
  app.setLoginItemSettings({ openAtLogin: on, ...t, name: LOGIN_ITEM_NAME, enabled: on })
  return startWithWindows(app, e)
}
