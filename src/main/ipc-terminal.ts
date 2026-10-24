// Settings → Terminal access (SSH), and "Open terminal here": IPC for the
// desktop window. Only `terminal:phoneInfo` is on the phone's allow-list
// (mobile/rpc.ts); a phone can never make or undo a change from here.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import type { TerminalAction } from '@shared/terminal'
import { handle } from './ipc-guard'
import type { Launcher } from './services/launcher'
import type { TerminalService } from './terminal/service'

export interface TerminalIpcDeps {
  terminal: TerminalService
  launcher: Launcher
  dataDir: string
}

const SHELLS = ['pwsh', 'powershell', 'wsl'] as const

/** What the window asked for, or undefined if it isn't exactly one of the known changes. */
export function parseAction(v: unknown): TerminalAction | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  switch (o.kind) {
    case 'install':
    case 'uninstall':
    case 'service-on':
    case 'service-undo':
    case 'firewall-add':
    case 'firewall-remove':
    case 'default-rule-disable':
    case 'default-rule-restore':
    case 'shell-restore':
    case 'key-pending':
    case 'password-off':
    case 'password-restore':
      return { kind: o.kind }
    case 'shell-set':
      return SHELLS.includes(o.shell as (typeof SHELLS)[number])
        ? { kind: 'shell-set', shell: o.shell as (typeof SHELLS)[number] }
        : undefined
    case 'key-add':
      return typeof o.key === 'string' && o.key.length <= 16_000
        ? { kind: 'key-add', key: o.key }
        : undefined
    case 'key-remove':
      return typeof o.fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(o.fingerprint)
        ? { kind: 'key-remove', fingerprint: o.fingerprint }
        : undefined
    case 'turn-off':
      return {
        kind: 'turn-off',
        uninstall: o.uninstall === true,
        removeKeys: o.removeKeys === true
      }
    default:
      return undefined
  }
}

export function registerTerminalIpc(deps: TerminalIpcDeps): void {
  const { terminal } = deps
  terminal.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('terminal:changed')
  })

  handle('terminal:status', () => terminal.status())
  handle('terminal:prepare', (_e, a) => {
    const action = parseAction(a)
    return action ? terminal.prepare(action) : { error: 'Unknown change.' }
  })
  handle('terminal:apply', (_e, token) => terminal.apply(typeof token === 'string' ? token : ''))
  handle('terminal:history', () => terminal.history())
  handle('terminal:listen', (_e, on) => terminal.listen(on === true))
  handle('terminal:rejectKey', () => terminal.rejectPending())
  handle('terminal:diagnostics', () => terminal.diagnostics())
  handle('terminal:openBackups', async () => {
    const dir = join(deps.dataDir, 'terminal-backups')
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  // Read by a paired phone through the allow-list: where to connect, nothing else.
  handle('terminal:phoneInfo', () => terminal.phoneInfo())
  handle('terminal:openHere', (_e, key) => {
    if (typeof key !== 'string') throw new Error('key must be a string')
    return deps.launcher.openShell(key)
  })
}
