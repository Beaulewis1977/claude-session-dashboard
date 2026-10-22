import { contextBridge, ipcRenderer } from 'electron'
import type { CsdApi } from '@shared/api'
import type { SessionsPayload } from '@shared/types'

function on(channel: string, cb: () => void): () => void {
  const listener = (): void => cb()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CsdApi = {
  getInfo: () => ipcRenderer.invoke('app:info'),
  getSessions: () => ipcRenderer.invoke('sessions:list'),
  onSessionsChanged: (cb) => {
    const listener = (_e: unknown, payload: SessionsPayload): void => cb(payload)
    ipcRenderer.on('sessions:changed', listener)
    return () => ipcRenderer.removeListener('sessions:changed', listener)
  },
  getSession: (key) => ipcRenderer.invoke('sessions:get', key),
  search: (q) => ipcRenderer.invoke('sessions:search', q),
  updateMeta: (key, patch) => ipcRenderer.invoke('sessions:updateMeta', key, patch),
  rescan: () => ipcRenderer.invoke('sessions:rescan'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addExtraFolder: () => ipcRenderer.invoke('settings:addFolder'),
  removeExtraFolder: (folder) => ipcRenderer.invoke('settings:removeFolder', folder),
  getArchiveStats: () => ipcRenderer.invoke('archive:stats'),
  openArchiveFolder: () => ipcRenderer.invoke('archive:open'),
  showSessionFile: (key) => ipcRenderer.invoke('sessions:showFile', key),
  openClaudeSettings: (id) => ipcRenderer.invoke('sources:openSettings', id),
  previewLaunch: (opts) => ipcRenderer.invoke('launch:preview', opts),
  launch: (opts) => ipcRenderer.invoke('launch:run', opts),
  pickCwd: (key) => ipcRenderer.invoke('launch:pickCwd', key),
  exportMarkdown: (key) => ipcRenderer.invoke('export:markdown', key),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  setTheme: (theme, resolved) => ipcRenderer.invoke('theme:set', theme, resolved),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  getUsageReport: (q) => ipcRenderer.invoke('usage:report', q),
  getSessionUsage: (key) => ipcRenderer.invoke('usage:session', key),
  getUsageStatus: () => ipcRenderer.invoke('usage:status'),
  onUsageChanged: (cb) => on('usage:changed', cb),
  recalculateUsage: () => ipcRenderer.invoke('usage:recalculate'),
  exportUsageCsv: (q, perRecord) => ipcRenderer.invoke('usage:exportCsv', q, perRecord),
  verifyCcusage: () => ipcRenderer.invoke('usage:verifyCcusage')
}

contextBridge.exposeInMainWorld('csd', api)
