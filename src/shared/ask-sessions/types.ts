// "Ask across sessions" (docs/ROADMAP.md, feature 7): types shared by the main
// process, the desktop window and the phone.
//
// Two kinds of questions:
// - local: facts the app already has (counts, dates, models, usage, limits,
//   commits, PRs, files, plans), worked out on this PC. Nothing is sent.
// - content: a local keyword search finds passages of my sessions; a preview
//   shows exactly which snippets would go to Claude (through my own `claude
//   -p`), and only after I click Send are they sent, with the question.

import type { ProviderId } from '../provider'
import type { SourceLabel } from '../source-label'
import type { EnvKind } from '../types'
import type { PassageKind } from './chunk'

export type { PassageKind }

/** Models an answer can be written with: fixed aliases only (they reach a shell in WSL). */
export const ASK_MODELS = ['sonnet', 'opus', 'haiku', 'fable', 'default'] as const
export type AskModel = (typeof ASK_MODELS)[number]

export const ASK_MODEL_LABEL: Record<AskModel, string> = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
  fable: 'Fable',
  default: "Claude Code's default"
}

/** `claude --effort` levels (checked with `claude --help`, v2.1.322); "default" = no flag. */
export const ASK_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type AskEffort = (typeof ASK_EFFORTS)[number]

