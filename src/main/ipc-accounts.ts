// IPC for API keys, credit grants and Admin API reports (Phase 5).

import { BrowserWindow } from 'electron'
import { handle } from './ipc-guard'
import type { AccountsService } from './services/accounts'
import { creditsState, type CreditsDeps } from './services/credits'

export function registerAccountsIpc(deps: CreditsDeps & { accounts: AccountsService }): void {
  const { accounts } = deps
  const send = (): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('credits:changed')
  }
  accounts.on('changed', send)

  handle('credits:state', () => creditsState(deps))
  handle('accounts:add', async (_e, nickname, key) => {
    // The key is only passed through; it's never logged or returned.
    const res = await accounts.add(String(nickname ?? ''), String(key ?? ''))
    return res.error ? { error: res.error } : { account: res.account }
  })
  handle('accounts:rename', (_e, id, nickname) => accounts.rename(String(id), String(nickname)))
  handle('accounts:remove', (_e, id) => accounts.remove(String(id)))
  handle('grants:add', (_e, grant) => accounts.addGrant(grant))
  handle('grants:remove', (_e, id) => accounts.removeGrant(String(id)))
  handle('admin:refresh', (_e, id) => accounts.refreshAdmin(String(id)))
}
