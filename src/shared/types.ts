// Types shared by the main process, preload bridge and renderer.

import { DEFAULT_PRICES, type ModelPrice } from './usage/pricing'
import type { WeekStart } from './usage/types'
import type { SessionBilling } from './usage/credits'
import { DEFAULT_WEIGHTS, type CapacityWeights, type Plan } from './usage/limits'
import type { ForkedFrom } from './jsonl'
import type { SessionLineage } from './lineage'
import {
  DEFAULT_HEALTH,
  type ElsewhereRange,
  type HealthSettings,
  type PlanChange
} from './usage/health'
import { DEFAULT_PACE, type PaceSettings } from './usage/pace'
import type { SourceHints, SourceLabel } from './source-label'

export type EnvKind = 'windows' | 'wsl'

export type SourceStatus = 'ok' | 'missing' | 'unreadable' | 'not-running' | 'skipped'

export interface SourceInfo {
  /** Stable id, also used as the archive sub-folder name. */
  id: string
  /** Human label, e.g. "Windows" or "WSL: Ubuntu". */
  label: string
  env: EnvKind
  distro?: string
  /** Linux user name for WSL sources. */
  user?: string
  /** Absolute path (as seen from Windows) of the `projects` directory. */
  projectsDir: string
  kind: 'auto' | 'custom'
  status: SourceStatus
  statusMessage?: string
  sessionCount: number
  /** Path of Claude's settings.json for this home, if known. */
  claudeSettingsPath?: string
  /** `cleanupPeriodDays` from Claude's settings. `null` = not set (Claude's default applies). */
  cleanupPeriodDays?: number | null
}

/** User-editable metadata. Lives only in the app's own metadata file. */
export interface SessionMeta {
  name?: string
  description?: string
  tags?: string[]
  hidden?: boolean
  /** How the session is billed: tagged when launched from the app, or set by hand. */
  billing?: {
    mode: 'subscription' | 'api'
    accountId?: string
    source: 'launch' | 'manual'
    at?: string
  }
  /** Set by the app when this session was made with "Branch from here" or Fork. */
  branch?: BranchRecord
  /** Which product ran the session: detected ("auto") or set by hand ("manual"). */
  source?: { label: SourceLabel; by: 'auto' | 'manual'; reason?: string }
  /** Kept at the top of the session list. */
  pinned?: boolean
  /** Last launched from the app with Remote Control on (from the desktop or a paired phone). */
  remote?: RemoteTag
  updatedAt?: string
}

export interface RemoteTag {
  at: string
  via: 'desktop' | 'phone'
  /** The paired phone's name, for launches from a phone. */
  device?: string
}

export interface BranchRecord {
  parentSessionId: string
  parentKey?: string
  /** 'app': Branch from here (a new file). 'fork': `--fork-session` from the app. */
  via: 'app' | 'fork'
  /** Transcript message the branch ends with (for 'app'). */
  atMessageId?: string
  atPreview?: string
  /** The cut was moved to keep tool calls with their results. */
  snapped?: 'forward' | 'backward'
  createdAt: string
}

export interface ArchiveRecord {
  sessionId: string
  sourceId: string
  sourceLabel: string
  env: EnvKind
  distro?: string
  /** Absolute original path of the session file (Windows-visible path). */
  originalPath: string
  /** Absolute path of the archived copy. */
  archivePath: string
  cwd?: string
  size: number
  sha256: string
  sourceMtimeMs: number
  firstArchivedAt: string
  archivedAt: string
  /** Imported view-only conversation (not a Claude Code session file). */
  origin?: 'claude-ai'
}

/**
 * live           – the original file exists in `.claude/projects`.
 * archived-only  – the original file is gone, only the app's archive copy remains.
 * source-offline – the source (e.g. a stopped WSL distro) can't be read right now;
 *                  showing the archive copy.
 * imported       – a view-only conversation imported from a claude.ai data export.
 */
export type Availability = 'live' | 'archived-only' | 'source-offline' | 'imported'

export type TitleSource = 'name' | 'summary' | 'first-prompt' | 'fallback'