export const ASK_EFFORT_LABEL: Record<AskEffort, string> = {
  default: 'Default effort',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export function isAskModel(v: unknown): v is AskModel {
  return typeof v === 'string' && (ASK_MODELS as readonly string[]).includes(v)
}

export function isAskEffort(v: unknown): v is AskEffort {
  return typeof v === 'string' && (ASK_EFFORTS as readonly string[]).includes(v)
}

/**
 * The version of the one-time notice about what content questions send.
 * Bumped whenever what is sent grows, so an older acceptance isn't reused.
 */
export const ASK_NOTICE_VERSION = 1

export interface AskSessionsSettings {
  /** Content questions (and the index they search) are on. Off until I turn it on. */
  enabled: boolean
  /** The one-time notice (ASK_NOTICE_VERSION) was read and accepted. */
  noticeAccepted: boolean
  noticeVersion?: number
  /** Settings → Ask: the model and effort answers are written with by default. */
  model: AskModel
  effort: AskEffort
  /** The Ask screen's own choice for the next question (cleared when Settings changes). */
  lastModel?: AskModel
  lastEffort?: AskEffort
  /** Most snippets sent with one question. */
  maxSnippets: number
  /** Most characters of snippets sent with one question. */
  maxChars: number
  /** Most snippets from one session. */
  perSession: number
  /** Most characters of text the index holds (the oldest sessions are left out past it). */
  indexBudgetMB: number
}

export const DEFAULT_ASK_SESSIONS: AskSessionsSettings = {
  enabled: false,
  noticeAccepted: false,
  model: 'sonnet',
  effort: 'default',
  maxSnippets: 24,
  maxChars: 40_000,
  perSession: 4,
  indexBudgetMB: 300
}

export const ASK_LIMITS = {
  maxSnippets: [4, 60],
  maxChars: [5_000, 120_000],
  perSession: [1, 10],
  indexBudgetMB: [50, 2000]
} as const

export function sanitizeAskSessions(v: unknown): AskSessionsSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const d = DEFAULT_ASK_SESSIONS
  const int = (x: unknown, [lo, hi]: readonly [number, number], def: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : def
  return {
    enabled: o.enabled === true,
    // Accepted only for the current notice: an older acceptance is asked again.
    noticeAccepted: o.noticeAccepted === true && o.noticeVersion === ASK_NOTICE_VERSION,
    noticeVersion: ASK_NOTICE_VERSION,
    model: isAskModel(o.model) ? o.model : d.model,
    effort: isAskEffort(o.effort) ? o.effort : d.effort,
    ...(isAskModel(o.lastModel) ? { lastModel: o.lastModel } : {}),
    ...(isAskEffort(o.lastEffort) ? { lastEffort: o.lastEffort } : {}),
    maxSnippets: int(o.maxSnippets, ASK_LIMITS.maxSnippets, d.maxSnippets),
    maxChars: int(o.maxChars, ASK_LIMITS.maxChars, d.maxChars),
    perSession: int(o.perSession, ASK_LIMITS.perSession, d.perSession),
    indexBudgetMB: int(o.indexBudgetMB, ASK_LIMITS.indexBudgetMB, d.indexBudgetMB)
  }
}

/**
 * Apply a change from Settings or the Ask screen: a new default in Settings
 * clears the Ask screen's remembered choice, so the new default applies.
 */
export function patchAskSessions(
  cur: AskSessionsSettings,
  patch: Record<string, unknown>
): AskSessionsSettings {
  const next = sanitizeAskSessions({ ...cur, ...patch })
  if ('model' in patch && next.model !== cur.model) delete next.lastModel
  if ('effort' in patch && next.effort !== cur.effort) delete next.lastEffort
  // Turning content questions on needs the notice; turning them off keeps the acceptance.
  if (next.enabled && !next.noticeAccepted) next.enabled = false
  return next
}

/** The model and effort the Ask screen starts with. */
export function askChoice(s: AskSessionsSettings): { model: AskModel; effort: AskEffort } {
  return { model: s.lastModel ?? s.model, effort: s.lastEffort ?? s.effort }
}

// ------------------------------------------------------------------ scope

/** What a question looks at. Absent fields: everything. */
export interface AskScope {
  providers?: ProviderId[]
  /** Which product ran it (e.g. 'desktop', 'cowork', 'vscode'). */
  sources?: SourceLabel[]
  /** Project names (case-insensitive). */
  projects?: string[]
  envs?: EnvKind[]
  /** [from, to) in epoch ms. */
  from?: number
  to?: number
  /** How the dates were given ("last week", "October 2026"). */
  dateLabel?: string
  /** Model names or families (lower case, e.g. "opus", "gpt-5.5"). */
  models?: string[]
  /** Codex subagent threads too (default: no, like the session list). */
  subagents?: boolean
  /** Hidden sessions too (default: no). */
  hidden?: boolean
}

export function sanitizeScope(v: unknown): AskScope {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const strs = (x: unknown, max: number, len = 200): string[] | undefined =>
    Array.isArray(x)
      ? [
          ...new Set(
            x.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim())
          )
        ]
          .slice(0, max)
          .map((t) => t.slice(0, len))
      : undefined
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
  const out: AskScope = {}
  const providers = strs(o.providers, 4)?.filter((p): p is ProviderId => p === 'claude' || p === 'codex')
  if (providers?.length) out.providers = providers
  const sources = strs(o.sources, 20) as SourceLabel[] | undefined
  if (sources?.length) out.sources = sources
  const projects = strs(o.projects, 50)
  if (projects?.length) out.projects = projects
  const envs = strs(o.envs, 2)?.filter((e): e is EnvKind => e === 'windows' || e === 'wsl')
  if (envs?.length) out.envs = envs
  const from = num(o.from)
  const to = num(o.to)
  if (from !== undefined) out.from = from
  if (to !== undefined && (from === undefined || to > from)) out.to = to
  if (typeof o.dateLabel === 'string' && (out.from !== undefined || out.to !== undefined))
    out.dateLabel = o.dateLabel.slice(0, 80)
  const models = strs(o.models, 10, 80)?.map((m) => m.toLowerCase())
  if (models?.length) out.models = models
  if (o.subagents === true) out.subagents = true
  if (o.hidden === true) out.hidden = true
  return out
}

// --------------------------------------------------------------- answers

export interface AskCitation {
  key: string
  /** The session's title when the answer was written. */
  title: string
  kind: PassageKind
  /** The message it opens at (conversation passages). */
  messageId?: string
  /** Other messages the passage covers (highlighted too). */
  msgIds?: string[]
  /** A commit passage's SHA (opens the Changes tab). */
  sha?: string
  /** "Oct 14, 2026 3:02 PM", when known. */
  date?: string
  /** The first words of the snippet (for the tooltip). */
  preview: string
}

