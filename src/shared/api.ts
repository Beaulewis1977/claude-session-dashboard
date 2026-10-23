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
import type { Account, CreditGrant, CreditsState } from './usage/credits'
import type { CompareResult, CompareSide, TrendGroupBy, TrendsReport } from './usage/trends'

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
  getInfo(): Promise<AppInfo>
  getSessions(): Promise<SessionsPayload>
  onSessionsChanged(cb: (payload: SessionsPayload) => void): () => void
  getSession(key: string): Promise<SessionDetail | null>
  search(query: string): Promise<SearchHit[]>
  updateMeta(key: string, patch: Partial<SessionMeta>): Promise<SessionSummary | null>
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
  compareHealth(
    kind: 'five_hour' | 'seven_day',
    a: CompareRange,
    b: CompareRange
  ): Promise<HealthCompare>
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
  addGrant(grant: Omit<CreditGrant, 'id'>): Promise<CreditGrant | undefined>
  removeGrant(id: string): Promise<void>
  refreshAdmin(id: string): Promise<void>

  // Ask Claude (claude -p with aggregated numbers only)
  askStatus(): Promise<{ available: boolean; where?: string; simulated: boolean }>
  askPreview(question: string): Promise<{ id: string; prompt: string; bytes: number }>
  askRun(previewId: string): Promise<AskHistoryItem>
  askCancel(previewId: string): Promise<void>
  askHistory(): Promise<AskHistoryItem[]>

  // Tray and mini meter
  toggleMiniMeter(): Promise<boolean>
  closeMiniMeter(): Promise<void>
  /** The renderer draws the tray icon (a ring with the 5-hour %) and hands it over as a PNG. */
  setTrayImage(dataUrl: string, tooltip: string): Promise<void>
  onShowUsage(cb: () => void): () => void
}
