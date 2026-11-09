// Settings → "Start with Windows (minimized to tray)": off by default. Uses
// Electron's login item API, which on Windows writes or removes only this
// app's own value under HKCU\...\CurrentVersion\Run (and its own
// StartupApproved entry). Nothing else in Windows startup is touched, and the
// state shown is always read back from Windows, never remembered by the app.
//
// Installed and portable builds only: in development it would register
// electron.exe. The portable exe runs from a temporary copy, so the file
// that was started (PORTABLE_EXECUTABLE_FILE) is registered instead.

import { execFile } from 'node:child_process'
import type { StartWithWindows } from '@shared/types'
import { systemExe } from './core/which'

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
  /**
   * The command line in the app's own Run value (undefined: none). Electron's
   * launchItems only list entries for the path asked about, so another copy's
   * entry (installed vs portable) is only seen here.
   */
  readRunValue?: (name: string) => Promise<string | undefined>
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** `reg query <Run> /v <name>` (read only): the value's command line, or undefined. */
export function regRunValue(name: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(
      systemExe('reg.exe'),
      ['query', RUN_KEY, '/v', name],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? undefined : parseRegValue(String(stdout), name))
    )
  )
}

/** The data of value `name` in `reg query` output (REG_SZ or REG_EXPAND_SZ). */
export function parseRegValue(out: string, name: string): string | undefined {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{4}(REG_SZ|REG_EXPAND_SZ)\s{4}(.*)$/.exec(line)
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[3].trim()
  }
  return undefined
}

/** The program a Run command line starts: `"C:\…\app.exe" --hidden` → `C:\…\app.exe`. */
export function runCommandExe(cmd: string): string | undefined {
  const c = cmd.trim()
  if (c.startsWith('"')) {
    const end = c.indexOf('"', 1)
    return end > 1 ? c.slice(1, end) : undefined
  }
  return /^(.+?\.exe)(?:\s|$)/i.exec(c)?.[1]
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

export async function startWithWindows(
  app: LoginItemApp,
  e: LoginItemEnv
): Promise<StartWithWindows> {
  const t = loginTarget(app, e)
  if ('reason' in t) return { supported: false, on: false, reason: t.reason }
  const s = app.getLoginItemSettings(t)
  const mine = (s.launchItems ?? []).find(
    (i) => i.name === LOGIN_ITEM_NAME && samePath(i.path, t.path)
  )
  const on = s.openAtLogin || !!mine
  // The app's own Run value pointing at another copy (e.g. the portable exe).
  const registered = on
    ? undefined
    : await (e.readRunValue ?? regRunValue)(LOGIN_ITEM_NAME).then(
        (v) => (v ? runCommandExe(v) : undefined),
        () => undefined
      )
  const other = registered && !samePath(registered, t.path) ? registered : undefined
  return {
    supported: true,
    on,
    // Turned off in Task Manager → Startup (Windows then skips it).
    ...(on && (mine?.enabled === false || s.executableWillLaunchAtLogin === false)
      ? { disabledInTaskManager: true }
      : {}),
    // Registered for another copy of the app (e.g. the portable one).
    ...(other ? { otherCopy: other } : {})
  }
}

export async function setStartWithWindows(
  app: LoginItemApp,
  e: LoginItemEnv,
  on: boolean
): Promise<StartWithWindows> {
  const t = loginTarget(app, e)
  if ('reason' in t) return { supported: false, on: false, reason: t.reason }
  app.setLoginItemSettings({ openAtLogin: on, ...t, name: LOGIN_ITEM_NAME, enabled: on })
  return startWithWindows(app, e)
}
