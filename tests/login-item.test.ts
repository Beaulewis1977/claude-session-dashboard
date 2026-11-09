// Settings → "Start with Windows (minimized to tray)": only this app's own
// login item, read back from Windows, only in the installed or portable app.

import { describe, expect, it } from 'vitest'
import {
  HIDDEN_ARG,
  LOGIN_ITEM_NAME,
  parseRegValue,
  runCommandExe,
  setStartWithWindows,
  startWithWindows,
  type LoginItemApp,
  type LoginItemEnv
} from '../src/main/login-item'

const EXE =
  'C:\\Users\\me\\AppData\\Local\\Programs\\Claude Session Dashboard\\Claude Session Dashboard.exe'

/**
 * Like Electron 45 on Windows: one Run value per name (`"path" args`), plus
 * StartupApproved per name. getLoginItemSettings({ path }) lists only the
 * entries for that exact path, so another copy's entry is never in it.
 */
function fakeWindows(isPackaged = true) {
  const run = new Map<string, { path: string; args: string[]; enabled: boolean }>()
  // Another program's own startup entry: never touched.
  run.set('OneDrive', { path: 'C:\\OneDrive.exe', args: ['/background'], enabled: true })
  const calls: unknown[] = []
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const app: LoginItemApp = {
    isPackaged,
    getLoginItemSettings: ({ path, args }) => {
      const items = [...run]
        .filter(([, v]) => same(v.path, path))
        .map(([name, v]) => ({ name, ...v }))
      const mine = run.get(LOGIN_ITEM_NAME)
      const openAtLogin = !!mine && same(mine.path, path) && mine.args.join(' ') === args.join(' ')
      return {
        openAtLogin,
        executableWillLaunchAtLogin: openAtLogin && mine!.enabled,
        launchItems: items
      }
    },
    setLoginItemSettings: (o) => {
      calls.push(o)
      if (o.openAtLogin) run.set(o.name, { path: o.path, args: o.args, enabled: o.enabled ?? true })
      else run.delete(o.name)
    }
  }
  // What `reg query HKCU\...\Run /v <name>` reads.
  const readRunValue = async (name: string) => {
    const v = run.get(name)
    return v ? `"${v.path}" ${v.args.join(' ')}`.trim() : undefined
  }
  return { app, run, calls, readRunValue }
}

function env(
  w: { readRunValue: LoginItemEnv['readRunValue'] },
  extra: NodeJS.ProcessEnv = {}
): LoginItemEnv {
  return { platform: 'win32', execPath: EXE, env: extra, readRunValue: w.readRunValue }
}

describe('Start with Windows', () => {
  it('is off by default, and on/off changes only its own entry', async () => {
    const w = fakeWindows()
    expect(await startWithWindows(w.app, env(w))).toEqual({ supported: true, on: false })
    expect(await setStartWithWindows(w.app, env(w), true)).toEqual({ supported: true, on: true })
    expect(w.calls).toEqual([
      { openAtLogin: true, path: EXE, args: [HIDDEN_ARG], name: LOGIN_ITEM_NAME, enabled: true }
    ])
    expect(w.run.get('OneDrive')).toEqual({
      path: 'C:\\OneDrive.exe',
      args: ['/background'],
      enabled: true
    })
    expect(await setStartWithWindows(w.app, env(w), false)).toEqual({ supported: true, on: false })
    expect([...w.run.keys()]).toEqual(['OneDrive'])
  })

  it('registers the portable exe that was started, not its temporary copy', async () => {
    const w = fakeWindows()
    const portable = 'D:\\Tools\\ClaudeSessionDashboard-Portable-1.14.0.exe'
    await setStartWithWindows(
      w.app,
      { ...env(w, { PORTABLE_EXECUTABLE_FILE: portable }), execPath: 'C:\\Temp\\2abc\\app.exe' },
      true
    )
    expect(w.calls[0]).toMatchObject({ path: portable, args: ['--hidden'] })
  })

  it('reads the state from Windows: turned off in Task Manager', async () => {
    const w = fakeWindows()
    await setStartWithWindows(w.app, env(w), true)
    w.run.get(LOGIN_ITEM_NAME)!.enabled = false
    expect(await startWithWindows(w.app, env(w))).toEqual({
      supported: true,
      on: true,
      disabledInTaskManager: true
    })
  })

  it('sees when another copy (e.g. the portable exe) holds the startup entry', async () => {
    const w = fakeWindows()
    const portable = 'D:\\Tools\\ClaudeSessionDashboard-Portable-1.14.0.exe'
    // The portable copy turned it on.
    await setStartWithWindows(w.app, { ...env(w, { PORTABLE_EXECUTABLE_FILE: portable }) }, true)
    // The installed copy asks: Electron lists nothing for its own path…
    expect(w.app.getLoginItemSettings({ path: EXE, args: [HIDDEN_ARG] }).launchItems).toEqual([])
    // …but the app's named Run value says who holds it.
    expect(await startWithWindows(w.app, env(w))).toEqual({
      supported: true,
      on: false,
      otherCopy: portable
    })
    // Turning it on here moves it to this copy.
    expect(await setStartWithWindows(w.app, env(w), true)).toEqual({ supported: true, on: true })
    expect(w.run.get(LOGIN_ITEM_NAME)?.path).toBe(EXE)
  })

  it('is never offered in development or off Windows (nothing is written or read)', async () => {
    const dev = fakeWindows(false)
    expect(await setStartWithWindows(dev.app, env(dev), true)).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/installed or portable/)
    })
    const mac = fakeWindows()
    expect(
      await setStartWithWindows(mac.app, { ...env(mac), platform: 'darwin' }, true)
    ).toMatchObject({ supported: false })
    expect([...dev.calls, ...mac.calls]).toEqual([])
  })
})

describe('reading the Run value', () => {
  it('parses reg.exe output as Windows prints it', () => {
    // Captured from `reg query "HKCU\Control Panel\Desktop" /v ScreenSaveActive`.
    const out =
      '\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    ScreenSaveActive    REG_SZ    1\r\n\r\n'
    expect(parseRegValue(out, 'ScreenSaveActive')).toBe('1')
    const run = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ${LOGIN_ITEM_NAME}    REG_SZ    "${EXE}" --hidden\r\n`
    expect(parseRegValue(run, LOGIN_ITEM_NAME)).toBe(`"${EXE}" --hidden`)
    expect(parseRegValue(run, 'OneDrive')).toBeUndefined()
  })

  it('finds the program in a Run command line, quoted or not', () => {
    expect(runCommandExe(`"${EXE}" --hidden`)).toBe(EXE)
    expect(runCommandExe('D:\\Tools\\App.exe --hidden')).toBe('D:\\Tools\\App.exe')
    expect(runCommandExe('"unterminated')).toBeUndefined()
  })
})
