// The provider interface: everything about one coding agent's sessions that
// the generic services (catalogue, archive, launcher, usage, limits, Running
// now, summaries) need, so they never read an agent's files or build its
// commands themselves: ClaudeProvider (./claude) and CodexProvider (./codex).

import type { ProviderCapabilities, ProviderId } from '@shared/provider'
import type { BranchMode, BranchPlanOk } from '@shared/branch'
import type { MessageStart } from '@shared/lineage'
import type { HookEvent, RunningFile } from '@shared/live'
import type { HandoffMode } from '@shared/summary'
import type { DetectedSource, SourceContext } from '@shared/source-label'
import type { EffortLevels } from '@shared/model-choice'
import type { BridgeReading } from '@shared/usage/bridge'
import type { UsageContext } from '@shared/usage/parse'
import type { UsageAnalysis } from '@shared/usage/types'
import type { ChatMessage, EnvKind, SessionSummary, SourceInfo } from '@shared/types'
import type {
  ContinueFreshArgs,
  LaunchCommand,
  LaunchInput,
  LaunchTools,
  ModelChoice,
  RemoteControl
} from '../core/launch'
import type { Platform } from '../platform'
import type { DetectOptions, ResolvedSource } from '../services/sources'

/** One session file found in a source. */
export interface SessionFile {
  path: string
  /** Folder it is in (Claude Code: the encoded project folder). */
  projectDir: string
  sessionId: string
  size: number
  mtimeMs: number
}

/** A session as read from its file, before the app's metadata is added. */
export type BaseSummary = Omit<
  SessionSummary,
  'meta' | 'title' | 'titleSource' | 'billing' | 'lineage' | 'source' | 'sourceReason' | 'provider'
>

export type SourceRef = Pick<SourceInfo, 'id' | 'label' | 'env' | 'distro'>

export type { ProviderCapabilities }

/** The agent's own command (`claude …`), without the terminal around it. */
export interface CliInput {
  sessionId: string
  skipPermissions: boolean
  fork: boolean
  newSession?: boolean
  remoteControl?: RemoteControl
  askPermissions?: boolean
  /** With askPermissions: the read-only sandbox (Codex `-s read-only`), for a WSL folder run from Windows. */
  readOnly?: boolean
  modelChoice?: ModelChoice
  continueFresh?: ContinueFreshArgs
}

/** A planned "Branch from here", ready to be written as a new session file. */
export type ProviderBranchPlan =
  | (BranchPlanOk & {
      /** The new session file's content. */
      build(newSessionId: string, parentSessionId: string): string
    })
  | { ok: false; error: string }

/** Where a home's "Running now" files are. */
export interface LiveDirs {
  src: SourceInfo
  /** Running-session files (one per process). */
  sessionsDir: string
  /** Events saved by the app's hook script. */
  eventsDir: string
  home: string
}

/** A home's status line bridge (live plan limits and context). */
export interface BridgeDirs {
  home: string
  bridgeDir: string
}

export interface SessionProvider {
  readonly id: ProviderId
  /** The product's name in messages, e.g. "Claude Code". */
  readonly productName: string
  readonly capabilities: ProviderCapabilities

  // ------------------------------------------------------------ discovery
  /** Every place this agent's sessions can live (Windows, each WSL home, extra folders). */
  detectSources(platform: Platform, opts: DetectOptions): Promise<ResolvedSource[]>
  /** The session files in a source; undefined if it can't be read. */
  listSessionFiles(src: ResolvedSource): Promise<SessionFile[] | undefined>
  /** A path seen by the watcher: its session, or undefined if it isn't a session file. */
  sessionFileOf(path: string): { sessionId: string; projectDir: string } | undefined
  /** What to watch for live updates. */
  watchSpec(src: ResolvedSource): {
    root: string
    depth: number
    isSessionFile(path: string): boolean
  }

  /** The effort levels its launches accept. */
  readonly effortLevels: EffortLevels
  /**
   * Bumped when its parsing changes, so the startup cache reads its files again
   * (Claude Code has none: its cache is versioned with the whole cache file).
   */
  readonly parseVersion?: number

