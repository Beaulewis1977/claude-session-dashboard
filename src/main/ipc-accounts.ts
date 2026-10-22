// IPC for API keys, credit grants and Admin API reports (Phase 5).

import { BrowserWindow, ipcMain } from 'electron'
import type { AccountsService } from './services/accounts'
import { creditsState, type CreditsDeps } from './services/credits'

export function registerAccountsIpc(deps: CreditsDeps & { accounts: AccountsService }): void {
  const { accounts } = deps
  const send = (): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('credits:changed')
  }
  accounts.on('changed', send)

  ipcMain.handle('credits:state', () => creditsState(deps))
  ipcMain.handle('accounts:add', async (_e, nickname, key) => {
    // The key is only passed through; it's never logged or returned.
    const res = await accounts.add(String(nickname ?? ''), String(key ?? ''))
    return res.error ? { error: res.error } : { account: res.account }
  })
  ipcMain.handle('accounts:rename', (_e, id, nickname) =>
    accounts.rename(String(id), String(nickname))
  )
  ipcMain.handle('accounts:remove', (_e, id) => accounts.remove(String(id)))
  ipcMain.handle('grants:add', (_e, grant) => accounts.addGrant(grant))
  ipcMain.handle('grants:remove', (_e, id) => accounts.removeGrant(String(id)))
  ipcMain.handle('admin:refresh', (_e, id) => accounts.refreshAdmin(String(id)))
}
