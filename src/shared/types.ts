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
import type { CodexPlan, CodexPlanSetting } from './usage/codex'
import type { SourceHints, SourceLabel } from './source-label'
import type { ProviderId, ProviderToggles, ProviderView } from './provider'
import type { EffortChoice, FastChoice, ProjectModelDefault, ResolvedModel } from './model-choice'
import { DEFAULT_LIVE_ALERTS, type LiveAlertSettings } from './live-alerts'
import { DEFAULT_SUMMARY_SETTINGS, type AiSummary, type SummarySettings } from './summary'
import {
  DEFAULT_CONTEXT_WARNING,
  type ContextWarningSettings,
  type ResumeEstimate,
  type SessionContext
} from './context'
import type { AcceptedProject, CodexAppPreview, OpenIn } from './codex-app'
import type { GitBadge, GitLinkSettings } from './git/types'
import type { AskSessionsSettings } from './ask-sessions/types'
import type { RunningCopy } from './running'
import type { ClaudeAppPreview } from './claude-app'

export type EnvKind = 'windows' | 'wsl'

export type SourceStatus = 'ok' | 'missing' | 'unreadable' | 'not-running' | 'skipped'

export interface SourceInfo {
  /** Stable id, also used as the archive sub-folder name. */
  id: string
  /** Which coding agent's sessions this is (always set by the app; absent: Claude Code). */
  provider?: ProviderId
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
  /**
   * The optional "Claude desktop (Cowork)" source: the Claude desktop app's
   * Cowork task homes. View-only; only their `.claude/projects` is read.
   */
  cowork?: boolean
}

/** User-editable metadata. Lives only in the app's own metadata file. */
export interface SessionMeta {
  name?: string
  /** When I last set `name` in the dashboard (compared with a rename in Claude Code). */
  nameAt?: string
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
  /** No "Running now" alerts for this session (desktop or phone). */
  muteAlerts?: boolean
  /** Last launched from the app with Remote Control on (from the desktop or a paired phone). */
  remote?: RemoteTag
  /** Model for launches (`--model`): an alias or ID, "default" for none; unset = the project / Settings default. */
  model?: string
  /** Effort for launches (`--effort`); unset = the project / Settings default. */
  effort?: EffortChoice
  /** Fast mode for launches ("off": no flag); unset = the project / Settings default. */
  fast?: FastChoice
  /** The AI summary of the session (written with `claude -p`, editable). */
  aiSummary?: AiSummary
  /** "Don't warn for this session": no large-context warning before Resume. */
  noContextWarning?: boolean
  /** Codex: open Resume / Fork / Continue fresh in a terminal or the Codex app; unset = the project / Settings default. */
  openIn?: OpenIn
  /** Commits I unlinked from this session in the Changes tab (full SHAs; never written to git or the agent's files). */
  gitUnlinked?: string[]
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
  /**
   * 'app': Branch from here (a new file). 'fork': `--fork-session` from the app.
   * 'continue': Continue fresh (a new session started from the parent's summary).
   */
  via: 'app' | 'fork' | 'continue'
  /** Transcript message the branch ends with (for 'app'). */
  atMessageId?: string
  atPreview?: string
  /** The cut was moved to keep tool calls with their results. */
  snapped?: 'forward' | 'backward'
  createdAt: string
}