  // -------------------------------------------------------------- parsing
  /**
   * A session file's text as the parsing functions below take it. `purpose`:
   * "view" (showing or searching it) may stop early on a huge file; "summary"
   * (the default) reads it to the end.
   */
  readText(path: string, purpose?: 'summary' | 'view'): Promise<string>
  parseSession(
    text: string,
    file: Omit<SessionFile, 'mtimeMs'>,
    src: SourceRef
  ): { base: BaseSummary; searchText: string }
  buildMessages(text: string, base: BaseSummary): ChatMessage[]
  /** The text indexed for full-text search. */
  searchText(text: string): string
  /** Where each message starts (ids and times), to tell forks and branches apart. */
  messageStarts(text: string): MessageStart[]
  /** Which product ran it (terminal, VS Code, …). */
  detectSource(base: BaseSummary, ctx: SourceContext): DetectedSource
  /** A title for the dashboard's own runs (Ask, summaries), from their first prompt. */
  ownRunTitle(firstPrompt: string | undefined): string | undefined

  /** The agent's own names for its sessions (e.g. Codex thread names), when they're kept outside the session files. */
  names?: {
    get(sourceId: string, sessionId: string): { name: string; at?: string } | undefined
    /** Re-read a source's names if they changed; returns the session ids whose name changed. */
    refresh(src: ResolvedSource): Promise<string[]>
  }

  // -------------------------------------------------------------- archive
  /** File extension of the archive copy (".jsonl"). */
  readonly archiveExt: string
  /** The archive copy's extension for one file, when it varies (Codex: ".jsonl" or ".jsonl.zst"). */
  archiveExtOf?(originalPath: string): string
  /** The folder name an archived session was in, from its original path. */
  projectDirOf(originalPath: string): string

  // --------------------------------------------------------------- launch
  launch: {
    /** The agent's command can't be found (it isn't installed, or not on PATH). */
    cliMissing(env: EnvKind, tools: LaunchTools): boolean
    /** The full launch: terminal, folder, environment and the agent's command. */
    buildCommand(input: LaunchInput): LaunchCommand
    /** Just the agent's command line, for display when the full one can't be built. */
    commandLine(input: CliInput): string
    /** Continue fresh: the first message pointing at the handoff file. */
    handoffPrompt(path: string): { prompt: string; mode: HandoffMode } | undefined
    /** Who and which home the agent runs as for a source (Codex: the WSL user, or CODEX_HOME). */
    target?(src: ResolvedSource): Pick<LaunchInput, 'wslUser' | 'agentEnv'>
    /**
     * Its sessions can have a folder from the other environment than the home
     * that holds them (Codex: the desktop app on Windows runs its agent in
     * WSL). The agent still runs where its home is; only the folder is
     * translated (see Launcher.place).
     */
    crossEnvFolders?: boolean
    /** A link that opens the session in the agent's own app (Codex: `codex://threads/<id>`). */
    appLink?(sessionId: string): string | undefined
    /** The file a new session with this id would have, next to the session's own. */
    sessionFilePath(s: SessionSummary, sessionId: string): string
  }

  branching: {
    /** The folder a branch's new file goes into. */
    projectDir(s: SessionSummary): string
    filePath(projectDir: string, sessionId: string): string
    plan(text: string, at: string, mode: BranchMode): ProviderBranchPlan
    /** Write the new file (exclusively: never overwrites). Returns its path. */
    write(projectDir: string, sessionId: string, content: string): Promise<string>
  }

  // ---------------------------------------------------------------- usage
  usage: {
    /** More files with this session's usage (Claude Code: subagent transcripts). */
    extraFiles(s: SessionSummary): Promise<{ path: string; size: number }[]>
    /** Where the archive keeps copies of those files. */
    extrasArchiveDir(archivePath: string, sessionId: string): string
    analyze(text: string, ctx: UsageContext): UsageAnalysis
    /**
     * The text `analyze` takes, when a plain UTF-8 read isn't it (Codex:
     * compressed rollouts, and only the lines usage needs, from the whole file).
     */
    readText?(path: string): Promise<string>
  }

  /** Live plan limits through a status line bridge (optional). */
  limits?: {
    bridge(src: SourceInfo): BridgeDirs | undefined
    parseReading(text: string, meta: { ts: number; source: string }): BridgeReading | undefined
  }

  /** "Running now" (optional). */
  live?: {
    dirs(src: SourceInfo): LiveDirs | undefined
    parseRunning(text: string): RunningFile | undefined
    parseHook(text: string, meta: { ts: number; source: string }): HookEvent | undefined
    /** Can session alerts (the hook bridge) be turned on for this home? */
    hooksPossible(src: SourceInfo): boolean
  }
}
