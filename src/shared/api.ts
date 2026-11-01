// The API exposed to the renderer by the preload script (window.csd).

import type {
  AppInfo,
  AppSettings,
  ArchiveStats,
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  ThemePref
} from './types'
import type {
  CcusageComparison,
  SessionUsage,
  UsageQuery,
  UsageReport,
  UsageStatus
} from './usage/types'
import type { BridgeApplyResult, BridgePlan, LimitsState } from './usage/limits'
import type { CompareRange, HealthCompare } from './usage/health'
import type { AskHistoryItem } from './ask'
import type { AiSummary, SummaryEstimate } from './summary'
import type { SummaryBatchEstimate, SummaryPreview, SummaryQueueState } from './summary-queue'
import type { Account, CreditGrant, CreditsState } from './usage/credits'
import type { CompareResult, CompareSide, TrendGroupBy, TrendsReport } from './usage/trends'
import type {
  ActivityEntry,
  ClaudeCheck,
  LanAddress,
  MobileSettings,
  MobileStatus,
  PairingInfo
} from './mobile'
import type {
  ActionResult,
  PreparedChange,
  TerminalAccessInfo,
  TerminalAction,
  TerminalLogEntry,
  TerminalStatus
} from './terminal'
import type { FocusResult, LiveSnapshot } from './live'
import type {
  BackupError,
  BackupFolderCandidate,
  BackupRunSummary,
  BackupSchedule,
  BackupStatus,
  RestorePreview,
  SnapshotInfo
} from './backup'

export interface SearchHit {
  key: string
  score: number
  /** Fields that matched, e.g. ["text", "name"]. */
  fields: string[]
}

export interface ExportResult {
  saved: boolean
  path?: string
  error?: string
}

export interface ImportResult {
  ok: boolean
  error?: string
  conversations: number
  added: number
  updated: number
  unchanged: number
  skipped: number
}

export interface CsdApi {
  /** True in the phone web app (the companion), where desktop-only features are hidden. */
  readonly remote?: boolean

  getInfo(): Promise<AppInfo>
  getSessions(): Promise<SessionsPayload>
  onSessionsChanged(cb: (payload: SessionsPayload) => void): () => void
  getSession(key: string): Promise<SessionDetail | null>
  search(query: string): Promise<SearchHit[]>
  updateMeta(key: string, patch: Partial<SessionMeta>): Promise<SessionSummary | null>
  /** Clear my dashboard names for these sessions, so their Claude Code names show. Returns how many changed. */
  applyClaudeNames(keys: string[]): Promise<number>
  rescan(): Promise<void>

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  addExtraFolder(): Promise<AppSettings>
  removeExtraFolder(folder: string): Promise<AppSettings>
  getArchiveStats(): Promise<ArchiveStats>
  /** Pick a claude.ai export zip and import it. Null when the dialog was cancelled. */
  importClaudeAi(): Promise<ImportResult | null>
  openArchiveFolder(): Promise<void>
  showSessionFile(key: string): Promise<void>
  openClaudeSettings(sourceId: string): Promise<void>

  previewLaunch(opts: LaunchOptions): Promise<LaunchPreview>
  launch(opts: LaunchOptions): Promise<LaunchResult>
  pickCwd(key: string): Promise<string | null>

  exportMarkdown(key: string): Promise<ExportResult>
  copyText(text: string): Promise<void>
  setTheme(theme: ThemePref, resolved: 'light' | 'dark'): Promise<void>
  openExternal(url: string): Promise<void>

  // Usage (Phase 5)
  getUsageReport(query: UsageQuery): Promise<UsageReport>
  getSessionUsage(key: string): Promise<SessionUsage>
  getUsageStatus(): Promise<UsageStatus>
  onUsageChanged(cb: () => void): () => void
  recalculateUsage(): Promise<UsageStatus>
  exportUsageCsv(query: UsageQuery, perRecord: boolean): Promise<ExportResult>
  verifyCcusage(): Promise<CcusageComparison>
  getTrends(groupBy: TrendGroupBy): Promise<TrendsReport>
  compareTrends(a: CompareSide, b: CompareSide): Promise<CompareResult>

