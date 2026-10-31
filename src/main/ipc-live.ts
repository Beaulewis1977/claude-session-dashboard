// IPC for "Running now" and session alerts.

import { BrowserWindow } from 'electron'
import { focusTerminal } from './core/focus'
import { handle } from './ipc-guard'
import type { HooksInstaller } from './services/hooks'
import type { LiveService } from './services/live'
import type { SessionService } from './services/sessions'

export interface LiveIpcDeps {
  live: LiveService
  hooks: HooksInstaller
  sessions: SessionService
  fixtures: boolean
}

export function registerLiveIpc(deps: LiveIpcDeps): void {
  const { live, hooks, sessions } = deps
  live.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('live:changed')
  })

  const source = (id: unknown) => {
    const src = sessions.source(String(id))
    if (!src) throw new Error('Unknown environment')
    return src
  }
  const action = (v: unknown): 'install' | 'uninstall' =>
    v === 'uninstall' ? 'uninstall' : 'install'

  handle('live:state', () => live.snapshot())
  handle('live:resolveRef', (_e, ref) => live.resolveRef(ref))
  handle('hooks:plan', (_e, id, a) => hooks.plan(source(id), action(a)))
  handle('hooks:apply', async (_e, id, a, token) => {
    const res = await hooks.apply(source(id), action(a), String(token))
    await live.refreshHooks()
    return res
  })
  handle('live:focus', async (_e, key) => {
    const k = String(key)
    const s = live.snapshot().sessions.find((x) => x.key === k)
    if (!s || s.state === 'exited')
      return { ok: false, error: 'This session isn’t running any more.' }
    const summary = sessions.get(k)
    return focusTerminal(
      {
        // Only a Windows PID means anything to Windows; a WSL session is found by its title.
        pid: s.env === 'windows' ? s.pid : undefined,
        titles: [s.name, summary?.claudeName, summary?.title, summary?.summary].filter(
          (t): t is string => !!t
        )
      },
      { simulate: deps.fixtures }
    )
  })
}