export interface ArchiveRecord {
  /** Not written for Claude Code sessions (absent means Claude Code, as in every older record). */
  provider?: ProviderId
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
  /** Decompressed size of what was copied (Codex; absent: the same as `size`). */
  contentSize?: number
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

/**
 * name         – the name I set in the dashboard.
 * claude-name  – the name given in Claude Code (`/rename`, Remote Control).
 * summary      – Claude's automatic title.
 * first-prompt – the first user message, cut short.
 */
export type TitleSource = 'name' | 'claude-name' | 'summary' | 'first-prompt' | 'fallback'

export interface SessionSummary {
  /** Unique key in the app: `${sourceId}:${sessionId}`. */
  key: string
  /** Which coding agent ran it (always set by the app; absent: Claude Code). */
  provider?: ProviderId
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
  /** Claude's own automatic title (`summary` / `ai-title` line), if present. */
  summary?: string
  /** The name given in Claude Code (`/rename`, Remote Control), if any. Read-only. */
  claudeName?: string
  /** When it was set in Claude Code, if known. */
  claudeNameAt?: string
  firstPrompt?: string
  startedAt?: string
  lastActivityAt?: string
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  malformedLines: number
  sizeBytes: number
  /** Every model the session used, in the order each first appeared. */
  models: string[]
  /** The model of its last reply (what a resume continues on without --model). */
  lastModel?: string
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
  /** How big the context is (the last reply's usage, compaction, the status line). */
  context?: SessionContext
  /** The reasoning effort recorded in the session's latest turn (Codex). */
  reasoningEffort?: string
  /** A thread another agent thread started (a Codex subagent). */
  subagent?: { parentId?: string; nickname?: string; role?: string }
  /** The session this one was forked from, as its own file records it (Codex). */
  forkedFromId?: string
  /** Git commit and remote recorded when the session started (Codex). */
  gitCommit?: string
  gitRemote?: string
  /** Which Codex client ran it, as its file records it. */
  origin?: { originator?: string; source?: string; threadSource?: string }
  /** Why the conversation shown may not be complete (the viewer says so). */
  historyNote?: string
  /** Search across sessions covers only the start of it (very long Codex sessions; the viewer says so). */
  searchPartial?: boolean
  /** The file's content size, decompressed (Codex; for archive decisions). */
  contentBytes?: number
  /** Git links: linked commits and pull requests, for the card badge ("3 commits · PR #14"). */
  git?: GitBadge
  /**
   * Read, search, usage and git links only; never launched or summarized
   * ('cowork': a Claude desktop Cowork session, from the optional Cowork source).
   */
  viewOnly?: 'cowork'
}

export interface ToolResult {
  text: string
  isError: boolean
  /** Number of images that were part of the result. */
  images?: number
  /**
   * Sent cut (a long output, see transcript-cut.ts): `text` is its start, and
   * the full text has this many characters and lines. `lazy`: a placeholder (a
   * very long transcript's): the viewer loads the output when it's opened.
   */
  cut?: { chars: number; lines: number; lazy?: true }
}

/**
 * One long string of a tool call's input that was sent cut (see
 * transcript-cut.ts): where it is in the input (no path: the input is that
 * string), and its full size.
 */
export interface InputCut {
  path: (string | number)[]
  chars: number
  lines: number
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
      /** Long strings of `input` sent cut (their start only); the full input is asked for. */
      inputCut?: InputCut[]
      /** The input's long strings are placeholders (a very long transcript): loaded when it's opened. */
      inputLazy?: true
    }
  | { type: 'tool_result'; toolUseId: string; result: ToolResult }
  | { type: 'image'; mediaType?: string }
  /**
   * A message between agents (Codex `agent_message`: a subagent's report to
   * the main agent, or the main agent's instructions to a subagent).
   * `author` / `recipient` are agent paths such as "/root" or "/root/worker".
   */
  | { type: 'agent_message'; author: string; recipient: string; text: string }

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
  /** Model for launches unless a session or project has its own ("default" = Claude Code's). */
  defaultModel: string
  /** Effort level for launches unless a session or project has its own. */
  defaultEffort: EffortChoice
  /** Per-project model / effort / fast-mode defaults, keyed by lower-cased cwd. */
  projectModels: Record<string, ProjectModelDefault>
  /** Fast mode for launches unless a session or project has its own (absent: off). */
  defaultFast?: FastChoice
  /** Running now: which session events alert, quiet hours, where. */
  liveAlerts: LiveAlertSettings
  /** Session summaries: model, auto-summarize, the limits guard. */
  summaries: SummarySettings
  /** The large-session warning before Resume. */
  contextWarning: ContextWarningSettings
  // Optional: absent in every settings file written before Codex support
  // (each has a default, applied where it's read).
  /** Settings → Providers: which coding agents are on (absent: both). */
  providers?: ProviderToggles
  /** The All / Claude / Codex switch (absent: All). Only filters what's shown. */
  providerView?: ProviderView
  /** Settings → Archive: which Codex sessions are copied into the archive (absent: none). */
  codexArchive?: CodexArchiveMode
  /** Show Codex subagent threads in the list (absent: hidden). */
  showSubagents?: boolean
  /** Codex launches: model unless a session or project has its own ("default" = Codex's own). */
  codexDefaultModel?: string
  /** Codex launches: reasoning effort unless a session or project has its own. */
  codexDefaultEffort?: EffortChoice
  /** Codex per-project model / effort / fast-mode defaults, keyed like projectModels. */
  codexProjectModels?: Record<string, ProjectModelDefault>
  /** Codex launches: fast mode unless a session or project has its own (absent: off). */
  codexDefaultFast?: FastChoice
  /**
   * Codex launches: --dangerously-bypass-approvals-and-sandbox by default (each
   * launch can still change it; never from a phone). Absent in settings files
   * from before it: set at startup from skipPermissionsDefault, which it shared.
   */
  codexBypassDefault?: boolean
  /** Codex launches: open in a terminal or the Codex app unless a session or project has its own (absent: terminal). */
  codexOpenInDefault?: OpenIn
  /** Codex per-project "Open in" defaults, keyed like projectModels. */
  codexProjectOpenIn?: Record<string, OpenIn>
  // Codex usage & limits (Phase C). Kept apart from Claude Code's plan, baseline and prices.
  /** Codex plan for limit health: detected from the logs (absent: "auto") or chosen. */
  codexPlan?: CodexPlanSetting
  /**
   * Different plan_types in Codex's logs are separate sign-ins (absent) or one
   * account that changed plan (the logs can't tell which).
   */
  codexAccounts?: CodexAccounts
  /** Codex plan multipliers (relative to Plus), where changed from the defaults. */
  codexPlanMults?: Partial<Record<CodexPlan, number>>
  /** Codex limit health: its own normal dates, threshold and streak. */
  codexHealth?: HealthSettings
  /** Time ranges marked as "used Codex elsewhere" (ChatGPT, Codex cloud…). */
  codexElsewhere?: ElsewhereRange[]
  /** Codex's price table: OpenAI API prices (absent: the bundled snapshot). */
  codexPrices?: ModelPrice[]
  /** Tray icon, mini meter and status bar: whose limits (absent: Claude). */
  meterProvider?: MeterProvider
  /** Usage charts in the All view: stacked or split by provider (absent: stacked). */
  usageSplit?: UsageSplit
  /** Git links: on/off, and whether the GitHub CLI may look up pull requests (absent: on, ask). */
  gitLinks?: GitLinkSettings
  /** Ask across sessions (content questions off until turned on; see ask-sessions/types.ts). */
  askSessions?: AskSessionsSettings
  /**
   * Settings → Sources: also show the Claude desktop app's Cowork sessions
   * (view-only; absent: off). Only their `.claude/projects` is read; never a
   * sign-in file. Their archive copies are backed up only while this is on.
   */
  coworkSource?: boolean
}

