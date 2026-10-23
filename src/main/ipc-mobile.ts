// Settings → Phone: IPC for the desktop window only. None of these channels
// are on the phone's allow-list (mobile/rpc.ts), so a phone can never change
// pairing, the server, Tailscale or the firewall.

import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type { MobileSettings } from '@shared/mobile'
import type { JsonStore } from './core/json-store'
import { systemRoot } from './core/which'
import { handle } from './ipc-guard'
import type { MobileFile } from './mobile/devices'
import {
  firewallAddArgs,
  firewallCommandText,
  firewallDeleteArgs,
  firewallRuleExists,
  FIREWALL_RULE_NAME,
  runElevatedNetsh
} from './mobile/firewall'
import { findLink } from './mobile/tailscale'
import type { MobileService } from './mobile/service'

export const WINGET_TAILSCALE = 'winget install --id Tailscale.Tailscale -e --source winget'

export interface MobileIpcDeps {
  mobile: MobileService
  store: JsonStore<MobileFile>
  fixtures: boolean
}

const win = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0]

async function ask(message: string, detail: string, ok: string): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: [ok, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message,
    detail
  }
  const w = win()
  const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}

const powershell = (): string =>
  win32.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function registerMobileIpc(deps: MobileIpcDeps): void {
  const { mobile, store } = deps

  mobile.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mobile:changed')
  })

  /** Home Wi-Fi mode was left: offer to remove the firewall rule the app added. */
  const offerFirewallRemoval = async (): Promise<void> => {
    if (!store.value.firewallRule) return
    const args = firewallDeleteArgs()
    const yes = await ask(
      'Remove the home Wi-Fi firewall rule?',
      `Phone access over home Wi-Fi is off, so the rule the app added isn't needed. Windows will ask for administrator rights.\n\n${firewallCommandText(args)}`,
      'Remove rule'
    )
    if (!yes) return
    const r = deps.fixtures ? { ok: true } : await runElevatedNetsh(args)
    if (r.ok) {
      store.update((f) => {
        f.firewallRule = undefined
      })
      mobile.registry.log({
        action: 'firewall',
        detail: `Removed “${FIREWALL_RULE_NAME}”`,
        ok: true
      })
    }
  }

  handle('mobile:status', () => mobile.status())
  handle('mobile:update', async (_e, patch: Partial<MobileSettings>) => {
    const leavingLan = mobile.settings.mode === 'lan' && patch?.mode === 'tailscale'
    const st = await mobile.update(patch ?? {})
    if (leavingLan) await offerFirewallRemoval()
    return st
  })
  handle('mobile:start', () => mobile.start())
  handle('mobile:stop', async () => {
    const st = await mobile.stop()
    if (mobile.settings.mode === 'lan') await offerFirewallRemoval()
    return mobile.status(false).then((s) => ({ ...s, tailscale: st.tailscale }))
  })
  handle('mobile:retryServe', () => mobile.retryServe())
  handle('mobile:pair', () => mobile.startPairing())
  handle('mobile:cancelPair', () => mobile.cancelPairing())
  handle('mobile:revoke', (_e, id) => mobile.revoke(String(id)))
  handle('mobile:renameDevice', (_e, id, name) => mobile.rename(String(id), String(name)))
  handle('mobile:activity', () => mobile.activity(300))
  handle('mobile:sendTest', (_e, id) => mobile.sendTest(typeof id === 'string' ? id : undefined))
  handle('mobile:lanAddresses', () => mobile.lanAddresses())
  handle('mobile:claudeCheck', () => mobile.claudeCheck())
  handle('mobile:diagnostics', () => mobile.diagnostics())

  handle('mobile:firewallAdd', async () => {
    const s = mobile.settings
    const address = s.lanAddress
    if (!address) return { ok: false, error: 'Pick the network address first.' }
    let args: string[]
    try {
      args = firewallAddArgs(s.port, address, process.execPath)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    const yes = await ask(
      'Allow phones on your home Wi-Fi to connect?',
      `This adds one Windows Firewall rule: only this app, only port ${s.port} on ${address}, only from your local network, only when Windows treats the network as Private. Windows will ask for administrator rights. Turning home Wi-Fi mode off offers to remove it again.\n\n${firewallCommandText(args)}`,
      'Add rule'
    )
    if (!yes) return { ok: false, cancelled: true }
    const r = deps.fixtures ? { ok: true } : await runElevatedNetsh(args)
    if (r.ok) {
      store.update((f) => {
        f.firewallRule = { name: FIREWALL_RULE_NAME, port: s.port, address }
      })
      mobile.registry.log({ action: 'firewall', detail: `Added “${FIREWALL_RULE_NAME}”`, ok: true })
      mobile.changed()
    }
    return r
  })
  handle('mobile:firewallRemove', async () => {
    await offerFirewallRemoval()
    mobile.changed()
    return { ok: !store.value.firewallRule && !(await firewallRuleExists()) }
  })

  // ---------------------------------------------------------- Tailscale

  handle('mobile:tailscaleInstall', async () => {
    if (process.platform !== 'win32' || deps.fixtures) return { ok: false, error: 'Windows only.' }
    const yes = await ask(
      'Install Tailscale?',
      `A PowerShell window opens and runs:\n\n${WINGET_TAILSCALE}\n\nWindows may ask for administrator rights. When it's done, come back here and sign in.`,
      'Install'
    )
    if (!yes) return { ok: false, cancelled: true }
    // A fixed command: nothing from the user or a file reaches it.
    const child = spawn(
      powershell(),
      [
        '-NoProfile',
        '-Command',
        `Start-Process -FilePath '${powershell()}' -ArgumentList '-NoExit','-Command','${WINGET_TAILSCALE}'`
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    mobile.registry.log({
      action: 'tailscale',
      detail: 'Started installing Tailscale (winget)',
      ok: true
    })
    return { ok: true }
  })
  handle('mobile:tailscaleLogin', async () => {
    const r = await mobile.tailscale.loginLink()
    if (r.link && findLink(r.link) === r.link) {
      await shell.openExternal(r.link)
      return { ok: true, opened: true }
    }
    const gui = await mobile.tailscale.guiPath()
    if (gui) {
      spawn(gui, [], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, opened: false, app: true }
    }
    return { ok: false, error: r.error ?? 'Open the Tailscale app and sign in.' }
  })
  handle('mobile:openLink', async (_e, link) => {
    // Only Tailscale's own sign-in / approval pages.
    const l = typeof link === 'string' ? findLink(link) : undefined
    if (l && l === link) await shell.openExternal(l)
  })
}