/** A local answer: worked out on this PC, nothing sent. */
export interface LocalAnswer {
  /** One line, Markdown. */
  headline: string
  /** How the question was read ("Sessions with a response from a model containing “opus”, Nov 2–8"). */
  interpretation: string
  /** How it was computed: the data used and the rule. */
  steps: string[]
  table?: { columns: string[]; rows: string[][]; align?: ('left' | 'right')[] }
  /** Sessions the answer is about (clickable, like citations). */
  sessions?: { key: string; title: string; detail?: string }[]
  /** Commits it lists (open that session's Changes tab). */
  commits?: { key: string; sha: string; subject: string; detail?: string }[]
  /** Items left out of the lists (only the first ones are shown). */
  more?: number
}

export interface AskSentInfo {
  snippets: number
  sessions: number
  chars: number
}

/** One question in the Ask history (desktop and phone). */
export interface AskSessionsItem {
  id: string
  at: number
  question: string
  mode: 'local' | 'content'
  /** Asked from a phone (its name), approved on the PC for content questions. */
  phone?: string
  scope?: AskScope
  /** The scope in words ("Codex · October 2026"). */
  scopeText?: string
  ok: boolean
  error?: string
  local?: LocalAnswer
  /** Content: the answer (Markdown with [S1] markers), after uncited statements were removed. */
  answer?: string
  /** Statements removed because they cited no valid snippet. */
  dropped?: string[]
  notFound?: boolean
  citations?: Record<string, AskCitation>
  sent?: AskSentInfo
  /** The model and effort picked for it, and the model that answered (from the CLI). */
  modelChoice?: AskModel
  effort?: AskEffort
  model?: string
  costUsd?: number
  durationMs?: number
  where?: string
}

// --------------------------------------------------------------- preview

export interface AskSnippet {
  /** "S1", "S2", … (what the answer cites). */
  sid: string
  key: string
  title: string
  project: string
  agent: string
  where: string
  /** Local date and time of its first message ("2026-10-14 15:02"). */
  date?: string
  kind: PassageKind
  messageId?: string
  msgIds?: string[]
  sha?: string
  /** The snippet as sent (secrets masked). */
  text: string
}

export interface AskEstimate {
  tokens: number
  costUsd: number
  /** Approximate % of the 5-hour window, when there is a limit-health baseline. */
  pct5h?: number
  /** The model it was priced as (e.g. "claude-sonnet-5-5"). */
  priceModel: string
}

export interface AskGuard {
  /** The 5-hour % now (the live reading plus the app's own runs since). */
  pct?: number
  /** The pause line from Settings → Summaries. */
  limit: number
  above: boolean
  unknown?: boolean
}

export interface AskIndexStatus {
  enabled: boolean
  phase: 'off' | 'loading' | 'building' | 'ready' | 'error'
  sessions: number
  passages: number
  /** Characters of text held. */
  chars: number
  /** Size of the saved index on disk. */
  bytes: number
  done: number
  total: number
  /** Last full build: how long it took. */
  buildMs?: number
  builtAt?: number
  updatedAt?: number
  /** Sessions left out to stay within the size budget (the oldest). */
  skipped: number
  /** The oldest session still in the index (when some were left out). */
  since?: number
  error?: string
}

/** What "Ask" answers when a question is typed. */
export type AskResult =
  | { mode: 'local'; item: AskSessionsItem }
  | {
      mode: 'content'
      preview?: AskPreview
      /** Content questions are off, or the index isn't ready: nothing was searched. */
      blocked?: string
    }

export interface AskPreview {
  id: string
  question: string
  scope: AskScope
  scopeText: string
  /** Today's line of the prompt ("2026-11-10 (Tue)"). */
  today: string
  snippets: AskSnippet[]
  /** Passages that matched (before the limits). */
  matched: number
  /** What the size limits left out. */
  cut: number
  model: AskModel
  effort: AskEffort
  guard?: AskGuard
  index: Pick<AskIndexStatus, 'sessions' | 'passages' | 'skipped' | 'since'>
  /** Asked from a phone and waiting for my OK on the PC. */
  phone?: { device: string; requestId: string }
}

/** A phone's question waiting for my OK on the PC. */
export interface AskPhoneRequest {
  id: string
  device: string
  question: string
  scope: AskScope
  at: number
  status: 'pending' | 'sent' | 'declined' | 'expired'
  /** The history item once it was answered. */
  itemId?: string
}

/** A phone's question is answered only after my OK on the PC (else it expires). */
export const PHONE_REQUEST_TTL = 15 * 60_000
