// Git links (docs/ROADMAP.md, feature 6): which commits, branches and pull
// requests each session produced. Types shared by the main process (which
// runs git, read-only) and the renderer (desktop and phone).

/** A commit a session's own tool output showed (a `git commit` call's result). */
export interface SeenCommit {
  /** 7 to 40 hex characters, lower case. */
  sha: string
  /** `[branch abc1234] …`: git's own commit line. `chained`: a SHA at a line start (a chained `git log --oneline -1`). */
  kind: 'commit-line' | 'chained'
  branch?: string
  subject?: string
  /** When the tool call was made and when its result came back (epoch ms). */
  from: number
  to: number
}

/** A pull request a session's own `gh pr create` printed. */
export interface SeenPr {
  owner: string
  repo: string
  number: number
  url: string
  at: number
}

/**
 * What a session's file says about its git work, read during the normal
 * parse (no extra file reads). Copied history (a branch's or fork's lines
 * from its parent) is left out.
 */
export interface SessionGitSignals {
  /** Branches the session was on (Claude Code: `gitBranch` of its events; Codex: at the start). */
  branches: string[]
  /** Files it edited (as the tool named them: absolute, or relative to the session's folder). */
  files: string[]
  /** When it last edited each of them (epoch ms, 0 when unknown), in the same order. */
  filesAt?: number[]
  commits: SeenCommit[]
  prs: SeenPr[]
  /** Active stretches, [start, end] in epoch ms: its own event times split at 30-minute gaps. */
  spans: [number, number][]
  /** claude.ai/code session links: its Remote Control links and the `Claude-Session` trailers it wrote. */
  sessionUrls: string[]
  /** Codex: HEAD and remote when the session started. */
  head?: string
  remote?: string
}

export const SPAN_GAP_MS = 30 * 60_000
/** Caps per session, so one huge session can't fill the cache. */
export const MAX_SIGNAL_FILES = 2000
export const MAX_SIGNAL_COMMITS = 500
export const MAX_SIGNAL_PRS = 100
export const MAX_SIGNAL_SPANS = 500

export type LinkLevel = 'exact' | 'high' | 'medium' | 'low'

export const LEVEL_RANK: Record<LinkLevel, number> = { exact: 3, high: 2, medium: 1, low: 0 }

export const LEVEL_LABEL: Record<LinkLevel, string> = {
  exact: 'Exact',
  high: 'High',
  medium: 'Medium',
  low: 'Possible'
}

/** Why a commit is linked to a session. */
export type LinkReason =
  | { kind: 'trailer'; url: string }
  | { kind: 'seen'; how: SeenCommit['kind'] }
  | { kind: 'rewritten' }
  | { kind: 'branch'; branch: string }
  | { kind: 'files'; count: number; of: number }
  | { kind: 'time' }
  | { kind: 'shared'; others: number }
  | { kind: 'subagent'; title?: string }

/** A changed file of a commit (`git log --numstat`). */
export interface CommitFile {
  path: string
  /** The path before a rename. */
  from?: string
  /** Lines added / removed; undefined for a binary file. */
  add?: number
  del?: number
}

export interface CommitInfo {
  sha: string
  parents: string[]
  authorEmail: string
  committerEmail: string
  /** Author and committer time, epoch ms. */
  at: number
  ct: number
  subject: string
  /** `Key: value` trailers of the message. */
  trailers: string[]
  files: CommitFile[]
  /** More files than were kept. */
  moreFiles?: number
  /** Branch names this commit belongs to (worked out from the commit graph). */
  branches: string[]
  /** A pull request it was merged with, from a merge or squash commit's subject. */
  pr?: number
}

export interface CommitLink {
  sha: string
  level: LinkLevel
  reasons: LinkReason[]
}

export interface PrLink {
  number: number
  url: string
  title?: string
  state?: 'open' | 'closed' | 'merged' | 'draft'
  branch?: string
  /** Where it came from: the session's own `gh pr create`, a merge commit's message, or gh. */
  via: 'session' | 'merge' | 'gh'
}

/** What the session list shows on a card. */
export interface GitBadge {
  commits: number
  prs: number[]
}

export type GitFolderStatus =
  'ok' | 'no-folder' | 'missing' | 'not-repo' | 'no-git' | 'untrusted' | 'distro-stopped' | 'error'

export type GhState = 'ask' | 'on' | 'off' | 'missing' | 'signed-out' | 'not-github'

/** A commit as the Changes tab shows it. */
export interface CommitView extends CommitLink {
  subject: string
  at: string
  parents: number
  branches: string[]
  files: CommitFile[]
  moreFiles?: number
  add: number
  del: number
  pr?: number
  /** The commit isn't in the repo's history the app read (e.g. the folder is gone): only what the session showed. */
  unknown?: boolean
}

/** One session's Changes tab. */
export interface SessionGitView {
  key: string
  enabled: boolean
  status: GitFolderStatus | 'pending'
  message?: string
  repo?: {
    root: string
    env: string
    remote?: string
    /** `owner/name` of a github.com remote. */
    github?: string
    /** Matched in another folder than the session's own (its folder is gone). */
    note?: string
    truncated?: boolean
  }
  branches: string[]
  commits: CommitView[]
  possible: CommitView[]
  unlinked: CommitView[]
  prs: PrLink[]
  /** Files the session edited that no commit since it started has changed. */
  uncommitted: string[]
  gh: GhState
  checkedAt?: string
  busy: boolean
}

export interface DiffLine {
  t: '+' | '-' | ' ' | '\\'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  from?: string
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'
  hunks: DiffHunk[]
  add: number
  del: number
  /** Lines past the parser's limit, not kept (the whole diff can be asked for). */
  cut?: number
}

export interface CommitDiff {
  sha: string
  files: DiffFile[]
  /** The diff was cut (at the size limit, or a file at the line limit). */
  truncated: boolean
  /** It was read whole (as far as the app reads one). */
  all?: boolean
  bytes: number
  error?: string
}

export interface GitStatus {
  enabled: boolean
  gh: GhState
  ghDetail?: string
  git: { env: string; version?: string; error?: string }[]
  repos: number
  linkedSessions: number
  busy: boolean
  checkedAt?: string
}

export interface GitLinkSettings {
  /** Link sessions to git commits (reads repos in the background). */
  enabled: boolean
  /** Look up pull requests with the GitHub CLI: ask once, on, or off. */
  gh: 'ask' | 'on' | 'off'
}

export const DEFAULT_GIT_SETTINGS: GitLinkSettings = { enabled: true, gh: 'ask' }

export function sanitizeGitSettings(v: unknown): GitLinkSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return {
    enabled: o.enabled !== false,
    gh: o.gh === 'on' || o.gh === 'off' ? o.gh : 'ask'
  }
}
