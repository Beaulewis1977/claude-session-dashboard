// Local questions (docs/ROADMAP.md, feature 7): facts the app already has,
// worked out on this PC from the session list, usage records, limit
// readings, plans and git links. Nothing is sent anywhere.
//
// The router is rule-based (no AI): it recognises what kind of fact is asked
// for and the filters (model, provider, project, environment, tag, file,
// commit, PR, dates), using words from my own data (projects, models, tags).
// A question is answered here only when every word in it is understood;
// otherwise it's a content question, and the filters it did find (only the
// unambiguous ones) become that question's scope.

import type { ProviderId } from '../provider'
import type { SourceLabel } from '../source-label'
import type { Availability, EnvKind } from '../types'
import { formatDateTime, formatInt, formatTokens, formatUsd } from '../format'
import { modelLabel, recordCost, type ModelPrice } from '../usage/pricing'
import type { LimitHit, UsageRecord, WeekStart } from '../usage/types'
import { normQueryPath, pathMatches } from '../git/query'
import { ASK_USAGE_KEY, ASK_USAGE_LABEL, SUMMARY_USAGE_KEY, SUMMARY_USAGE_LABEL } from '../summary'
import { dayKey } from '../usage/time'
import { dayLabel, findDateRange, rangeLabel, type DateRange } from './dates'
import type { AskScope, LocalAnswer } from './types'

// ------------------------------------------------------------------ data

export interface LocalSession {
  key: string
  title: string
  provider: ProviderId
  source: SourceLabel
  env: EnvKind
  distro?: string
  project: string
  startedAt?: number
  lastActivityAt?: number
  models: string[]
  subagent: boolean
  hidden: boolean
  named: boolean
  pinned: boolean
  tags: string[]
  availability: Availability
  messageCount: number
}

export interface LocalCommit {
  key: string
  sha: string
  subject: string
  at: number
  files: string[]
  pr?: number
}

export interface LocalPr {
  key: string
  number: number
  url: string
  title?: string
  state?: string
  at?: number
}

export interface LocalGauge {
  pct: number
  resetsAt?: number
}

export interface LocalData {
  now: number
  timeZone: string
  weekStart: WeekStart
  sessions: LocalSession[]
  /** Usage records: Claude Code's, Codex's (provider "codex") and the app's own runs. */
  records: UsageRecord[]
  prices: ModelPrice[]
  codexPrices: ModelPrice[]
  limitHits: LimitHit[]
  codexLimitHits: LimitHit[]
  limitsNow: {
    claude?: { fiveHour?: LocalGauge; sevenDay?: LocalGauge }
    codex?: { fiveHour?: LocalGauge; sevenDay?: LocalGauge }
  }
  plans: {
    claude: { current: string; history: { from: string; plan: string }[] }
    codex?: { current: string; changes: { at: number; plan: string }[] }
  }
  git: {
    enabled: boolean
    /** Sessions that edited or committed a file (as the `touched:` search filter). */
    touched(path: string): Set<string>
    /** Sessions linked to a commit (SHA prefix). */
    commitSessions(sha: string): Set<string>
    commits(): LocalCommit[]
    prs(): LocalPr[]
    /** Files sessions edited, with when (0 when unknown). */
    files(): { key: string; path: string; at: number }[]
  }
}

/** Words from my own data the router can recognise. */
export interface Vocab {
  projects: string[]
  models: string[]
  tags: string[]
  distros: string[]
}

export function vocabOf(d: Pick<LocalData, 'sessions' | 'records'>): Vocab {
  const projects = new Set<string>()
  const models = new Set<string>()
  const tags = new Set<string>()
  const distros = new Set<string>()
  for (const s of d.sessions) {
    if (s.project) projects.add(s.project)
    for (const m of s.models) models.add(m.toLowerCase())
    for (const t of s.tags) tags.add(t)
    if (s.distro) distros.add(s.distro)
  }
  for (const r of d.records) models.add(r.model.toLowerCase())
  return { projects: [...projects], models: [...models], tags: [...tags], distros: [...distros] }
}

// ---------------------------------------------------------------- routing

export type LocalIntent =
  | 'sessions'
  | 'cost'
  | 'tokens'
  | 'limitHits'
  | 'limitsNow'
  | 'plans'
  | 'models'
  | 'modelFirst'
  | 'commits'
  | 'prs'
  | 'files'
  | 'projectDates'

export interface LocalQuery {
  intent: LocalIntent
  /** "How many" (a count first) rather than "which" (a list first). */
  count: boolean
  range?: DateRange
  providers?: ProviderId[]
  sources?: SourceLabel[]
  projects?: string[]
  envs?: EnvKind[]
  distro?: string
  /** Model filters: a family ("opus") or an id part ("gpt-5.5"), lower case. */
  models?: string[]
  tags?: string[]
  files?: string[]
  commits?: string[]
  pr?: number
  named?: boolean
  pinned?: boolean
  hidden?: boolean
  archived?: boolean
  subagents?: boolean
  groupBy?: 'model' | 'project' | 'day' | 'month' | 'provider'
  window?: '5h' | '7d'
  /** projectDates / modelFirst: the first or the last time. */
  which?: 'first' | 'last'
}

export type Routed =
  | { mode: 'local'; query: LocalQuery; chips: string[] }
  | {
      mode: 'content'
      scope: AskScope
      chips: string[]
      /** The question without the words that became its scope (what the index searches for). */
      searchText: string
    }

/** Words a local question may hold besides its filters. */
const FILLER = new Set(
  (
    "how many much which what whats what's when where who list show tell give me my mine i i've ive did do does done have has had " +
    'were was are is be been the a an of in on for with to from by during at all any every total number count ' +
    'counts sessions session conversations conversation chats chat threads thread used use using uses work worked ' +
    'working spend spent spending cost costs costed money dollars dollar usd tokens token usage hit hits reached ' +
    'reach limit limits time times often first last ever recently recent so far start started begin began change ' +
    'changed changes plan plans subscription subscriptions tier models model commits commit committed made make ' +
    'prs pr pull request requests opened open created create merged files file edit edited editing touched touch ' +
    'touching modified modify changing most top per each day days daily week weeks weekly month months monthly ' +
    'year years breakdown broken down grouped group current currently now right am up that this these those it ' +
    'there their than then and or vs versus compare compared also only just about overall altogether please can ' +
    'could would you me? ran run into maxed max out close near am window windows hour hours five 5h 7d seven ' +
    "since between before after until till through past previous today yesterday ago lately it's its they had " +
    'still both ones one two three four five six seven eight nine ten get got go went new old im linked link links'
  ).split(/\s+/)
)