export interface SessionSummary {
  /** Unique key in the app: `${sourceId}:${sessionId}`. */
  key: string
  sessionId: string
  sourceId: string
  sourceLabel: string
  env: EnvKind
  distro?: string
  /** File the data was read from (the original, or the archive copy). */
  filePath: string
  originalPath: string
  archivePath?: string
  availability: Availability
  /** Encoded project folder name under `.claude/projects`. */
  projectDir: string
  /** Friendly project name (last segment of cwd). */
  projectName: string
  cwd?: string
  gitBranch?: string
  version?: string
  /** Claude's own `summary` line, if present. */
  summary?: string
  firstPrompt?: string
  startedAt?: string
  lastActivityAt?: string
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  malformedLines: number
  sizeBytes: number
  models: string[]
  meta: SessionMeta
  title: string
  titleSource: TitleSource
  /** Subscription or API billing (tag, bridge inference, or unknown). */
  billing?: SessionBilling
  /** uuid of the first prompt; forks and branches share it. */
  firstUuid?: string
  /** `forkedFrom` marker in the file (Claude Code's `/branch`, or this app's branches). */
  forkedFrom?: ForkedFrom
  /** The file's entries carry this other session's id (an older-style copy). */
  copiedFrom?: string
  /** Where this session was branched or forked from, if known. */
  lineage?: SessionLineage
  /** Signals read from the file, for the source label. */
  sourceHints?: SourceHints
  /** claude.ai/code link of the session's latest Remote Control connection (from the file). */
  remoteUrl?: string
  /** When Claude Code recorded that link. */
  remoteUrlAt?: string
  /** Which product ran it (manual override, else detected). */
  source: SourceLabel
  sourceReason: string
}

export interface ToolResult {
  text: string
  isError: boolean
  /** Number of images that were part of the result. */
  images?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: unknown
      label: string
      result?: ToolResult
    }
  | { type: 'tool_result'; toolUseId: string; result: ToolResult }
  | { type: 'image'; mediaType?: string }

export type MessageKind =
  'prompt' | 'response' | 'command' | 'command-output' | 'compact' | 'system'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  kind: MessageKind
  timestamp?: string
  model?: string
  blocks: ContentBlock[]
}

export interface SessionDetail {
  summary: SessionSummary
  messages: ChatMessage[]
}

export type ThemePref = 'light' | 'dark' | 'system'
export type TerminalPref = 'wt' | 'powershell' | 'cmd'

export interface AppSettings {
  skipPermissionsDefault: boolean
  terminal: TerminalPref
  theme: ThemePref
  /** Extra folders to scan (a `.claude` folder, a `projects` folder, or a folder of projects). */
  extraFolders: string[]
  /** Accessing a stopped WSL distro boots it, so this is off by default. */
  scanStoppedDistros: boolean
  /** First day of the week for usage charts. */
  weekStart: WeekStart
  /** API prices used for cost estimates (USD per million tokens). */
  prices: ModelPrice[]
  /** Claude plan, for labels and expectations. */
  plan: Plan
  /** Desktop notifications when a limit window passes these percentages. */
  alertsEnabled: boolean
  alertThresholds: number[]
  /** Token weights for the implied-capacity estimate. */
  capacityWeights: CapacityWeights
  /** Default billing for launches: 'subscription' or an API account id. */
  defaultBilling: string
  /** Per-project billing defaults, keyed by lower-cased cwd. */
  projectBilling: Record<string, string>
  /** How often to refresh Admin API reports (minutes, 0 = only on demand). */
  adminRefreshMinutes: number
  /** The user has seen and accepted the "Branch from here" explanation. */
  branchConfirmed: boolean
  /** Plan changes over time, for the limit-health score. Empty = `plan` all along. */
  planHistory: PlanChange[]
  /** Limit-health detector: baseline dates, threshold, streak. */
  health: HealthSettings
  /** Pace targets for the gauges. */
  pace: PaceSettings
  /** Time ranges marked by hand as "used Claude elsewhere". */
  elsewhere: ElsewhereRange[]
  /** Ask Claude: skip the "what will be sent" preview. */
  askSkipPreview: boolean
  /** Ask Claude: give up after this many seconds. */
  askTimeoutSec: number
  /** Turn Remote Control on for Resume / Fork / Branch by default. */
  remoteControlDefault: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  skipPermissionsDefault: true,
  terminal: 'wt',
  theme: 'system',
  extraFolders: [],
  scanStoppedDistros: false,
  weekStart: 'monday',
  prices: DEFAULT_PRICES,
  plan: 'max5',
  alertsEnabled: true,
  alertThresholds: [75, 90],
  capacityWeights: DEFAULT_WEIGHTS,
  defaultBilling: 'subscription',
  projectBilling: {},
  adminRefreshMinutes: 60,
  branchConfirmed: false,
  planHistory: [],
  health: DEFAULT_HEALTH,
  pace: DEFAULT_PACE,
  elsewhere: [],
  askSkipPreview: false,
  askTimeoutSec: 180,
  remoteControlDefault: false
}

