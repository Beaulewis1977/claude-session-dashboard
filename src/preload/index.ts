import { contextBridge, ipcRenderer } from 'electron'
import type { CsdApi } from '@shared/api'
import type { SessionsPayload } from '@shared/types'
import type { SummaryQueueState } from '@shared/summary-queue'
import type { AskIndexStatus } from '@shared/ask-sessions/types'

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
  getGitView: (key) => ipcRenderer.invoke('git:session', key),
  getGitDiff: (key, sha, path, all) => ipcRenderer.invoke('git:diff', key, sha, path, all),
  unlinkCommit: (key, sha) => ipcRenderer.invoke('git:unlink', key, sha),
  relinkCommit: (key, sha) => ipcRenderer.invoke('git:relink', key, sha),
  refreshGit: (key) => ipcRenderer.invoke('git:refresh', key),
  getGitStatus: () => ipcRenderer.invoke('git:status'),
  updateGitSettings: (patch) => ipcRenderer.invoke('git:settings', patch),
  onGitChanged: (cb) => on('git:changed', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addExtraFolder: () => ipcRenderer.invoke('settings:addFolder'),
  removeExtraFolder: (folder) => ipcRenderer.invoke('settings:removeFolder', folder),
  getArchiveStats: () => ipcRenderer.invoke('archive:stats'),
  getCodexArchiveEstimate: () => ipcRenderer.invoke('archive:codexEstimate'),
  importClaudeAi: () => ipcRenderer.invoke('import:claudeAi'),
  openArchiveFolder: () => ipcRenderer.invoke('archive:open'),
  showSessionFile: (key) => ipcRenderer.invoke('sessions:showFile', key),
  openClaudeSettings: (id) => ipcRenderer.invoke('sources:openSettings', id),
  previewLaunch: (opts) => ipcRenderer.invoke('launch:preview', opts),
  launch: (opts) => ipcRenderer.invoke('launch:run', opts),
  pickCwd: (key, where) => ipcRenderer.invoke('launch:pickCwd', key, where),
  openInAgentApp: (key) => ipcRenderer.invoke('launch:openInAgentApp', key),
  exportMarkdown: (key) => ipcRenderer.invoke('export:markdown', key),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  setTheme: (theme, resolved) => ipcRenderer.invoke('theme:set', theme, resolved),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  getUsageReport: (q) => ipcRenderer.invoke('usage:report', q),
  getSessionUsage: (key) => ipcRenderer.invoke('usage:session', key),
  getContextEstimate: (key) => ipcRenderer.invoke('context:estimate', key),
  getUsageStatus: () => ipcRenderer.invoke('usage:status'),
  onUsageChanged: (cb) => on('usage:changed', cb),
  recalculateUsage: () => ipcRenderer.invoke('usage:recalculate'),
  exportUsageCsv: (q, perRecord) => ipcRenderer.invoke('usage:exportCsv', q, perRecord),
  verifyCcusage: () => ipcRenderer.invoke('usage:verifyCcusage'),
  getTrends: (groupBy) => ipcRenderer.invoke('usage:trends', groupBy),
  compareTrends: (a, b) => ipcRenderer.invoke('usage:compare', a, b),
  getCodexTrends: (groupBy) => ipcRenderer.invoke('usage:codexTrends', groupBy),
  compareCodexTrends: (a, b) => ipcRenderer.invoke('usage:codexCompare', a, b),

  getLimits: () => ipcRenderer.invoke('limits:state'),
  rescanLimits: () => ipcRenderer.invoke('limits:rescan'),
  compareHealth: (kind, a, b) => ipcRenderer.invoke('limits:compareHealth', kind, a, b),
  onLimitsChanged: (cb) => on('limits:changed', cb),
  getCodexLimits: () => ipcRenderer.invoke('codexLimits:state'),
  compareCodexHealth: (kind, a, b) => ipcRenderer.invoke('codexLimits:compareHealth', kind, a, b),
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

  askSessionsStatus: () => ipcRenderer.invoke('askSessions:status'),
  askSessions: (q, opts) => ipcRenderer.invoke('askSessions:ask', q, opts),
  askSessionsPrompt: (id, keep) => ipcRenderer.invoke('askSessions:prompt', id, keep),
  askSessionsEstimate: (id, keep, model) =>
    ipcRenderer.invoke('askSessions:estimate', id, keep, model),
  askSessionsSend: (id, opts) => ipcRenderer.invoke('askSessions:send', id, opts),
  askSessionsCancel: (id) => ipcRenderer.invoke('askSessions:cancel', id),
  askSessionsHistory: () => ipcRenderer.invoke('askSessions:history'),
  askSessionsDelete: (id) => ipcRenderer.invoke('askSessions:delete', id),
  askSessionsRebuild: () => ipcRenderer.invoke('askSessions:rebuild'),
  askSessionsDeleteIndex: () => ipcRenderer.invoke('askSessions:deleteIndex'),
  askSessionsPending: () => ipcRenderer.invoke('askSessions:pending'),
  askSessionsDecline: (id) => ipcRenderer.invoke('askSessions:decline', id),
  askSessionsLocal: (q) => ipcRenderer.invoke('askSessions:phoneLocal', q),
  askSessionsRequest: () => Promise.reject(new Error('On the PC, ask in the Ask screen itself.')),
  askSessionsRequestStatus: (id) => ipcRenderer.invoke('askSessions:phoneStatus', id),
  onAskSessionsChanged: (cb) => on('askSessions:changed', cb),
  onAskSessionsStatus: (cb) => {
    const listener = (_e: unknown, s: AskIndexStatus): void => cb(s)
    ipcRenderer.on('askSessions:status', listener)
    return () => ipcRenderer.removeListener('askSessions:status', listener)
  },
  onAskSessionsPhoneRequest: (cb) => on('askSessions:phoneRequest', cb),

  summaryState: () => ipcRenderer.invoke('summaries:state'),
  onSummariesChanged: (cb) => {
    const listener = (_e: unknown, st: SummaryQueueState): void => cb(st)
    ipcRenderer.on('summaries:changed', listener)
    return () => ipcRenderer.removeListener('summaries:changed', listener)
  },
  summaryPreview: (key) => ipcRenderer.invoke('summaries:preview', key),
  summaryEstimate: (keys) => ipcRenderer.invoke('summaries:estimate', keys),
  summarize: (keys, origin, previewId, prepId) =>
    ipcRenderer.invoke('summaries:enqueue', keys, origin, previewId, prepId),
  summaryCancelPrep: (prepId) => ipcRenderer.invoke('summaries:cancelPrep', prepId),
  summaryCancel: (key) => ipcRenderer.invoke('summaries:cancel', key),
  summaryResume: () => ipcRenderer.invoke('summaries:resume'),
  summaryClearFinished: () => ipcRenderer.invoke('summaries:clear'),
  saveSummary: (key, patch) => ipcRenderer.invoke('summaries:save', key, patch),
  removeSummary: (key) => ipcRenderer.invoke('summaries:remove', key),
  summaryAutoPreview: () => ipcRenderer.invoke('summaries:autoPreview'),
  handoffStats: () => ipcRenderer.invoke('summaries:handoffStats'),
  cleanHandoffs: () => ipcRenderer.invoke('summaries:cleanHandoffs'),

  toggleMiniMeter: () => ipcRenderer.invoke('mini:toggle'),
  closeMiniMeter: () => ipcRenderer.invoke('mini:close'),
  setTrayImage: (dataUrl, tooltip) => ipcRenderer.invoke('tray:set', dataUrl, tooltip),
  onShowUsage: (cb) => on('app:showUsage', cb),
  onShowSettings: (cb) => {
    const listener = (_e: unknown, section: string): void => cb(String(section))
    ipcRenderer.on('app:showSettings', listener)
    return () => ipcRenderer.removeListener('app:showSettings', listener)
  },
  onNavigate: (cb) => {
    const listener = (_e: unknown, dir: unknown): void => {
      if (dir === 'back' || dir === 'forward') cb(dir)
    }
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },

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
  backupOpenSafety: () => ipcRenderer.invoke('backup:openSafety'),
  startWithWindows: () => ipcRenderer.invoke('app:startWithWindows'),
  setStartWithWindows: (on) => ipcRenderer.invoke('app:setStartWithWindows', on),
  backupSafetyCopies: () => ipcRenderer.invoke('backup:safetyCopies'),
  backupCleanSafety: (names) => ipcRenderer.invoke('backup:cleanSafety', names)
}

contextBridge.exposeInMainWorld('csd', api)