export type MeterProvider = 'claude' | 'codex' | 'both'
export type CodexAccounts = 'separate' | 'one'
export type UsageSplit = 'stacked' | 'split'

/**
 * Which Codex sessions are copied into the archive: none, only the ones I
 * named, pinned or tagged, or all. Codex doesn't delete old sessions itself,
 * so it's off by default.
 */
export type CodexArchiveMode = 'off' | 'marked' | 'all'

export function isCodexArchiveMode(v: unknown): v is CodexArchiveMode {
  return v === 'off' || v === 'marked' || v === 'all'
}

export interface ArchiveTally {
  sessions: number
  /** Their files' size now. */
  bytes: number
  /** What isn't in the archive yet (new sessions, and growth of archived ones). */
  newBytes: number
  /** Estimated size in a backup (gzip; compressed rollouts don't shrink). */
  backupBytes: number
}

export interface CodexArchiveEstimate {
  all: ArchiveTally
  marked: ArchiveTally
  /** Codex sessions already in the archive, and their size. */
  archived: number
  archivedBytes: number
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
  remoteControlDefault: false,
  defaultModel: 'default',
  defaultEffort: 'default',
  projectModels: {},
  liveAlerts: DEFAULT_LIVE_ALERTS,
  summaries: DEFAULT_SUMMARY_SETTINGS,
  contextWarning: DEFAULT_CONTEXT_WARNING
}

export interface ScanState {
  phase: 'idle' | 'scanning' | 'ready'
  done: number
  total: number
  /** When the last full scan of the sources finished (epoch ms). */
  finishedAt?: number
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
  /** Continue fresh: a new session whose first message is this session's summary. */
  continueFresh?: ContinueFreshRequest
  /**
   * Opt in to resuming a session whose folder exists only in WSL with Windows
   * Codex, in that folder through `\\wsl.localhost\…` (see LaunchPlacement).
   * Desktop only; approvals are then always on.
   */
  wslFolder?: boolean
  /** The WSL distro that holds that folder (unset: the default distro). */
  distro?: string
  /**
   * Codex: open in the Codex desktop app instead of a terminal (desktop and phone; see codex-app.ts).
   * Claude Code: 'claude-app' hands a Windows session to the Claude desktop app
   * (`claude --desktop --resume <id>`; desktop only, see claude-app.ts).
   */
  openIn?: OpenIn | 'claude-app'
  /**
   * Start it even though it (or a fork / continuation of it) is already running
   * on the PC ("Start another copy anyway", after a confirm). Unset: refused.
   */
  allowDuplicate?: boolean
  /**
   * Continue fresh in the Codex app: the project whose folder holds this one, as
   * the dialog showed it ("Use that project anyway?"). Used only if it's still that project.
   */
  codexAppProject?: AcceptedProject
}