export interface ScanState {
  phase: 'idle' | 'scanning' | 'ready'
  done: number
  total: number
}

export interface AppInfo {
  version: string
  platform: string
  fixtures: boolean
  /** Added to Date.now() for the app's clock (non-zero in fixtures mode). */
  clockOffset: number
  dataDir: string
  archiveDir: string
}

export interface ArchiveStats {
  dir: string
  files: number
  bytes: number
}

export interface LaunchOptions {
  key: string
  fork: boolean
  skipPermissions: boolean
  /** Override for the working directory (when the original no longer exists). */
  cwdOverride?: string
  terminal?: TerminalPref
  /** Run on API credits with this account's key (undefined = the Claude subscription). */
  billingAccountId?: string
  /** Start a new session in the folder instead of resuming. */
  newSession?: boolean
  /** Branch from a message: create a new session file, then resume it. */
  branch?: BranchRequest
  /** Start with Remote Control on, named after the session (subscription only). */
  remoteControl?: boolean
  /** Force the prompting permission mode (launches from a phone). */
  askPermissions?: boolean
}

export interface BranchRequest {
  /** Transcript message id. */
  at: string
  /** 'include' keeps the message; 'before' keeps only what came before it. */
  mode: 'include' | 'before'
  /** The id shown in the preview, so the copied command matches what gets created. */
  newSessionId?: string
  /** Create the branch without opening a terminal. */
  createOnly?: boolean
}

export interface BranchPreview {
  newSessionId: string
  /** Where the new session file will be written. */
  targetPath: string
  atMessageId: string
  atRole: 'user' | 'assistant'
  atPreview: string
  atTime?: string
  snapped: 'none' | 'forward' | 'backward'
  snapTools: string[]
  keptMessages: number
  totalMessages: number
  name: string
}

export interface LaunchPreview {
  /** Command line as it will be run (for display / copy). */
  commandLine: string
  /** Just the `claude ...` part. */
  claudeCommand: string
  terminal: TerminalPref
  /** True if the requested terminal was not found and a fallback is used. */
  fellBack: boolean
  cwd?: string
  cwdExists: boolean
  /** The original file is missing and will be restored from the archive first. */
  willRestore: boolean
  /** Restoring is needed but impossible (no archive copy). */
  restoreImpossible: boolean
  originalPath: string
  /** API billing: Windows Terminal can't take the key safely, so PowerShell is used. */
  terminalReason?: string
  billingLabel: string
  /** For a branch: what will be kept, or why it can't be made. */
  branch?: BranchPreview
  branchError?: string
  /** Why this can't be launched (e.g. Claude Code not found, a folder that can't be checked). */
  launchError?: string
  /** The Remote Control session name, when Remote Control is on and a name is left after cleaning. */
  remoteControlName?: string
}

export interface LaunchResult {
  ok: boolean
  restored: boolean
  commandLine: string
  error?: string
  simulated?: boolean
  /** The new branch (created even if opening the terminal then failed). */
  branch?: SessionSummary
}

export interface SessionsPayload {
  sessions: SessionSummary[]
  sources: SourceInfo[]
  scan: ScanState
}