  // Live limits and the status line bridge
  getLimits(): Promise<LimitsState>
  /** Re-detect sources, re-read every bridge folder and update the gauges ("Rescan now"). */
  rescanLimits(): Promise<LimitsState>
  compareHealth(
    kind: 'five_hour' | 'seven_day',
    a: CompareRange,
    b: CompareRange
  ): Promise<HealthCompare | null>
  onLimitsChanged(cb: () => void): () => void
  planBridge(sourceId: string, action: 'install' | 'uninstall'): Promise<BridgePlan>
  applyBridge(
    sourceId: string,
    action: 'install' | 'uninstall',
    token: string
  ): Promise<BridgeApplyResult>
  openBackupFolder(): Promise<void>

  // API keys and credits
  getCredits(): Promise<CreditsState>
  onCreditsChanged(cb: () => void): () => void
  addAccount(nickname: string, key: string): Promise<{ account?: Account; error?: string }>
  renameAccount(id: string, nickname: string): Promise<void>
  removeAccount(id: string): Promise<void>
  /** Give an account restored from a backup its key again (the same key it used). */
  reconnectAccount(id: string, key: string): Promise<{ account?: Account; error?: string }>
  addGrant(grant: Omit<CreditGrant, 'id'>): Promise<CreditGrant | undefined>
  removeGrant(id: string): Promise<void>
  refreshAdmin(id: string): Promise<void>

  // Ask Claude (claude -p with aggregated numbers only)
  askStatus(): Promise<{ available: boolean; where?: string; simulated: boolean }>
  askPreview(question: string): Promise<{ id: string; prompt: string; bytes: number }>
  askRun(previewId: string): Promise<AskHistoryItem>
  askCancel(previewId: string): Promise<void>
  askHistory(): Promise<AskHistoryItem[]>

  // Session summaries (claude -p on the subscription; desktop only, except reading and editing)
  summaryState(): Promise<SummaryQueueState>
  onSummariesChanged(cb: (state: SummaryQueueState) => void): () => void
  /** Exactly what would be sent for one session, with an estimate. */
  summaryPreview(key: string): Promise<SummaryPreview>
  /** What summarizing these sessions would send and use, roughly. */
  summaryEstimate(keys: string[]): Promise<SummaryBatchEstimate>
  /** Queue sessions to summarize. Returns how many were added. */
  summarize(keys: string[], origin?: 'manual' | 'bulk'): Promise<number>
  /** Cancel one session's summary, or all of them. */
  summaryCancel(key?: string): Promise<void>
  /** Go on with a queue paused by the limits guard. */
  summaryResume(): Promise<void>
  summaryClearFinished(): Promise<void>
  /** Save a summary edited by hand. */
  saveSummary(
    key: string,
    patch: Partial<Pick<AiSummary, 'title' | 'done' | 'files' | 'decisions' | 'todos' | 'pickUp'>>
  ): Promise<SessionSummary | null>
  removeSummary(key: string): Promise<SessionSummary | null>
  /** Sessions auto-summarize would pick now, and what that would use. */
  summaryAutoPreview(): Promise<{ count: number; estimate: SummaryEstimate }>

  // Tray and mini meter
  toggleMiniMeter(): Promise<boolean>
  closeMiniMeter(): Promise<void>
  /** The renderer draws the tray icon (a ring with the 5-hour %) and hands it over as a PNG. */
  setTrayImage(dataUrl: string, tooltip: string): Promise<void>
  onShowUsage(cb: () => void): () => void

  // Phone companion (desktop only: a phone can't reach any of these)
  mobileStatus(): Promise<MobileStatus>
  mobileUpdate(patch: Partial<MobileSettings>): Promise<MobileStatus>
  mobileStart(): Promise<MobileStatus>
  mobileStop(): Promise<MobileStatus>
  mobileRetryServe(): Promise<MobileStatus>
  mobilePair(): Promise<PairingInfo | { error: string }>
  mobileCancelPair(): Promise<void>
  mobileRevoke(id: string): Promise<void>
  mobileRenameDevice(id: string, name: string): Promise<void>
  mobileActivity(): Promise<ActivityEntry[]>
  mobileSendTest(deviceId?: string): Promise<number>
  mobileLanAddresses(): Promise<LanAddress[]>
  mobileClaudeCheck(): Promise<ClaudeCheck>
  mobileDiagnostics(): Promise<string>
  mobileFirewallAdd(): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
  mobileFirewallRemove(): Promise<{ ok: boolean }>
  tailscaleInstall(): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
  tailscaleLogin(): Promise<{ ok: boolean; error?: string; opened?: boolean; app?: boolean }>
  /** Opens a Tailscale sign-in / approval link (login.tailscale.com only). */
  openTailscaleLink(url: string): Promise<void>
  onMobileChanged(cb: () => void): () => void