/**
 * A session whose folder belongs to the other environment than the `.codex`
 * folder that holds it (the Codex desktop app on Windows can run its agent in
 * WSL and still keeps the session in the Windows `.codex`). Codex always runs
 * where its `.codex` is (its SQLite database can't be used across the WSL /
 * Windows boundary); only the working folder is translated:
 * - `translated`: `/mnt/c/x` → `C:\x` (Windows `.codex`), or `C:\x` →
 *   `/mnt/c/x` (WSL `.codex`). Resumes as usual.
 * - `wsl-only`: a Linux-only folder (`/home/…`) in the Windows `.codex`. Not
 *   resumed unless opted in (`wslFolder`): then Windows Codex runs in
 *   `\\wsl.localhost\<distro>\…`, always asking before commands.
 */
export interface LaunchPlacement {
  kind: 'translated' | 'wsl-only'
  /** Where Codex runs. */
  runIn: EnvKind
  /** The folder as the run sees it. */
  cwd: string
  /** Why, in a sentence or two. */
  reason: string
  /** wsl-only: the distro holding the folder, and the ones to choose from. */
  distro?: string
  distros: string[]
  /** wsl-only: resuming with Windows Codex was opted in. */
  optedIn?: boolean
  /**
   * Bypass is off whatever was chosen, and Codex runs in its read-only sandbox
   * (`-a on-request -s read-only`): a command that would change anything needs approval.
   * Codex has no policy that asks before every command.
   */
  askForced?: boolean
  /** The agent's own app can open this session (Codex: `codex://threads/<id>`). */
  appLink?: boolean
  /**
   * The folder couldn't be confirmed in WSL (`wslpath`), so it isn't guessed:
   * nothing is launched until a folder is chosen in the dialog.
   */
  needsFolder?: boolean
}

export interface ContinueFreshRequest {
  /** The id shown in the preview, so the copied command matches what gets started. */
  newSessionId?: string
}

export interface ContinueFreshPreview {
  newSessionId: string
  /** Where the handoff file will be written (the app's data folder). */
  handoffPath: string
  /** The same path as the new session sees it (a /mnt/… path in WSL). */
  sessionPath: string
  /** "mention": @-mention in the first message; "read": "read this file" (path with spaces). */
  mode: 'mention' | 'read'
  /** The handoff text that will be written. */
  handoff: string
  /** New messages in the session since the summary was written. */
  newSince: number
  name: string
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
  /** The model of the last reply the branch keeps (undefined: none). */
  lastModel?: string
}

export interface LaunchPreview {
  /** Command line as it will be run (for display / copy). */
  commandLine: string
  /** Just the `claude ...` part (for Codex with its CODEX_HOME, when that's set). */
  claudeCommand: string
  /** Where to run claudeCommand when that isn't just the folder (PowerShell, a WSL user). */
  agentNote?: string
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
  /** The model and effort the launch uses, and where they come from. */
  modelChoice?: ResolvedModel
  /** For Continue fresh: the handoff, or why there is none. */
  continueFresh?: ContinueFreshPreview
  continueError?: string
  /** Resume / Fork: the context size and what reloading it would cost (estimate). */
  context?: ResumeEstimate
  /** Runs in the other environment than its home (see LaunchPlacement). */
  placement?: LaunchPlacement
  /** Codex: whether this launch can open in the Codex app, and where (absent: not a Codex session). */
  codexApp?: CodexAppPreview
  /** Claude Code: whether it can open in the Claude desktop app (absent: not offered at all). */
  claudeApp?: ClaudeAppPreview
  /** It (or a fork / continuation of it) is already running on the PC. */
  running?: RunningCopy
}

export interface LaunchResult {
  ok: boolean
  restored: boolean
  commandLine: string
  error?: string
  simulated?: boolean
  /** The new branch (created even if opening the terminal then failed). */
  branch?: SessionSummary
  /** Continue fresh: the key the new session will have once Claude Code writes it. */
  continuedKey?: string
  /** Opened in the Codex app (or the Claude desktop app) instead of a terminal. */
  openedIn?: 'codex-app' | 'claude-app'
  /** Refused: it's already running on the PC (see LaunchOptions.allowDuplicate). */
  running?: RunningCopy
  /** Something to tell after opening (Fork in the Codex app: use its menu). */
  note?: string
}

export interface SessionsPayload {
  sessions: SessionSummary[]
  sources: SourceInfo[]
  scan: ScanState
  /** Which list this is for the window that got it (deltas name the one they apply to). */
  version?: number
}

/** Settings → "Start with Windows (minimized to tray)", as Windows reports it now. */
export interface StartWithWindows {
  /** Offered here (Windows, installed or portable app). */
  supported: boolean
  on: boolean
  /** Why it isn't offered. */
  reason?: string
  /** On, but turned off in Task Manager → Startup (Windows skips it). */
  disabledInTaskManager?: boolean
  /** Registered for another copy of the app (this path), not this one. */
  otherCopy?: string
}
