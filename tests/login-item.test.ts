// Settings → "Start with Windows (minimized to tray)": only this app's own
// login item, read back from Windows, only in the installed or portable app.

import { describe, expect, it } from 'vitest'
import {
  HIDDEN_ARG,
  LOGIN_ITEM_NAME,
  setStartWithWindows,
  startWithWindows,
  type LoginItemApp
} from '../src/main/login-item'

const EXE =
  'C:\\Users\\me\\AppData\\Local\\Programs\\Claude Session Dashboard\\Claude Session Dashboard.exe'

/** Like Electron on Windows: one Run value per name; StartupApproved per name. */
function fakeApp(isPackaged = true) {
  const run = new Map<string, { path: string; args: string[]; enabled: boolean }>()
  // Another program's own startup entry: never touched.
  run.set('OneDrive', { path: 'C:\\OneDrive.exe', args: ['/background'], enabled: true })
  const calls: unknown[] = []
  const app: LoginItemApp = {
    isPackaged,
    getLoginItemSettings: ({ path, args }) => {
      const mine = run.get(LOGIN_ITEM_NAME)
      const openAtLogin =
        !!mine &&
        mine.path.toLowerCase() === path.toLowerCase() &&
        mine.args.join(' ') === args.join(' ')
      return {
        openAtLogin,
        executableWillLaunchAtLogin: openAtLogin && mine!.enabled,
        launchItems: [...run].map(([name, v]) => ({ name, ...v }))
      }
    },
    setLoginItemSettings: (o) => {
      calls.push(o)
      if (o.openAtLogin) run.set(o.name, { path: o.path, args: o.args, enabled: o.enabled ?? true })
      else run.delete(o.name)
    }
  }
  return { app, run, calls }
}

const env = (extra: NodeJS.ProcessEnv = {}) => ({
  platform: 'win32' as const,
  execPath: EXE,
  env: extra
})

describe('Start with Windows', () => {
  it('is off by default, and on/off changes only its own entry', () => {
    const { app, run, calls } = fakeApp()
    expect(startWithWindows(app, env())).toEqual({ supported: true, on: false })
    expect(setStartWithWindows(app, env(), true)).toEqual({ supported: true, on: true })
    expect(calls).toEqual([
      { openAtLogin: true, path: EXE, args: [HIDDEN_ARG], name: LOGIN_ITEM_NAME, enabled: true }
    ])
    expect(run.get('OneDrive')).toEqual({
      path: 'C:\\OneDrive.exe',
      args: ['/background'],
      enabled: true
    })
    expect(setStartWithWindows(app, env(), false)).toEqual({ supported: true, on: false })
    expect([...run.keys()]).toEqual(['OneDrive'])
  })

  it('registers the portable exe that was started, not its temporary copy', () => {
    const { app, calls } = fakeApp()
    const portable = 'D:\\Tools\\ClaudeSessionDashboard-Portable-1.14.0.exe'
    setStartWithWindows(
      app,
      { ...env({ PORTABLE_EXECUTABLE_FILE: portable }), execPath: 'C:\\Temp\\2abc\\app.exe' },
      true
    )
    expect(calls[0]).toMatchObject({ path: portable, args: ['--hidden'] })
  })

  it('reads the state from Windows: turned off in Task Manager, or set for another copy', () => {
    const { app, run } = fakeApp()
    setStartWithWindows(app, env(), true)
    run.get(LOGIN_ITEM_NAME)!.enabled = false
    expect(startWithWindows(app, env())).toEqual({
      supported: true,
      on: true,
      disabledInTaskManager: true
    })
    run.set(LOGIN_ITEM_NAME, { path: 'D:\\Portable.exe', args: ['--hidden'], enabled: true })
    expect(startWithWindows(app, env())).toEqual({
      supported: true,
      on: false,
      otherCopy: 'D:\\Portable.exe'
    })
  })

  it('is never offered in development or off Windows (nothing is written)', () => {
    const dev = fakeApp(false)
    expect(setStartWithWindows(dev.app, env(), true)).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/installed or portable/)
    })
    const mac = fakeApp()
    expect(setStartWithWindows(mac.app, { ...env(), platform: 'darwin' }, true)).toMatchObject({
      supported: false
    })
    expect([...dev.calls, ...mac.calls]).toEqual([])
  })
})