  // Terminal access over SSH (setup is desktop only)
  terminalStatus(): Promise<TerminalStatus>
  /** Work out a change and return exactly what would run; nothing changes yet. */
  terminalPrepare(action: TerminalAction): Promise<PreparedChange | { error: string }>
  /** Run the change last returned by terminalPrepare. */
  terminalApply(token: string): Promise<ActionResult>
  terminalHistory(): Promise<TerminalLogEntry[]>
  /** Accept one public key from a paired phone for 10 minutes (or stop). */
  terminalListen(on: boolean): Promise<void>
  terminalRejectKey(): Promise<void>
  terminalDiagnostics(): Promise<string>
  terminalOpenBackups(): Promise<void>
  onTerminalChanged(cb: () => void): () => void
  /** Where an SSH app connects, and whether terminal access is set up (the phone can read this). */
  getTerminalAccess(): Promise<TerminalAccessInfo>
  /** A local terminal in the session's folder (desktop only). */
  openTerminalHere(key: string): Promise<LaunchResult>

  // Running now and session alerts
  getLive(): Promise<LiveSnapshot>
  onLiveChanged(cb: () => void): () => void
  /** A session alert was clicked on the desktop: show this session. */
  onShowLive(cb: (key: string) => void): () => void
  /** Bring the session's terminal window (and tab) forward (desktop only). */
  focusTerminal(key: string): Promise<FocusResult>
  /** The exact settings.json change for turning session alerts on or off (desktop only). */
  planHooks(sourceId: string, action: 'install' | 'uninstall'): Promise<BridgePlan>
  applyHooks(
    sourceId: string,
    action: 'install' | 'uninstall',
    token: string
  ): Promise<BridgeApplyResult>
  /** Turn push alerts off for a paired phone (desktop only). */
  mobilePushOff(deviceId: string): Promise<void>
  /** Send a test push to a paired phone; returns how many were sent (desktop only). */
  mobilePushTest(deviceId: string): Promise<number>

  // Backups (desktop only)
  backupStatus(): Promise<BackupStatus>
  onBackupChanged(cb: () => void): () => void
  /** Folder dialog; null when cancelled. Nothing is saved yet. */
  backupPickFolder(): Promise<BackupFolderCandidate | null>
  backupConnect(
    folder: string,
    opts: { encrypt?: boolean; password?: string; remember?: boolean; accept?: boolean }
  ): Promise<BackupStatus | BackupError>
  /** Make this PC the one that backs up into the connected set. */
  backupTakeOver(): Promise<BackupStatus | BackupError>
  /** Stop backing up to the folder (nothing in it is deleted). */
  backupDisconnect(): Promise<BackupStatus>
  backupUpdate(patch: { schedule?: BackupSchedule; keep?: number }): Promise<BackupStatus>
  backupRun(): Promise<BackupRunSummary>
  /** Encrypt new snapshots with this password (null: stop encrypting new ones). */
  backupSetPassword(password: string | null, remember: boolean): Promise<BackupStatus | BackupError>
  backupUnlock(password: string, remember: boolean): Promise<BackupStatus | BackupError>
  backupForget(): Promise<BackupStatus>
  backupSnapshots(): Promise<SnapshotInfo[] | BackupError>
  backupPreview(snapshotId: string, password?: string): Promise<RestorePreview | BackupError>
  /** Restore a previewed snapshot; the app restarts to finish. */
  backupRestore(
    token: string
  ): Promise<{ ok: true; written: number; relaunch: boolean } | BackupError>
  backupOpenFolder(): Promise<void>
  backupOpenSafety(): Promise<void>
}
