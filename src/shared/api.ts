// The API exposed to the renderer by the preload script (window.csd).

import type {
  AppInfo,
  AppSettings,
  ArchiveStats,
  CodexArchiveEstimate,
  LaunchOptions,
  LaunchPreview,
  LaunchResult,
  SessionDetail,
  SessionMeta,
  SessionsPayload,
  SessionSummary,
  StartWithWindows,
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
import type { CodexLimitsState } from './usage/codex'
import type { CompareRange, HealthCompare } from './usage/health'
import type { AskHistoryItem } from './ask'
import type {
  AskEffort,
  AskEstimate,
  AskIndexStatus,
  AskModel,
  AskPhoneRequest,
  AskResult,
  AskScope,
  AskSessionsItem,
  LocalAnswer
} from './ask-sessions/types'

/** A phone's local question: answered on the PC (nothing sent), or a content one. */
export type PhoneLocalAnswer =
  { mode: 'local'; answer: LocalAnswer; chips: string[] } | { mode: 'content'; enabled: boolean }
import type { AiSummary, SummaryEstimate } from './summary'
import type { ResumeEstimate } from './context'
import type { SummaryBatchEstimate, SummaryPreview, SummaryQueueState } from './summary-queue'
import type { Account, CreditGrant, CreditsState } from './usage/credits'
import type { CompareResult, CompareSide, TrendGroupBy, TrendsReport } from './usage/trends'
import type { CodexMetricId, CodexTrendsReport } from './usage/codex-trends'
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
import type { CommitDiff, GitLinkSettings, GitStatus, SessionGitView } from './git/types'
import type {
  BackupError,
  BackupFolderCandidate,
  BackupRunSummary,
  BackupSchedule,
  BackupStatus,
  RestorePreview,
  SafetyCleanup,
  SafetySummary,
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

  // Git links (the viewer's Changes tab; the phone gets a read-only view, no diffs).
  getGitView(key: string): Promise<SessionGitView | null>
  getGitDiff(key: string, sha: string, path?: string, all?: boolean): Promise<CommitDiff>
  unlinkCommit(key: string, sha: string): Promise<SessionGitView | null>
  relinkCommit(key: string, sha: string): Promise<SessionGitView | null>
  refreshGit(key?: string): Promise<void>
  getGitStatus(): Promise<GitStatus>
  /** Settings → Git, and the Changes tab's one-time "Look up PRs with the GitHub CLI?" (desktop only). */
  updateGitSettings(patch: Partial<GitLinkSettings>): Promise<GitStatus>
  onGitChanged(cb: () => void): () => void

  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  addExtraFolder(): Promise<AppSettings>
  removeExtraFolder(folder: string): Promise<AppSettings>
  getArchiveStats(): Promise<ArchiveStats>
  /** What "Archive Codex sessions" would copy, per mode (sizes, backup estimate). */
  getCodexArchiveEstimate(): Promise<CodexArchiveEstimate>
  /** Pick a claude.ai export zip and import it. Null when the dialog was cancelled. */
  importClaudeAi(): Promise<ImportResult | null>
  openArchiveFolder(): Promise<void>
  showSessionFile(key: string): Promise<void>
  openClaudeSettings(sourceId: string): Promise<void>

  previewLaunch(opts: LaunchOptions): Promise<LaunchPreview>
  launch(opts: LaunchOptions): Promise<LaunchResult>
  /** Open the session in its agent's own app (Codex: `codex://threads/<id>`). Desktop only. */
  openInAgentApp(key: string): Promise<void>
  /** `where`: the choices made in the dialog for a session whose folder is in the other environment. */
  pickCwd(key: string, where?: Pick<LaunchOptions, 'wslFolder' | 'distro'>): Promise<string | null>

  exportMarkdown(key: string): Promise<ExportResult>
  copyText(text: string): Promise<void>
  setTheme(theme: ThemePref, resolved: 'light' | 'dark'): Promise<void>
  openExternal(url: string): Promise<void>

  // Usage (Phase 5)
  getUsageReport(query: UsageQuery): Promise<UsageReport>
  getSessionUsage(key: string): Promise<SessionUsage>
  /** Context size and the estimated cost of resuming (null: not known). */
  getContextEstimate(key: string): Promise<ResumeEstimate | null>
  getUsageStatus(): Promise<UsageStatus>
  onUsageChanged(cb: () => void): () => void
  recalculateUsage(): Promise<UsageStatus>
  exportUsageCsv(query: UsageQuery, perRecord: boolean): Promise<ExportResult>
  verifyCcusage(): Promise<CcusageComparison>
  getTrends(groupBy: TrendGroupBy): Promise<TrendsReport>
  compareTrends(a: CompareSide, b: CompareSide): Promise<CompareResult>
  /** Codex trends, kept apart from Claude Code's (per model and Codex CLI version). */
  getCodexTrends(groupBy: TrendGroupBy): Promise<CodexTrendsReport>
  compareCodexTrends(a: CompareSide, b: CompareSide): Promise<CompareResult<CodexMetricId>>

  // Live limits and the status line bridge
  getLimits(): Promise<LimitsState>
  /** Re-detect sources, re-read every bridge folder and update the gauges ("Rescan now"). */
  rescanLimits(): Promise<LimitsState>
  compareHealth(
    kind: 'five_hour' | 'seven_day',
    a: CompareRange,
    b: CompareRange
  ): Promise<HealthCompare | null>
  /** Also fires when Codex's limits change. */
  onLimitsChanged(cb: () => void): () => void
  /** Codex's plan limits, from its session logs (null: Codex is off). */
  getCodexLimits(): Promise<CodexLimitsState | null>
  compareCodexHealth(
    kind: 'five_hour' | 'seven_day',
    a: CompareRange,
    b: CompareRange
  ): Promise<HealthCompare | null>
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

  // Ask across sessions: local answers, and content questions (claude -p with
  // snippets I reviewed; off until turned on). A phone asks local ones itself
  // and sends content ones to the PC for approval.
  askSessionsStatus(): Promise<AskIndexStatus>
  askSessions(
    question: string,
    opts?: { scope?: AskScope; content?: boolean; phoneRequest?: string }
  ): Promise<AskResult>
  askSessionsPrompt(previewId: string, keep: string[]): Promise<{ prompt: string; chars: number }>
  askSessionsEstimate(previewId: string, keep: string[], model: AskModel): Promise<AskEstimate>
  askSessionsSend(
    previewId: string,
    opts: { keep: string[]; model: AskModel; effort: AskEffort }
  ): Promise<AskSessionsItem>
  askSessionsCancel(previewId: string): Promise<void>
  askSessionsHistory(): Promise<AskSessionsItem[]>
  askSessionsDelete(id: string): Promise<boolean>
  askSessionsRebuild(): Promise<void>
  askSessionsDeleteIndex(): Promise<void>
  askSessionsPending(): Promise<AskPhoneRequest[]>
  askSessionsDecline(id: string): Promise<void>
  askSessionsLocal(question: string): Promise<PhoneLocalAnswer>
  /** Phone: send a content question to the PC for approval. */
  askSessionsRequest(question: string, scope?: AskScope): Promise<AskPhoneRequest>
  askSessionsRequestStatus(id: string): Promise<AskPhoneRequest | null>
  onAskSessionsChanged(cb: () => void): () => void
  onAskSessionsStatus(cb: (s: AskIndexStatus) => void): () => void
  /** A phone's question came in (the PC window came forward). */
  onAskSessionsPhoneRequest(cb: () => void): () => void

  // Session summaries (claude -p on the subscription; desktop only, except reading and editing)
  summaryState(): Promise<SummaryQueueState>
  onSummariesChanged(cb: (state: SummaryQueueState) => void): () => void
  /** Exactly what would be sent for one session, with an estimate. */
  summaryPreview(key: string): Promise<SummaryPreview>
  /** What summarizing these sessions would send and use, roughly. */
  summaryEstimate(keys: string[]): Promise<SummaryBatchEstimate>
  /** Queue sessions to summarize. Returns how many were added. */
  summarize(
    keys: string[],
    origin?: 'manual' | 'bulk',
    previewId?: string,
    /** 16 hex characters: summaryCancelPrep(prepId) stops it while it reads the sessions. */
    prepId?: string
  ): Promise<number>
  /** Stop a summarize request that is still reading its sessions (nothing of it is queued). */
  summaryCancelPrep(prepId: string): Promise<void>
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
  /** Continue fresh's handoff files (Claude Code's and Codex's): how many, how big, how many are old. */
  handoffStats(): Promise<{ files: number; bytes: number; old: { files: number; bytes: number } }>
  /** Delete handoff files older than 30 days (asked first in Settings; desktop only). */
  cleanHandoffs(): Promise<{ deleted: number; bytes: number }>

  // Tray and mini meter
  toggleMiniMeter(): Promise<boolean>
  closeMiniMeter(): Promise<void>
  /** The renderer draws the tray icon (a ring with the 5-hour %) and hands it over as a PNG. */
  setTrayImage(dataUrl: string, tooltip: string): Promise<void>
  onShowUsage(cb: () => void): () => void
  /** A notification asked for a Settings section (e.g. "backup"). */
  onShowSettings(cb: (section: string) => void): () => void
  /** Windows' Back / Forward app commands (a mouse's side buttons, a keyboard's Back key). */
  onNavigate(cb: (dir: 'back' | 'forward') => void): () => void

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
  backupUpdate(patch: {
    schedule?: BackupSchedule
    keep?: number
    /** Clean up restore safety copies older than 30 days by itself. */
    autoCleanSafety?: boolean
  }): Promise<BackupStatus>
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
  /** "Start with Windows (minimized to tray)", as Windows reports it now. */
  startWithWindows(): Promise<StartWithWindows>
  setStartWithWindows(on: boolean): Promise<StartWithWindows>
  /** The restore safety copies in the app's data folder, and which are older than 30 days. */
  backupSafetyCopies(): Promise<SafetySummary>
  /** Delete these safety copies (only those still older than 30 days, never the newest). */
  backupCleanSafety(names: string[]): Promise<SafetyCleanup>
}
