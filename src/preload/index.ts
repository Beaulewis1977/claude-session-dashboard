import { contextBridge, ipcRenderer } from 'electron'
import type { CsdApi } from '@shared/api'
import type { SessionsPayload } from '@shared/types'
import type { SummaryQueueState } from '@shared/summary-queue'

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
  applyClaudeNames: (keys) => ipcRenderer.invoke('sessions:applyClaudeNames', keys),
  rescan: () => ipcRenderer.invoke('sessions:rescan'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addExtraFolder: () => ipcRenderer.invoke('settings:addFolder'),
  removeExtraFolder: (folder) => ipcRenderer.invoke('settings:removeFolder', folder),
  getArchiveStats: () => ipcRenderer.invoke('archive:stats'),
  importClaudeAi: () => ipcRenderer.invoke('import:claudeAi'),
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
  verifyCcusage: () => ipcRenderer.invoke('usage:verifyCcusage'),
  getTrends: (groupBy) => ipcRenderer.invoke('usage:trends', groupBy),
  compareTrends: (a, b) => ipcRenderer.invoke('usage:compare', a, b),

  getLimits: () => ipcRenderer.invoke('limits:state'),
  rescanLimits: () => ipcRenderer.invoke('limits:rescan'),
  compareHealth: (kind, a, b) => ipcRenderer.invoke('limits:compareHealth', kind, a, b),
  onLimitsChanged: (cb) => on('limits:changed', cb),
  planBridge: (id, action) => ipcRenderer.invoke('bridge:plan', id, action),
  applyBridge: (id, action, token) => ipcRenderer.invoke('bridge:apply', id, action, token),
  openBackupFolder: () => ipcRenderer.invoke('bridge:openBackups'),

  getCredits: () => ipcRenderer.invoke('credits:state'),
  onCreditsChanged: (cb) => on('credits:changed', cb),
  addAccount: (nickname, key) => ipcRenderer.invoke('accounts:add', nickname, key),
  renameAccount: (id, nickname) => ipcRenderer.invoke('accounts:rename', id, nickname),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  reconnectAccount: (id, key) => ipcRenderer.invoke('accounts:reconnect', id, key),
  addGrant: (grant) => ipcRenderer.invoke('grants:add', grant),
  removeGrant: (id) => ipcRenderer.invoke('grants:remove', id),
  refreshAdmin: (id) => ipcRenderer.invoke('admin:refresh', id),

  askStatus: () => ipcRenderer.invoke('ask:status'),
  askPreview: (q) => ipcRenderer.invoke('ask:preview', q),
  askRun: (id) => ipcRenderer.invoke('ask:run', id),
  askCancel: (id) => ipcRenderer.invoke('ask:cancel', id),
  askHistory: () => ipcRenderer.invoke('ask:history'),

  summaryState: () => ipcRenderer.invoke('summaries:state'),
  onSummariesChanged: (cb) => {
    const listener = (_e: unknown, st: SummaryQueueState): void => cb(st)
    ipcRenderer.on('summaries:changed', listener)
    return () => ipcRenderer.removeListener('summaries:changed', listener)
  },
  summaryPreview: (key) => ipcRenderer.invoke('summaries:preview', key),
  summaryEstimate: (keys) => ipcRenderer.invoke('summaries:estimate', keys),
  summarize: (keys, origin, previewId) =>
    ipcRenderer.invoke('summaries:enqueue', keys, origin, previewId),
  summaryCancel: (key) => ipcRenderer.invoke('summaries:cancel', key),
  summaryResume: () => ipcRenderer.invoke('summaries:resume'),
  summaryClearFinished: () => ipcRenderer.invoke('summaries:clear'),
  saveSummary: (key, patch) => ipcRenderer.invoke('summaries:save', key, patch),
  removeSummary: (key) => ipcRenderer.invoke('summaries:remove', key),
  summaryAutoPreview: () => ipcRenderer.invoke('summaries:autoPreview'),

  toggleMiniMeter: () => ipcRenderer.invoke('mini:toggle'),
  closeMiniMeter: () => ipcRenderer.invoke('mini:close'),
  setTrayImage: (dataUrl, tooltip) => ipcRenderer.invoke('tray:set', dataUrl, tooltip),
  onShowUsage: (cb) => on('app:showUsage', cb),

  mobileStatus: () => ipcRenderer.invoke('mobile:status'),
  mobileUpdate: (patch) => ipcRenderer.invoke('mobile:update', patch),
  mobileStart: () => ipcRenderer.invoke('mobile:start'),
  mobileStop: () => ipcRenderer.invoke('mobile:stop'),
  mobileRetryServe: () => ipcRenderer.invoke('mobile:retryServe'),
  mobilePair: () => ipcRenderer.invoke('mobile:pair'),
  mobileCancelPair: () => ipcRenderer.invoke('mobile:cancelPair'),
  mobileRevoke: (id) => ipcRenderer.invoke('mobile:revoke', id),
  mobileRenameDevice: (id, name) => ipcRenderer.invoke('mobile:renameDevice', id, name),
  mobileActivity: () => ipcRenderer.invoke('mobile:activity'),
  mobileSendTest: (id) => ipcRenderer.invoke('mobile:sendTest', id),
  mobileLanAddresses: () => ipcRenderer.invoke('mobile:lanAddresses'),
  mobileClaudeCheck: () => ipcRenderer.invoke('mobile:claudeCheck'),
  mobileDiagnostics: () => ipcRenderer.invoke('mobile:diagnostics'),
  mobileFirewallAdd: () => ipcRenderer.invoke('mobile:firewallAdd'),
  mobileFirewallRemove: () => ipcRenderer.invoke('mobile:firewallRemove'),
  tailscaleInstall: () => ipcRenderer.invoke('mobile:tailscaleInstall'),
  tailscaleLogin: () => ipcRenderer.invoke('mobile:tailscaleLogin'),
  openTailscaleLink: (url) => ipcRenderer.invoke('mobile:openLink', url),
  onMobileChanged: (cb) => on('mobile:changed', cb),

  terminalStatus: () => ipcRenderer.invoke('terminal:status'),
  terminalPrepare: (action) => ipcRenderer.invoke('terminal:prepare', action),
  terminalApply: (token) => ipcRenderer.invoke('terminal:apply', token),
  terminalHistory: () => ipcRenderer.invoke('terminal:history'),
  terminalListen: (on) => ipcRenderer.invoke('terminal:listen', on),
  terminalRejectKey: () => ipcRenderer.invoke('terminal:rejectKey'),
  terminalDiagnostics: () => ipcRenderer.invoke('terminal:diagnostics'),
  terminalOpenBackups: () => ipcRenderer.invoke('terminal:openBackups'),
  onTerminalChanged: (cb) => on('terminal:changed', cb),
  getTerminalAccess: () => ipcRenderer.invoke('terminal:phoneInfo'),
  openTerminalHere: (key) => ipcRenderer.invoke('terminal:openHere', key),

  getLive: () => ipcRenderer.invoke('live:state'),
  onLiveChanged: (cb) => on('live:changed', cb),
  onShowLive: (cb) => {
    const listener = (_e: unknown, key: string): void => cb(String(key))
    ipcRenderer.on('app:showLive', listener)
    return () => ipcRenderer.removeListener('app:showLive', listener)
  },
  focusTerminal: (key) => ipcRenderer.invoke('live:focus', key),
  planHooks: (id, action) => ipcRenderer.invoke('hooks:plan', id, action),
  applyHooks: (id, action, token) => ipcRenderer.invoke('hooks:apply', id, action, token),
  mobilePushOff: (id) => ipcRenderer.invoke('mobile:pushOff', id),
  mobilePushTest: (id) => ipcRenderer.invoke('mobile:pushTest', id),

  backupStatus: () => ipcRenderer.invoke('backup:status'),
  onBackupChanged: (cb) => on('backup:changed', cb),
  backupPickFolder: () => ipcRenderer.invoke('backup:pickFolder'),
  backupConnect: (folder, opts) => ipcRenderer.invoke('backup:connect', folder, opts),
  backupTakeOver: () => ipcRenderer.invoke('backup:takeOver'),
  backupDisconnect: () => ipcRenderer.invoke('backup:disconnect'),
  backupUpdate: (patch) => ipcRenderer.invoke('backup:update', patch),
  backupRun: () => ipcRenderer.invoke('backup:run'),
  backupSetPassword: (password, remember) =>
    ipcRenderer.invoke('backup:setPassword', password, remember),
  backupUnlock: (password, remember) => ipcRenderer.invoke('backup:unlock', password, remember),
  backupForget: () => ipcRenderer.invoke('backup:forget'),
  backupSnapshots: () => ipcRenderer.invoke('backup:snapshots'),
  backupPreview: (id, password) => ipcRenderer.invoke('backup:preview', id, password),
  backupRestore: (token) => ipcRenderer.invoke('backup:restore', token),
  backupOpenFolder: () => ipcRenderer.invoke('backup:openFolder'),
  backupOpenSafety: () => ipcRenderer.invoke('backup:openSafety')
}

contextBridge.exposeInMainWorld('csd', api)