/** Plain words: the pieces a leftover check looks at. */
const WORD = /[a-z0-9][a-z0-9.'_/\\#-]*/g

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Spans {
  list: [number, number][]
  take(a: number, b: number): void
  has(i: number, j: number): boolean
}

function spans(): Spans {
  const list: [number, number][] = []
  return {
    list,
    take: (a, b) => list.push([a, b]),
    has: (i, j) => list.some(([a, b]) => i >= a && j <= b)
  }
}

/** Find `re` in `q`, mark it used, return the match. */
function grab(q: string, used: Spans, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (let m = g.exec(q); m; m = g.exec(q)) {
    if (used.has(m.index, m.index + m[0].length)) continue
    used.take(m.index, m.index + m[0].length)
    return m
  }
  return null
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']

/** "opus 5.5" → "opus-5-5" (matches claude-opus-5-5…); "gpt-5.5" stays. */
function modelNeedle(family: string, version?: string): string {
  if (!version) return family
  return MODEL_FAMILIES.includes(family)
    ? `${family}-${version.replace(/[.]/g, '-')}`
    : `${family}-${version}`
}

export function modelMatches(model: string, needle: string): boolean {
  const m = model.toLowerCase()
  if (m.includes(needle)) return true
  // "opus-5-5" also for an older naming ("claude-5-5-opus").
  const parts = /^([a-z]+)-(\d+)-(\d+)$/.exec(needle)
  return !!parts && m.includes(`${parts[2]}-${parts[3]}-${parts[1]}`)
}

const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * Read a question. `q` is the question as typed; `content` filters (for a
 * question that isn't local) are only those that can't be part of what's
 * asked about: dates with a preposition, "in Codex" / "Claude Code sessions",
 * and projects named with a preposition.
 */
export function routeQuestion(
  question: string,
  vocab: Vocab,
  now: number,
  timeZone: string,
  weekStart: WeekStart
): Routed {
  const q = ` ${question
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()} `
  const used = spans()
  const lq: LocalQuery = { intent: 'sessions', count: false }
  const chips: string[] = []

  // Dates first (they hold words like "last" and "may").
  const range = findDateRange(q, now, timeZone, weekStart)
  if (range) {
    used.take(range.at[0], range.at[1])
    lq.range = range
  }

  // Providers and products.
  let providerExplicit = false
  // Spans of the filters a content question would take as its scope.
  const scopeSpans: [number, number][] = []
  const at = (m: RegExpExecArray | null): RegExpExecArray | null => {
    if (m) scopeSpans.push([m.index, m.index + m[0].length])
    return m
  }
  if (at(grab(q, used, /\bclaude(?: code)? desktop(?: app)?\b|\bdesktop app\b/)))
    lq.sources = ['desktop']
  if (at(grab(q, used, /\bcowork\b/))) lq.sources = [...(lq.sources ?? []), 'cowork']
  if (grab(q, used, /\bvs ?code\b/)) lq.sources = [...(lq.sources ?? []), 'vscode', 'codex-vscode']
  if (grab(q, used, /\bjetbrains\b/)) lq.sources = [...(lq.sources ?? []), 'jetbrains']
  const prov = new Set<ProviderId>()
  const explicitProvider =
    /\b(?:in|from|with|using|on|for|by)\s+(?:my\s+|the\s+)?(codex|claude code|claude)\b(?!\s+(?:exec|cli|app|hooks?|config|settings|desktop))|\b(codex|claude code|claude)\s+(?:sessions?|threads?|conversations?|chats?)\b/
  for (let m = at(grab(q, used, explicitProvider)); m; m = at(grab(q, used, explicitProvider))) {
    prov.add((m[1] ?? m[2]) === 'codex' ? 'codex' : 'claude')
    providerExplicit = true
  }
  for (
    let m = grab(q, used, /\b(codex|claude code|claude)\b/);
    m;
    m = grab(q, used, /\b(codex|claude code|claude)\b/)
  )
    prov.add(m[1] === 'codex' ? 'codex' : 'claude')
  if (prov.size) lq.providers = [...prov]

  // Models: a family with an optional version, an OpenAI-style id, or one seen in my data.
  const models = new Set<string>()
  for (
    let m = grab(q, used, /\b(opus|sonnet|haiku|fable)(?:[\s-]?(\d+(?:[.-]\d+)?))?\b/);
    m;
    m = grab(q, used, /\b(opus|sonnet|haiku|fable)(?:[\s-]?(\d+(?:[.-]\d+)?))?\b/)
  )
    models.add(modelNeedle(m[1], m[2]))
  for (
    let m = grab(q, used, /\b(gpt-?\d+(?:\.\d+)?(?:-[a-z]+)*|o\d(?:-[a-z]+)?)\b/);
    m;
    m = grab(q, used, /\b(gpt-?\d+(?:\.\d+)?(?:-[a-z]+)*|o\d(?:-[a-z]+)?)\b/)
  )
    models.add(m[1].replace(/^gpt(?=\d)/, 'gpt-'))
  for (const id of vocab.models) {
    if (id.length < 4) continue
    const m = grab(q, used, new RegExp(`(?:^|\\s)(${esc(id)})(?=\\s|[?.,!]|$)`))
    if (m) models.add(id)
  }
  if (models.size) lq.models = [...models]

  // Environment.
  const envs = new Set<EnvKind>()
  for (const d of vocab.distros) {
    if (grab(q, used, new RegExp(`\\b${esc(d.toLowerCase())}\\b`))) {
      envs.add('wsl')
      lq.distro = d
    }
  }
  if (grab(q, used, /\bwsl\b|\bubuntu\b|\blinux\b/)) envs.add('wsl')
  if (grab(q, used, /\b(?:on|in|from)\s+windows\b|\bwindows\s+(?:sessions?|side)\b/))
    envs.add('windows')
  if (envs.size) lq.envs = [...envs]

  // Projects (longest name first): with a preposition, before "project", or a distinctive name.
  const projects: string[] = []
  for (const p of [...vocab.projects].sort((a, b) => b.length - a.length)) {
    const n = esc(p.toLowerCase())
    const re = new RegExp(
      // Not "about": "what did I decide about pricing" is about pricing, whatever my projects are called.
      `\\b(?:in|for|on|from|of|under|within|inside)\\s+(?:the\\s+|my\\s+)?(?:project\\s+)?${n}(?:\\s+project)?(?=\\s|[?.,!]|$)|(?:^|\\s)${n}\\s+project\\b|(?:^|\\s)project\\s+${n}(?=\\s|[?.,!]|$)`
    )
    if (at(grab(q, used, re))) projects.push(p)
    else if (/[-_.]/.test(p) && at(grab(q, used, new RegExp(`(?:^|\\s)${n}(?=\\s|[?.,!]|$)`))))
      projects.push(p)
  }
  if (projects.length) lq.projects = projects

  // Tags.
  for (let m = grab(q, used, /\b(?:tagged|(?:with\s+)?(?:the\s+)?tag)\s+"?([^\s"?,]+)"?/); m;) {
    const t = vocab.tags.find((x) => x.toLowerCase() === m![1])
    if (t) (lq.tags ??= []).push(t)
    else (lq.tags ??= []).push(m[1])
    m = grab(q, used, /\b(?:tagged|(?:with\s+)?(?:the\s+)?tag)\s+"?([^\s"?,]+)"?/)
  }

  // Files, commits, PRs.
  const FILE =
    /(?:^|\s)(?:the\s+)?(?:file\s+)?("[^"]+"|[\w.\\/-]+\.[a-z0-9]{1,8}|[\w.-]+[\\/][\w.\\/-]+)(?=\s|[?,!]|\.(?:\s|$)|$)/
  for (let m = grab(q, used, FILE); m; m = grab(q, used, FILE)) {
    const f = m[1].replace(/^"|"$/g, '')
    // A version ("1.15.2"), a model id, an abbreviation ("e.g.") or a website isn't a file.
    if (
      /^v?\d+(\.\d+)+$/.test(f) ||
      /^gpt-/.test(f) ||
      f.length < 4 ||
      !/\.[a-z][a-z0-9]{0,7}$|[\\/]/.test(f) ||
      /^(?:[a-z0-9-]+\.)?(?:claude\.ai|chatgpt\.com|github\.com|openai\.com|anthropic\.com)$/.test(
        f
      )
    )
      continue
    ;(lq.files ??= []).push(normQueryPath(f))
  }
  const sha = grab(q, used, /\bcommit\s+([0-9a-f]{7,40})\b/)
  if (sha) lq.commits = [sha[1]]
  const pr = grab(q, used, /\b(?:pr|pull request)\s*#?(\d{1,6})\b|(?:^|\s)#(\d{1,6})\b/)
  if (pr) lq.pr = Number(pr[1] ?? pr[2])

  // Flags and grouping.
  if (grab(q, used, /\b(?:that i |i )?named\b/)) lq.named = true
  if (grab(q, used, /\bpinned\b/)) lq.pinned = true
  if (grab(q, used, /\bhidden\b/)) lq.hidden = true
  if (grab(q, used, /\barchived(?: only)?\b/)) lq.archived = true
  if (grab(q, used, /\bsub-?agents?\b|\bsubagent threads?\b/)) lq.subagents = true
  const by = grab(
    q,
    used,
    /\b(?:by|per|for each|split by|broken down by)\s+(model|project|day|month|provider)s?\b/
  )
  if (by) lq.groupBy = by[1] as LocalQuery['groupBy']
  if (grab(q, used, /\b(?:5|five)[- ]?h(?:ou)?r?s?\b/)) lq.window = '5h'
  else if (grab(q, used, /\b(?:weekly|7[- ]?days?|seven[- ]days?)\b/)) lq.window = '7d'

  // What kind of fact.
  const has = (re: RegExp): boolean => re.test(q)
  const sessionsWord = has(/\b(?:sessions?|conversations?|chats?|threads?)\b/)
  let intent: LocalIntent | undefined
  if (has(/\b(?:spend|spent|spending|cost|costs|costed|dollars?|usd|money)\b|\$/)) intent = 'cost'
  else if (has(/\btokens?\b/)) intent = 'tokens'
  else if (
    has(
      /\b(?:hit|hits|reached|reach|ran into|run into|maxed out|max out)\b[\w\s'-]{0,30}\blimits?\b|\blimit hits?\b/
    )
  )
    intent = 'limitHits'
  else if (
    has(
      /\b(?:current|currently|right now|now|so far)\b[\w\s'-]{0,30}\blimits?\b|\bhow (?:close|near)\b[\w\s'-]{0,30}\blimit|\blimits? (?:now|right now|currently)\b|\bwhere am i\b[\w\s'-]{0,20}\blimit/
    )
  )
    intent = 'limitsNow'
  else if (has(/\b(?:plans?|subscriptions?|tier)\b/)) intent = 'plans'
  else if (has(/\bcommit(?:s|ted)?\b/) && !lq.commits) intent = 'commits'
  else if (has(/\b(?:prs?|pull requests?)\b/) && lq.pr === undefined) intent = 'prs'
  else if (lq.models && has(/\bwhen\b/) && has(/\b(?:first|start(?:ed)?|begin|began|last)\b/))
    intent = 'modelFirst'
  else if (has(/\bmodels?\b/)) intent = 'models'
  else if (!sessionsWord && has(/\bfiles?\b/) && !lq.files) intent = 'files'
  else if (
    lq.projects &&
    has(/\bwhen\b/) &&
    has(/\b(?:first|start(?:ed)?|begin|began|last|latest|most recent)\b/)
  )
    intent = 'projectDates'
  else if (sessionsWord || lq.files || lq.commits || lq.pr !== undefined) intent = 'sessions'
  if (intent) lq.intent = intent
  lq.count = has(/\bhow (?:many|much|often)\b|\bnumber of\b|\bcount\b|\btotal\b/)
  if (intent === 'modelFirst' || intent === 'projectDates')
    lq.which = has(/\b(?:last|latest|most recent)\b/) && !has(/\bfirst\b/) ? 'last' : 'first'

  // Anything left that isn't a filler word: the question is about content.
  const leftover: string[] = []
  for (const m of q.matchAll(WORD)) {
    const w = m[0].replace(/['.,!?]+$/, '')
    if (!w || used.has(m.index!, m.index! + m[0].length)) continue
    if (FILLER.has(w) || /^\d+$/.test(w)) continue
    leftover.push(w)
  }

  const local = !!intent && leftover.length === 0
  if (local) {
    chips.push(...queryChips(lq))
    return { mode: 'local', query: lq, chips }
  }
  // A content question: only filters that can't be what it's about.
  const scope: AskScope = {}
  if (range?.explicit) {
    scope.from = range.from
    scope.to = range.to
    scope.dateLabel = range.label
    scopeSpans.push(range.at)
  }
  if (providerExplicit && prov.size) scope.providers = [...prov]
  if (projects.length) scope.projects = projects
  if (lq.sources?.some((s) => s === 'desktop' || s === 'cowork'))
    scope.sources = lq.sources.filter((s) => s === 'desktop' || s === 'cowork')
  // What the index looks for: the question without its scope's words (a
  // filter that stayed out of the scope, like a bare "WSL", stays a search word).
  let searchText = q
  for (const [a, b] of [...scopeSpans].sort((x, y) => y[0] - x[0]))
    searchText = `${searchText.slice(0, a)} ${searchText.slice(b)}`
  return {
    mode: 'content',
    scope,
    chips: scopeChips(scope),
    searchText: searchText.replace(/\s+/g, ' ').trim() || question
  }
}

/** The filters of a local query, in words. */
export function queryChips(q: LocalQuery): string[] {
  const out: string[] = []
  if (q.providers?.length) out.push(q.providers.map((p) => PROVIDER_NAME[p]).join(' + '))
  if (q.sources?.length) out.push(q.sources.join(', '))
  if (q.models?.length) out.push(`Model: ${q.models.join(', ')}`)
  if (q.projects?.length) out.push(`Project: ${q.projects.join(', ')}`)
  if (q.envs?.length)
    out.push(
      q.distro
        ? `WSL: ${q.distro}`
        : q.envs.map((e) => (e === 'wsl' ? 'WSL' : 'Windows')).join(' + ')
    )
  if (q.tags?.length) out.push(`Tag: ${q.tags.join(', ')}`)
  if (q.files?.length) out.push(`Touched: ${q.files.join(', ')}`)
  if (q.commits?.length) out.push(`Commit: ${q.commits.join(', ')}`)
  if (q.pr !== undefined) out.push(`PR #${q.pr}`)
  if (q.range) out.push(q.range.label)
  return out
}

/** A content question's scope, in words. */
export function scopeChips(s: AskScope): string[] {
  const out: string[] = []
  if (s.providers?.length) out.push(s.providers.map((p) => PROVIDER_NAME[p]).join(' + '))
  if (s.sources?.length)
    out.push(
      s.sources
        .map((x) => (x === 'cowork' ? 'Cowork' : x === 'desktop' ? 'Claude desktop' : x))
        .join(', ')
    )
  if (s.projects?.length) out.push(`Project: ${s.projects.join(', ')}`)
  if (s.envs?.length) out.push(s.envs.map((e) => (e === 'wsl' ? 'WSL' : 'Windows')).join(' + '))
  if (s.models?.length) out.push(`Model: ${s.models.join(', ')}`)
  if (s.dateLabel) out.push(s.dateLabel)
  else if (s.from !== undefined || s.to !== undefined) out.push('Dates set')
  if (s.subagents) out.push('With subagents')
  if (s.hidden) out.push('With hidden')
  return out
}

// ------------------------------------------------------------ computing

const MAX_LIST = 30

function dt(ts: number | undefined): string {
  return ts ? formatDateTime(new Date(ts).toISOString()) : '—'
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`
}

function providerOfRecord(r: UsageRecord): ProviderId {
  return r.provider === 'codex' ? 'codex' : 'claude'
}

function ownLabel(key: string): string | undefined {
  if (key === SUMMARY_USAGE_KEY) return SUMMARY_USAGE_LABEL
  if (key === ASK_USAGE_KEY) return ASK_USAGE_LABEL
  return undefined
}

interface Ctx {
  d: LocalData
  q: LocalQuery
  byKey: Map<string, LocalSession>
}

/** The sessions the filters allow (before dates and models). */
function sessionPool(c: Ctx): { pool: LocalSession[]; notes: string[] } {
  const { q, d } = c
  const notes: string[] = []
  let left = d.sessions.filter((s) => s.source !== 'ask-claude')
  const subs = left.filter((s) => s.subagent).length
  if (!q.subagents) {
    left = left.filter((s) => !s.subagent)
    if (subs)
      notes.push(
        `${plural(subs, 'Codex subagent thread')} not counted (ask about subagents to include them).`
      )
  } else left = left.filter((s) => s.subagent)
  const hid = left.filter((s) => s.hidden).length
  if (!q.hidden) {
    left = left.filter((s) => !s.hidden)
    if (hid) notes.push(`${plural(hid, 'hidden session')} not counted.`)
  } else left = left.filter((s) => s.hidden)
  if (q.archived) left = left.filter((s) => s.availability === 'archived-only')
  if (q.providers?.length) left = left.filter((s) => q.providers!.includes(s.provider))
  if (q.sources?.length) left = left.filter((s) => q.sources!.includes(s.source))
  if (q.envs?.length) left = left.filter((s) => q.envs!.includes(s.env))
  if (q.distro) left = left.filter((s) => s.distro === q.distro)
  if (q.projects?.length) {
    const ps = new Set(q.projects.map((p) => p.toLowerCase()))
    left = left.filter((s) => ps.has(s.project.toLowerCase()))
  }
  if (q.tags?.length) {
    const ts = new Set(q.tags.map((t) => t.toLowerCase()))
    left = left.filter((s) => s.tags.some((t) => ts.has(t.toLowerCase())))
  }
  if (q.named) left = left.filter((s) => s.named)
  if (q.pinned) left = left.filter((s) => s.pinned)
  if (q.files?.length) {
    for (const f of q.files) {
      const keys = d.git.touched(f)
      left = left.filter((s) => keys.has(s.key))
    }
  }
  if (q.commits?.length) {
    for (const sha of q.commits) {
      const keys = d.git.commitSessions(sha)
      left = left.filter((s) => keys.has(s.key))
    }
  }
  if (q.pr !== undefined) {
    const keys = new Set(
      d.git
        .prs()
        .filter((p) => p.number === q.pr)
        .map((p) => p.key)
    )
    left = left.filter((s) => keys.has(s.key))
  }
  return { pool: left, notes }
}

function inRange(ts: number, r?: DateRange): boolean {
  return !r || (ts >= r.from && ts < r.to)
}

function recordMatches(r: UsageRecord, q: LocalQuery): boolean {
  return !q.models?.length || q.models.some((m) => modelMatches(r.model, m))
}

function filterWords(q: LocalQuery): string {
  const bits: string[] = []
  if (q.providers?.length) bits.push(q.providers.map((p) => PROVIDER_NAME[p]).join(' and '))
  if (q.projects?.length) bits.push(`in ${q.projects.join(', ')}`)
  if (q.envs?.length)
    bits.push(q.distro ? `in WSL (${q.distro})` : q.envs.includes('wsl') ? 'in WSL' : 'on Windows')
  if (q.tags?.length) bits.push(`tagged ${q.tags.join(', ')}`)
  if (q.sources?.length) bits.push(`from ${q.sources.join(', ')}`)
  return bits.join(' ')
}

function sessionsAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  const { pool, notes } = sessionPool(c)
  const steps: string[] = [
    `Read the session list on this PC: ${plural(d.sessions.length, 'session')}, filtered to ${plural(pool.length, 'session')}${filterWords(q) ? ` (${filterWords(q)})` : ''}.`
  ]
  if (q.files?.length)
    steps.push(
      `Kept the sessions git links connect to ${q.files.join(', ')} (edited by the session, or in a commit linked to it), like the touched: search.`
    )
  if (q.commits?.length) steps.push(`Kept the sessions linked to commit ${q.commits.join(', ')}.`)
  if (q.pr !== undefined) steps.push(`Kept the sessions linked to PR #${q.pr}.`)
  const hits = new Map<string, { n: number; last: number }>()
  const withRecords = new Set<string>()
  if (q.models?.length || q.range) {
    const allowed = new Set(pool.map((s) => s.key))
    for (const r of d.records) {
      if (!allowed.has(r.key)) continue
      withRecords.add(r.key)
      if (!inRange(r.ts, q.range) || !recordMatches(r, q)) continue
      const h = hits.get(r.key) ?? { n: 0, last: 0 }
      h.n++
      h.last = Math.max(h.last, r.ts)
      hits.set(r.key, h)
    }
  }
  let matched: LocalSession[]
  if (q.models?.length) {
    // A session without usage records (an imported conversation): by its recorded models.
    matched = pool.filter(
      (s) =>
        hits.has(s.key) ||
        (!withRecords.has(s.key) &&
          s.models.some((m) => q.models!.some((n) => modelMatches(m, n))) &&
          (!q.range ||
            ((s.startedAt ?? 0) < q.range.to && (s.lastActivityAt ?? 0) >= q.range.from)))
    )
    steps.push(
      `Counted a session when at least one of its responses${q.range ? ` in ${rangeLabel(q.range.fromKey, q.range.toKey)}` : ''} came from a model containing ${q.models.map((m) => `“${m}”`).join(' or ')} (usage records: one per response).`
    )
  } else if (q.range) {
    matched = pool.filter(
      (s) =>
        hits.has(s.key) ||
        (!withRecords.has(s.key) &&
          (s.startedAt ?? 0) < q.range!.to &&
          (s.lastActivityAt ?? 0) >= q.range!.from)
    )
    steps.push(
      `Counted a session when it had a response in ${rangeLabel(q.range.fromKey, q.range.toKey)} (usage records), or, without usage records, when its first and last activity overlap those dates.`
    )
  } else matched = pool
  steps.push(...notes)
  matched.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
  const what = [
    q.models?.length ? `used ${q.models.join(' or ')}` : '',
    q.files?.length ? `touched ${q.files.join(', ')}` : '',
    q.commits?.length ? `are linked to commit ${q.commits.join(', ')}` : '',
    q.pr !== undefined ? `are linked to PR #${q.pr}` : ''
  ]
    .filter(Boolean)
    .join(' and ')
  const fw = filterWords(q)
  const headline = `**${plural(matched.length, 'session')}**${fw ? ` ${fw}` : ''}${what ? ` ${what}` : ''}${q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''}.`
  return {
    headline: headline.replace(/\s+/g, ' '),
    interpretation: `Sessions${fw ? ` ${fw}` : ''}${what ? ` that ${what}` : ''}${q.range ? `, ${q.range.label}` : ''}`,
    steps,
    sessions: matched.slice(0, MAX_LIST).map((s) => {
      const h = hits.get(s.key)
      return {
        key: s.key,
        title: s.title,
        detail: [
          s.project,
          `last activity ${dt(s.lastActivityAt)}`,
          ...(h && q.models?.length
            ? [`${plural(h.n, 'response')} from ${q.models.join('/')}`]
            : [])
        ].join(' · ')
      }
    }),
    ...(matched.length > MAX_LIST ? { more: matched.length - MAX_LIST } : {})
  }
}

function costAnswer(c: Ctx, tokensOnly: boolean): LocalAnswer {
  const { q, d } = c
  const recs = d.records.filter((r) => {
    if (!inRange(r.ts, q.range) || !recordMatches(r, q)) return false
    if (q.providers?.length && !q.providers.includes(providerOfRecord(r))) return false
    const s = c.byKey.get(r.key)
    if (q.projects?.length && !q.projects.some((p) => p.toLowerCase() === s?.project.toLowerCase()))
      return false
    if (q.envs?.length && !q.envs.includes(r.env)) return false
    if (q.sources?.length && (!s || !q.sources.includes(s.source))) return false
    if (
      q.tags?.length &&
      (!s || !s.tags.some((t) => q.tags!.some((x) => x.toLowerCase() === t.toLowerCase())))
    )
      return false
    return true
  })
  const group = q.groupBy ?? 'model'
  const rows = new Map<string, { responses: number; tokens: number; cost: number }>()
  let total = { responses: 0, tokens: 0, cost: 0 }
  for (const r of recs) {
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite
    const cost = recordCost(r, providerOfRecord(r) === 'codex' ? d.codexPrices : d.prices)
    const s = c.byKey.get(r.key)
    const g =
      group === 'project'
        ? (ownLabel(r.key) ?? s?.project ?? 'Unknown')
        : group === 'provider'
          ? PROVIDER_NAME[providerOfRecord(r)]
          : group === 'day'
            ? dayKey(r.ts, d.timeZone)
            : group === 'month'
              ? dayKey(r.ts, d.timeZone).slice(0, 7)
              : modelLabel(r.model)
    const row = rows.get(g) ?? { responses: 0, tokens: 0, cost: 0 }
    row.responses++
    row.tokens += tokens
    row.cost += cost
    rows.set(g, row)
    total = {
      responses: total.responses + 1,
      tokens: total.tokens + tokens,
      cost: total.cost + cost
    }
  }
  const sorted = [...rows.entries()].sort((a, b) =>
    group === 'day' || group === 'month' ? a[0].localeCompare(b[0]) : b[1].cost - a[1].cost
  )
  const fw = filterWords(q)
  const when = q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''
  const providers = q.providers?.length ? q.providers : (['claude', 'codex'] as ProviderId[])
  const headline = tokensOnly
    ? `**${formatTokens(total.tokens)} tokens**${fw ? ` ${fw}` : ''}${when} (${plural(total.responses, 'response')}, about ${formatUsd(total.cost)} at API prices).`
    : `**${formatUsd(total.cost)}** at API list prices${fw ? ` ${fw}` : ''}${when} (${formatTokens(total.tokens)} tokens, ${plural(total.responses, 'response')}).`
  const steps = [
    `Added up the usage records on this PC${q.range ? ` from ${rangeLabel(q.range.fromKey, q.range.toKey)}` : ''}: one per response, deduplicated like ccusage, ${plural(recs.length, 'record')}${q.models?.length ? ` from models containing ${q.models.map((m) => `“${m}”`).join(' or ')}` : ''}.`,
    `Priced each response with ${providers.includes('codex') && providers.includes('claude') ? 'Settings → Prices (Claude) and Settings → Codex prices' : providers.includes('codex') ? 'Settings → Codex prices' : 'Settings → Prices'} (API list prices).`,
    ...(providers.includes('codex')
      ? [
          "Your ChatGPT plan isn't billed per token: this is what the same use would cost at API prices."
        ]
      : []),
    ...(providers.includes('claude')
      ? [
          "A Claude subscription isn't billed per token either; API-billed sessions are, at these prices."
        ]
      : []),
    "Usage on other computers, claude.ai and the phone apps isn't in these records."
  ]
  return {
    headline,
    interpretation: `${tokensOnly ? 'Tokens' : 'API-equivalent cost'}${fw ? ` ${fw}` : ''}${q.range ? `, ${q.range.label}` : ''}, by ${group}`,
    steps,
    table: {
      columns: [group[0].toUpperCase() + group.slice(1), 'Responses', 'Tokens', 'API price'],
      align: ['left', 'right', 'right', 'right'],
      rows: [
        ...sorted
          .slice(0, 40)
          .map(([k, v]) => [k, formatInt(v.responses), formatTokens(v.tokens), formatUsd(v.cost)]),
        ['Total', formatInt(total.responses), formatTokens(total.tokens), formatUsd(total.cost)]
      ]
    }
  }
}

function limitHitsAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  const want = (h: LimitHit): boolean =>
    inRange(h.ts, q.range) &&
    (!q.window || (q.window === '5h' ? h.kind === 'five_hour' : h.kind === 'weekly'))
  const providers = q.providers?.length ? q.providers : (['claude', 'codex'] as ProviderId[])
  const hits = [
    ...(providers.includes('claude')
      ? d.limitHits.filter(want).map((h) => ({ h, p: 'claude' as const }))
      : []),
    ...(providers.includes('codex')
      ? d.codexLimitHits.filter(want).map((h) => ({ h, p: 'codex' as const }))
      : [])
  ].sort((a, b) => b.h.ts - a.h.ts)
  const kind = q.window === '5h' ? '5-hour ' : q.window === '7d' ? 'weekly ' : ''
  const when = q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''
  return {
    headline: `You hit a ${kind}limit **${plural(hits.length, 'time')}**${when}${hits[0] ? `, last on ${dt(hits[0].h.ts)}` : ''}.`,
    interpretation: `${kind ? `${kind[0].toUpperCase()}${kind.slice(1)}` : ''}limit hits${q.providers?.length ? ` (${q.providers.map((p) => PROVIDER_NAME[p]).join(', ')})` : ''}${q.range ? `, ${q.range.label}` : ''}`,
    steps: [
      'Claude Code: each "limit reached" message in the session files is one hit.',
      'Codex: each rate-limit reading where Codex said a limit was reached.',
      'Only what this PC saw: a limit reached on claude.ai or another computer is not in here.'
    ],
    table: {
      columns: ['When', 'Agent', 'Window', 'Session'],
      rows: hits
        .slice(0, MAX_LIST)
        .map(({ h, p }) => [
          dt(h.ts),
          PROVIDER_NAME[p],
          h.kind === 'five_hour' ? '5-hour' : h.kind === 'weekly' ? 'Weekly' : 'Other',
          c.byKey.get(h.key)?.title ?? '—'
        ])
    },
    sessions: [...new Map(hits.map(({ h }) => [h.key, h])).values()]
      .filter((h) => c.byKey.has(h.key))
      .slice(0, MAX_LIST)
      .map((h) => ({ key: h.key, title: c.byKey.get(h.key)!.title, detail: dt(h.ts) })),
    ...(hits.length > MAX_LIST ? { more: hits.length - MAX_LIST } : {})
  }
}

function limitsNowAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  const rows: string[][] = []
  const providers = q.providers?.length ? q.providers : (['claude', 'codex'] as ProviderId[])
  for (const p of providers) {
    const l = d.limitsNow[p]
    if (!l) continue
    for (const [label, g] of [
      ['5-hour', l.fiveHour],
      ['Weekly', l.sevenDay]
    ] as const) {
      if (!g || (q.window && (q.window === '5h') !== (label === '5-hour'))) continue
      rows.push([
        PROVIDER_NAME[p],
        label,
        `${Math.round(g.pct)}%`,
        g.resetsAt ? dt(g.resetsAt) : '—'
      ])
    }
  }
  return {
    headline: rows.length
      ? rows.map((r) => `${r[0]} ${r[1]}: **${r[2]}**`).join(' · ')
      : 'No current limit reading on this PC.',
    interpretation: 'Current plan limits',
    steps: [
      "Claude Code: the latest reading from the status line bridge (Usage & limits), plus the app's own summary and Ask runs since then.",
      'Codex: the latest rate-limit reading in its rollouts.'
    ],
    table: { columns: ['Agent', 'Window', 'Used', 'Resets'], rows }
  }
}

function plansAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  const providers = q.providers?.length ? q.providers : (['claude', 'codex'] as ProviderId[])
  const rows: string[][] = []
  const bits: string[] = []
  if (providers.includes('claude')) {
    bits.push(`Claude: **${d.plans.claude.current}**`)
    for (const h of d.plans.claude.history)
      rows.push(['Claude', h.from === '2000-01-01' ? 'before' : dayLabel(h.from), h.plan])
  }
  if (providers.includes('codex') && d.plans.codex) {
    bits.push(`ChatGPT (Codex): **${d.plans.codex.current}**`)
    for (const ch of d.plans.codex.changes) rows.push(['ChatGPT', dt(ch.at), ch.plan])
  }
  const inRangeRows = q.range
    ? rows.filter((r) => {
        const t = Date.parse(r[1])
        return Number.isNaN(t) || inRange(t, q.range)
      })
    : rows
  return {
    headline: bits.length ? `${bits.join(' · ')}.` : 'No plan is set.',
    interpretation: 'Subscription plans and when they changed',
    steps: [
      'Claude: the plan in Settings → Usage, and the changes recorded when it was changed there.',
      "ChatGPT (Codex): the plan Settings shows for Codex, and the plan_type changes in Codex's rate-limit readings."
    ],
    table: { columns: ['Account', 'From', 'Plan'], rows: inRangeRows }
  }
}

function modelsAnswer(c: Ctx, first: boolean): LocalAnswer {
  const { q, d } = c
  const recs = d.records.filter(
    (r) =>
      (first || inRange(r.ts, q.range)) &&
      recordMatches(r, q) &&
      (!q.providers?.length || q.providers.includes(providerOfRecord(r))) &&
      (!q.projects?.length ||
        q.projects.some((p) => p.toLowerCase() === c.byKey.get(r.key)?.project.toLowerCase()))
  )
  const by = new Map<
    string,
    { n: number; tokens: number; first: number; last: number; firstKey: string; lastKey: string }
  >()
  for (const r of recs) {
    const m = by.get(r.model) ?? {
      n: 0,
      tokens: 0,
      first: r.ts,
      last: r.ts,
      firstKey: r.key,
      lastKey: r.key
    }
    m.n++
    m.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
    if (r.ts < m.first) {
      m.first = r.ts
      m.firstKey = r.key
    }
    if (r.ts > m.last) {
      m.last = r.ts
      m.lastKey = r.key
    }
    by.set(r.model, m)
  }
  const sorted = [...by.entries()].sort((a, b) => b[1].n - a[1].n)
  if (first) {
    const pick = [...by.values()].sort((a, b) =>
      q.which === 'last' ? b.last - a.last : a.first - b.first
    )[0]
    const ts = pick ? (q.which === 'last' ? pick.last : pick.first) : undefined
    const key = pick ? (q.which === 'last' ? pick.lastKey : pick.firstKey) : undefined
    const s = key ? c.byKey.get(key) : undefined
    return {
      headline: pick
        ? `You ${q.which === 'last' ? 'last' : 'first'} used ${q.models?.join(' or ') ?? 'it'} on **${dt(ts)}**${s ? ` (in “${s.title}”)` : ''}.`
        : `No response from ${q.models?.join(' or ') ?? 'that model'} is in your usage records.`,
      interpretation: `The ${q.which === 'last' ? 'latest' : 'earliest'} response from a model containing ${q.models?.map((m) => `“${m}”`).join(' or ')}`,
      steps: ['Looked through every usage record on this PC (one per response) for that model.'],
      table: {
        columns: ['Model', 'First', 'Last', 'Responses'],
        rows: sorted.map(([m, v]) => [modelLabel(m), dt(v.first), dt(v.last), formatInt(v.n)])
      },
      ...(s ? { sessions: [{ key: s.key, title: s.title, detail: dt(ts) }] } : {})
    }
  }
  return {
    headline: `**${plural(sorted.length, 'model')}**${q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''}${sorted[0] ? `, mostly ${modelLabel(sorted[0][0])}` : ''}.`,
    interpretation: `Models that answered${filterWords(q) ? ` ${filterWords(q)}` : ''}${q.range ? `, ${q.range.label}` : ''}`,
    steps: [
      'Counted the usage records on this PC (one per response) by the model that wrote them.'
    ],
    table: {
      columns: ['Model', 'Responses', 'Tokens', 'First', 'Last'],
      align: ['left', 'right', 'right', 'left', 'left'],
      rows: sorted
        .slice(0, 40)
        .map(([m, v]) => [
          modelLabel(m),
          formatInt(v.n),
          formatTokens(v.tokens),
          dt(v.first),
          dt(v.last)
        ])
    }
  }
}

function gitOff(): LocalAnswer {
  return {
    headline: 'Git links are off, so commits, PRs and files are not known.',
    interpretation: 'Git links',
    steps: ['Turn on Settings → Git to link sessions to their commits, branches and pull requests.']
  }
}

function commitsAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  if (!d.git.enabled) return gitOff()
  const { pool, notes } = sessionPool({ ...c, q: { ...q, commits: undefined } })
  const allowed = new Map(pool.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const list = d.git
    .commits()
    .filter((x) => allowed.has(x.key) && inRange(x.at, q.range))
    .filter((x) => !q.files?.length || q.files.some((f) => x.files.some((p) => pathMatches(p, f))))
    .sort((a, b) => b.at - a.at)
    .filter((x) => (seen.has(x.sha) ? false : (seen.add(x.sha), true)))
  const fw = filterWords(q)
  return {
    headline: `**${plural(list.length, 'commit')}**${fw ? ` ${fw}` : ''}${q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''}.`,
    interpretation: `Commits linked to your sessions${fw ? ` ${fw}` : ''}${q.range ? `, ${q.range.label}` : ''}`,
    steps: [
      'Git links: commits linked to a session (exact, high or medium links; “possible” ones are left out), by commit time.',
      ...notes
    ],
    commits: list.slice(0, MAX_LIST).map((x) => ({
      key: x.key,
      sha: x.sha,
      subject: x.subject,
      detail: `${dt(x.at)} · ${allowed.get(x.key)?.title ?? ''}${x.pr ? ` · PR #${x.pr}` : ''}`
    })),
    ...(list.length > MAX_LIST ? { more: list.length - MAX_LIST } : {})
  }
}

function prsAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  if (!d.git.enabled) return gitOff()
  const { pool } = sessionPool(c)
  const allowed = new Map(pool.map((s) => [s.key, s]))
  const byNum = new Map<string, LocalPr>()
  for (const p of d.git.prs()) {
    const s = allowed.get(p.key)
    if (!s) continue
    const t = p.at ?? s.lastActivityAt ?? 0
    if (!inRange(t, q.range)) continue
    const k = `${p.url}`
    if (!byNum.has(k)) byNum.set(k, p)
  }
  const list = [...byNum.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return {
    headline: `**${plural(list.length, 'pull request')}**${q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''}.`,
    interpretation: `Pull requests linked to your sessions${q.range ? `, ${q.range.label}` : ''}`,
    steps: [
      'Git links: PRs a session opened (its own `gh pr create` output), PRs named in merge or squash commits, and GitHub CLI lookups if you turned them on.',
      'Dated by when the session showed the PR, else by its last activity.'
    ],
    table: {
      columns: ['PR', 'Title', 'State', 'Session'],
      rows: list
        .slice(0, MAX_LIST)
        .map((p) => [`#${p.number}`, p.title ?? '', p.state ?? '', allowed.get(p.key)?.title ?? ''])
    },
    sessions: [...new Set(list.map((p) => p.key))]
      .slice(0, MAX_LIST)
      .map((k) => ({ key: k, title: allowed.get(k)!.title }))
  }
}

function filesAnswer(c: Ctx): LocalAnswer {
  const { q, d } = c
  if (!d.git.enabled) return gitOff()
  const { pool } = sessionPool(c)
  const allowed = new Set(pool.map((s) => s.key))
  const by = new Map<string, Set<string>>()
  for (const f of d.git.files()) {
    if (!allowed.has(f.key)) continue
    if (q.range && f.at && !inRange(f.at, q.range)) continue
    if (q.range && !f.at) continue
    const p = normQueryPath(f.path)
    const set = by.get(p) ?? new Set()
    set.add(f.key)
    by.set(p, set)
  }
  const sorted = [...by.entries()].sort((a, b) => b[1].size - a[1].size)
  return {
    headline: `**${plural(sorted.length, 'file')}** edited${filterWords(q) ? ` ${filterWords(q)}` : ''}${q.range ? ` ${q.range.label.replace(/ \(.*\)$/, '')}` : ''}${sorted[0] ? `; most often ${sorted[0][0]}` : ''}.`,
    interpretation: `Files your sessions edited${q.range ? `, ${q.range.label}` : ''}`,
    steps: [
      "Files named by the sessions' own edit tool calls (Edit, Write, apply_patch…), by when each was last edited."
    ],
    table: {
      columns: ['File', 'Sessions'],
      align: ['left', 'right'],
      rows: sorted.slice(0, 40).map(([p, s]) => [p, formatInt(s.size)])
    }
  }
}

function projectDatesAnswer(c: Ctx): LocalAnswer {
  const { pool } = sessionPool(c)
  const q = c.q
  const sorted = [...pool].sort((a, b) =>
    q.which === 'last'
      ? (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
      : (a.startedAt ?? 0) - (b.startedAt ?? 0)
  )
  const s = sorted[0]
  const ts = s ? (q.which === 'last' ? s.lastActivityAt : s.startedAt) : undefined
  return {
    headline: s
      ? `You ${q.which === 'last' ? 'last worked' : 'first worked'} on ${q.projects?.join(', ')} on **${dt(ts)}** (“${s.title}”), across ${plural(pool.length, 'session')}.`
      : `No session of ${q.projects?.join(', ')} is on this PC.`,
    interpretation: `The ${q.which === 'last' ? 'latest' : 'earliest'} session of ${q.projects?.join(', ')}`,
    steps: [
      'The session list on this PC, by first message (start) or last message (last activity).'
    ],
    sessions: sorted
      .slice(0, 5)
      .map((x) => ({
        key: x.key,
        title: x.title,
        detail: `${dt(x.startedAt)} – ${dt(x.lastActivityAt)}`
      }))
  }
}

/** Work out a local answer. */
export function computeLocal(q: LocalQuery, d: LocalData): LocalAnswer {
  const c: Ctx = { d, q, byKey: new Map(d.sessions.map((s) => [s.key, s])) }
  switch (q.intent) {
    case 'cost':
      return costAnswer(c, false)
    case 'tokens':
      return costAnswer(c, true)
    case 'limitHits':
      return limitHitsAnswer(c)
    case 'limitsNow':
      return limitsNowAnswer(c)
    case 'plans':
      return plansAnswer(c)
    case 'models':
      return modelsAnswer(c, false)
    case 'modelFirst':
      return modelsAnswer(c, true)
    case 'commits':
      return commitsAnswer(c)
    case 'prs':
      return prsAnswer(c)
    case 'files':
      return filesAnswer(c)
    case 'projectDates':
      return projectDatesAnswer(c)
    default:
      return sessionsAnswer(c)
  }
}

/** Questions to try (local ones first). */
export const SUGGESTED_ASK = [
  'How many sessions used Opus last week?',
  'What did I spend on Codex last month?',
  'Which sessions touched bridge.ts?',
  'How often did I hit my limit this month?',
  'Where did I fix the WSL path bug?',
  'What did I decide about pricing?'
]
