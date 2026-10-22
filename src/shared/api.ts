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
}
