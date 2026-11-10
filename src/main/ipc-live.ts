// IPC for "Running now" and session alerts.

import { BrowserWindow } from 'electron'
import type { FocusResult } from '@shared/live'
import { providerOf } from '@shared/provider'
import { fileHolders, focusTerminal } from './core/focus'
import { handle } from './ipc-guard'
import type { CodexHooksInstaller } from './services/codex-hooks'
import type { HooksInstaller } from './services/hooks'
import type { LiveService } from './services/live'
import type { SessionService } from './services/sessions'

export interface LiveIpcDeps {
  live: LiveService
  hooks: HooksInstaller
  /** Codex's opt-in PermissionRequest hook (hooks.json). */
  codexHooks: CodexHooksInstaller
  sessions: SessionService
  fixtures: boolean
}

export function registerLiveIpc(deps: LiveIpcDeps): void {
  const { live, hooks, codexHooks, sessions } = deps
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
  // A Codex home's alerts change its hooks.json; a Claude home's, its settings.json.
  const installerOf = (src: ReturnType<typeof source>) =>
    providerOf(src) === 'codex' ? codexHooks : hooks

  handle('live:state', () => live.snapshot())
  handle('hooks:plan', (_e, id, a) => {
    const src = source(id)
    return installerOf(src).plan(src, action(a))
  })
  handle('hooks:apply', async (_e, id, a, token) => {
    const src = source(id)
    const res = await installerOf(src).apply(src, action(a), String(token))
    await live.refreshHooks()
    return res
  })
  handle('live:focus', (_e, key) => focusLive(deps, String(key)))
}

/**
 * "Focus terminal": bring a running session's terminal forward (the desktop's
 * button, and a phone's "Focus terminal on PC"). Nothing is started or typed.
 */
export async function focusLive(
  deps: Pick<LiveIpcDeps, 'live' | 'sessions' | 'fixtures'>,
  k: string
): Promise<FocusResult> {
  const { live, sessions } = deps
  const s = live.snapshot().sessions.find((x) => x.key === k)
  if (!s || s.state === 'exited')
    return { ok: false, error: 'This session isn’t running any more.' }
  const summary = sessions.get(k)
  let pid = s.env === 'windows' ? s.pid : undefined
  // A Windows Codex thread: the process holding its lock is the one to bring forward
  // (Restart Manager, read only; see core/focus.ts).
  if (s.provider === 'codex' && s.env === 'windows' && !deps.fixtures) {
    const lock = live.codexLockPath(k)
    if (lock) pid = (await fileHolders(lock))[0]?.pid
  }
  return focusTerminal(
    {
      // Only a Windows PID means anything to Windows; a WSL session is found by its title.
      pid,
      titles: [s.name, summary?.claudeName, summary?.title, summary?.summary].filter(
        (t): t is string => !!t
      )
    },
    { simulate: deps.fixtures }
  )
}
