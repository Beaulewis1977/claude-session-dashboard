// "Ask across sessions" (docs/ROADMAP.md, feature 7).
//
// Local questions (counts, dates, models, usage, limits, commits, PRs, files,
// plans) are worked out here from data the app already has: nothing is sent.
//
// Content questions are off until I turn them on (Settings → Ask, after a
// one-time notice). Then the index (a worker thread, see host.ts) finds the
// best passages, and a preview shows exactly which snippets would be sent
// (secrets masked) and lets me leave any out. Only Send runs my own `claude
// -p`, with the same isolation as Ask Claude and summaries (see
// print-runner.ts): prompt on stdin, no tools, safe mode, no settings files,
// --no-session-persistence, a fixed model alias and effort level, an
// allowlisted environment, the subscription confirmed first, a timeout and
// Cancel. Its usage is recorded as "Ask (dashboard)". Every statement of the
// answer must cite a snippet that was sent; the rest are dropped.
//
// A phone can ask local questions directly. A phone's content question only
// waits on the PC (it comes forward), and nothing is sent until I review the
// preview there and click Send. History is kept in the app's data folder.

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { parseAskOutput, printCommand, tooOldForAsk } from '@shared/ask'
import {
  aboutPassage,
  commitPassage,
  summaryPassage,
  type Passage
} from '@shared/ask-sessions/chunk'
import { checkCitations } from '@shared/ask-sessions/citations'
import {
  computeLocal,
  modelMatches,
  routeQuestion,
  scopeChips,
  vocabOf,
  type LocalData
} from '@shared/ask-sessions/local'
import {
  buildAskSessionsPrompt,
  estimateAsk,
  fitSnippets,
  MAX_QUESTION_CHARS
} from '@shared/ask-sessions/prompt'
import {
  askChoice,
  isAskEffort,
  isAskModel,
  PHONE_REQUEST_TTL,
  sanitizeAskSessions,
  sanitizeScope,
  type AskCitation,
  type AskEffort,
  type AskGuard,
  type AskIndexStatus,
  type AskModel,
  type AskPhoneRequest,
  type AskPreview,
  type AskResult,
  type AskScope,
  type AskSessionsItem,
  type AskSessionsSettings,
  type AskSnippet,
  type LocalAnswer
} from '@shared/ask-sessions/types'
import { now } from '@shared/clock'
import { normQueryPath } from '@shared/git/query'
import type { PrLink } from '@shared/git/types'
import { PROVIDER_LABEL, providerOf } from '@shared/provider'
import { SOURCE_LABELS } from '@shared/source-label'
import { answeringModel, redactSecrets, runUsageRecords, type GuardReading } from '@shared/summary'
import type { SessionSummary } from '@shared/types'
import { PLAN_LABEL, type LimitsState } from '@shared/usage/limits'
import type { PlanChange } from '@shared/usage/health'
import { CODEX_PLAN_LABEL, planOfCode, type CodexLimitsState } from '@shared/usage/codex'
import type { ModelPrice } from '@shared/usage/pricing'
import { dayKey, localParts, localTimeZone } from '@shared/usage/time'
import type { LimitHit, UsageRecord, WeekStart } from '@shared/usage/types'
import { JsonStore } from '../core/json-store'
import type { PrintRequest, PrintRunner } from '../services/print-runner'
import type { IndexJob } from './core'
import type { IndexHost } from './host'

export interface AskSessionsHistoryFile {
  version: 1
  items: AskSessionsItem[]
}

/** The history file (kept in backups, like Ask Claude's). */
export const ASK_SESSIONS_HISTORY = 'ask-sessions-history.json'

export function createAskSessionsStore(dataDir: string): JsonStore<AskSessionsHistoryFile> {
  return new JsonStore<AskSessionsHistoryFile>(
    join(dataDir, ASK_SESSIONS_HISTORY),
    dataDir,
    () => ({
      version: 1,
      items: []
    })
  )
}

export const MAX_HISTORY = 500
const PREVIEW_TTL = 30 * 60_000
/** A phone may ask a content question once per 30 seconds and 10 times an hour. */
const PHONE_LIMITS = [
  { max: 1, windowMs: 30_000 },
  { max: 10, windowMs: 3600_000 }
]

export const ASK_OFF =
  'Content questions are off. Turn on “Ask across sessions” (Settings → Ask) to search your sessions and send matching snippets to Claude.'

/** What the service needs of the session list. */
export interface AskSessionsSource {
  list(): SessionSummary[]
  get(key: string): SessionSummary | undefined
}

export interface AskGit {
  enabled(): boolean
  linkedCommits(
    key: string
  ): { sha: string; subject: string; at: number; files: string[]; pr?: number }[]
  prsOf(key: string): PrLink[]
  /** PRs the session's own `gh pr create` printed, with when. */
  seenPrs(key: string): { number: number; url: string; at: number }[]
  editedFiles(key: string): { path: string; at: number }[]
  /** Sessions a `touched:` / `commit:` filter matches. */
  filter(q: { text: string; touched: string[]; commits: string[] }): Set<string>
}

export interface AskSessionsDeps {
  dataDir: string
  store: JsonStore<AskSessionsHistoryFile>
  sessions: AskSessionsSource
  git?: AskGit
  usage: {
    recordsOf(view: 'all'): UsageRecord[]
    limitHits(): LimitHit[]
    addDashboardRecords(recs: UsageRecord[]): void
  }
  limits: {
    state(): Promise<LimitsState>
    dollarsPerPct(): number | undefined
  }
  codexLimits?: { state(): CodexLimitsState }
  settings: () => {
    askSessions: AskSessionsSettings
    weekStart: WeekStart
    prices: ModelPrice[]
    codexPrices: ModelPrice[]
    plan: keyof typeof PLAN_LABEL
    planHistory: PlanChange[]
    pauseAbovePct: number
    timeoutSec: number
    showSubagents: boolean
  }
  /** Remember the Ask screen's model and effort for the next question. */
  remember: (choice: { lastModel: AskModel; lastEffort: AskEffort }) => void
  /** The 5-hour % the guard goes by (see guardPct). */
  fiveHourPct: () => Promise<GuardReading | undefined>
  runner: PrintRunner
  createHost: () => IndexHost
  /** Bring the PC window forward (a phone's question waits there). */
  reveal?: () => void
  /** Fixtures mode: answer with a sample instead of running anything. */
  simulate?: boolean
  timeZone?: () => string
}

interface StoredPreview {
  preview: AskPreview
  at: number
}

const sha1 = (t: string): string => createHash('sha1').update(t).digest('hex').slice(0, 16)
const ms = (iso: string | undefined): number | undefined => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : undefined
}

/** "2026-10-14 15:02" in local time. */
function localStamp(ts: number, tz: string): string {
  const p = localParts(ts, tz)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export class AskSessionsService extends EventEmitter<{ changed: []; status: [AskIndexStatus] }> {
  private host: IndexHost | undefined
  private ready = false
  private syncTimer: NodeJS.Timeout | undefined
  private previews = new Map<string, StoredPreview>()
  private running = new Map<string, PrintRequest>()
  private requests = new Map<string, AskPhoneRequest>()
  private phoneTimes = new Map<string, number[]>()

  constructor(private readonly deps: AskSessionsDeps) {
    super()
  }

  private settings(): AskSessionsSettings {
    return sanitizeAskSessions(this.deps.settings().askSessions)
  }

  private tz(): string {
    return this.deps.timeZone?.() ?? localTimeZone()
  }

  // -------------------------------------------------------------- index

  /** The first session scan is done: the index may start (if Ask is on). */
  start(): void {
    this.ready = true
    this.settingsChanged()
  }

  /** Settings changed: start or stop the index. */
  settingsChanged(): void {
    const on = this.settings().enabled
    if (on && this.ready && !this.host) {
      this.startHost()
      this.syncSoon(0)
    } else if (!on && this.host) {
      const h = this.host
      this.host = undefined
      void h.stop()
      this.emit('status', this.status())
    } else if (on) this.syncSoon(1000)
  }

  private startHost(): IndexHost {
    const h = this.deps.createHost()
    this.host = h
    // A replaced host's late reports are ignored.
    h.onStatus(() => {
      if (this.host === h) this.emit('status', this.status())
    })
    return h
  }

  /** A host whose worker failed (phase "error") can't recover: start a new one in its place. */
  private async replaceFailedHost(): Promise<IndexHost | undefined> {
    const old = this.host
    if (!old || old.status()?.phase !== 'error') return old
    const h = this.startHost()
    await old.stop().catch(() => undefined)
    return h
  }

  /** Sessions, names, summaries or git links changed. */
  sessionsChanged(): void {
    if (this.host) this.syncSoon(5000)
  }

  private syncSoon(delay: number): void {
    if (this.syncTimer) {
      if (delay > 0) return
      clearTimeout(this.syncTimer)
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      this.syncNow()
    }, delay)
    this.syncTimer.unref?.()
  }

  private syncNow(): void {
    if (!this.host) return
    this.host.sync(this.jobs(), this.settings().indexBudgetMB * 1024 * 1024)
  }

  /** What the index needs of every session (the dashboard's own runs are left out). */
  jobs(): IndexJob[] {
    const out: IndexJob[] = []
    for (const s of this.deps.sessions.list()) {
      if (s.source === 'ask-claude') continue
      const provider = providerOf(s)
      const meta = this.metaPassages(s)
      out.push({
        key: s.key,
        order: ms(s.lastActivityAt) ?? ms(s.startedAt) ?? 0,
        start: ms(s.startedAt) ?? ms(s.lastActivityAt) ?? 0,
        content: {
          path: s.filePath,
          provider,
          ...(s.cwd ? { cwd: s.cwd } : {}),
          rev: `${s.sizeBytes}|${s.lastActivityAt ?? ''}|${s.availability}|${s.filePath}`
        },
        meta: { rev: sha1(meta.map((p) => p.text).join('\u0000')), passages: meta }
      })
    }
    return out
  }

  private metaPassages(s: SessionSummary): Passage[] {
    const out: Passage[] = [
      aboutPassage({
        title: s.title,
        name: s.meta.name,
        agentName: s.claudeName,
        description: s.meta.description,
        tags: s.meta.tags,
        project: s.projectName,
        branch: s.gitBranch
      })
    ]
    const sum = s.meta.aiSummary ? summaryPassage(s.meta.aiSummary) : undefined
    if (sum) out.push(sum)
    for (const c of (this.deps.git?.linkedCommits(s.key) ?? []).slice(0, 100))
      out.push(commitPassage(c))
    return out
  }

  status(): AskIndexStatus {
    const enabled = this.settings().enabled
    const s = this.host?.status()
    if (!enabled || !this.host)
      return {
        enabled,
        phase: 'off',
        sessions: s?.sessions ?? 0,
        passages: s?.passages ?? 0,
        chars: s?.chars ?? 0,
        bytes: s?.bytes ?? 0,
        done: 0,
        total: 0,
        skipped: 0
      }
    return {
      enabled,
      phase: s?.phase ?? 'loading',
      sessions: s?.sessions ?? 0,
      passages: s?.passages ?? 0,
      chars: s?.chars ?? 0,
      bytes: s?.bytes ?? 0,
      done: s?.done ?? 0,
      total: s?.total ?? 0,
      ...(s?.buildMs !== undefined ? { buildMs: s.buildMs } : {}),
      ...(s?.builtAt ? { builtAt: s.builtAt } : {}),
      ...(s?.updatedAt ? { updatedAt: s.updatedAt } : {}),
      skipped: s?.skipped ?? 0,
      ...(s?.since ? { since: s.since } : {}),
      ...(s?.error ? { error: s.error } : {})
    }
  }

  /** Build the index again from the sessions (Settings → Ask → Rebuild). */
  async rebuild(): Promise<void> {
    const h = await this.replaceFailedHost()
    if (!h) return
    await h.clear()
    this.syncNow()
    this.emit('status', this.status())
  }

  /** Delete the saved index (it's only a cache; Ask builds it again when on). */
  async deleteIndex(): Promise<void> {
    const host = await this.replaceFailedHost()
    if (host) {
      await host.clear()
      this.syncSoon(1000)
    } else {
      // Off: a short-lived host just to remove the file.
      const h = this.deps.createHost()
      await h.clear().catch(() => undefined)
      await h.stop().catch(() => undefined)
    }
    this.emit('status', this.status())
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    for (const r of this.running.values()) this.deps.runner.cancel(r)
    const h = this.host
    this.host = undefined
    await h?.stop().catch(() => undefined)
  }

  // ------------------------------------------------------------- local

  private async localData(): Promise<LocalData> {
    const st = this.deps.settings()
    const list = this.deps.sessions.list()
    const git = this.deps.git
    const limits = await this.deps.limits.state().catch(() => undefined)
    const cx = this.deps.codexLimits?.state()
    const gauge = (g?: { pct: number; resetsAt?: number; expired?: boolean }) =>
      g && !g.expired ? { pct: g.pct, ...(g.resetsAt ? { resetsAt: g.resetsAt } : {}) } : undefined
    let commits: ReturnType<LocalData['git']['commits']> | undefined
    return {
      now: now(),
      timeZone: this.tz(),
      weekStart: st.weekStart,
      sessions: list.map((s) => ({
        key: s.key,
        title: s.title,
        provider: providerOf(s),
        source: s.source,
        env: s.env,
        ...(s.distro ? { distro: s.distro } : {}),
        project: s.projectName,
        ...(ms(s.startedAt) ? { startedAt: ms(s.startedAt) } : {}),
        ...(ms(s.lastActivityAt) ? { lastActivityAt: ms(s.lastActivityAt) } : {}),
        models: s.models,
        subagent: !!s.subagent,
        hidden: !!s.meta.hidden,
        named: !!s.meta.name?.trim(),
        pinned: !!s.meta.pinned,
        tags: s.meta.tags ?? [],
        availability: s.availability,
        messageCount: s.messageCount
      })),
      records: this.deps.usage.recordsOf('all'),
      prices: st.prices,
      codexPrices: st.codexPrices,
      limitHits: this.deps.usage.limitHits(),
      codexLimitHits: cx?.limitHits ?? [],
      limitsNow: {
        ...(limits
          ? { claude: { fiveHour: gauge(limits.fiveHour), sevenDay: gauge(limits.sevenDay) } }
          : {}),
        ...(cx?.hasData
          ? { codex: { fiveHour: gauge(cx.fiveHour), sevenDay: gauge(cx.sevenDay) } }
          : {})
      },
      plans: {
        claude: {
          current: PLAN_LABEL[st.plan] ?? st.plan,
          history: st.planHistory.map((h) => ({
            from: h.from,
            plan: h.plan === 'custom' ? (h.label ?? 'Custom') : (PLAN_LABEL[h.plan] ?? h.plan)
          }))
        },
        ...(cx
          ? {
              codex: {
                current: cx.plan.label,
                changes: cx.plan.changes.map((c) => {
                  const p = planOfCode(c.code)
                  return { at: c.ts, plan: p ? CODEX_PLAN_LABEL[p] : c.code }
                })
              }
            }
          : {})
      },
      git: {
        enabled: !!git?.enabled(),
        touched: (path) =>
          git?.filter({ text: '', touched: [normQueryPath(path)], commits: [] }) ?? new Set(),
        commitSessions: (sha) =>
          git?.filter({ text: '', touched: [], commits: [sha] }) ?? new Set(),
        commits: () =>
          (commits ??= list.flatMap((s) =>
            (git?.linkedCommits(s.key) ?? []).map((c) => ({ key: s.key, ...c }))
          )),
        prs: () =>
          list.flatMap((s) => {
            const links = git?.prsOf(s.key) ?? []
            if (!links.length) return []
            const seen = git?.seenPrs(s.key) ?? []
            const merged = git?.linkedCommits(s.key) ?? []
            return links.map((p) => {
              // When the session showed it (its own `gh pr create`), else its merge commit's time.
              const at =
                seen.find((x) => x.url === p.url)?.at ||
                seen.find((x) => x.number === p.number)?.at ||
                merged
                  .filter((c) => c.pr === p.number)
                  .reduce<number | undefined>(
                    (t, c) => (t === undefined || c.at < t ? c.at : t),
                    undefined
                  )
              return {
                key: s.key,
                number: p.number,
                url: p.url,
                ...(p.title ? { title: p.title } : {}),
                ...(p.state ? { state: p.state } : {}),
                ...(at ? { at } : {})
              }
            })
          }),
        files: () =>
          list.flatMap((s) => (git?.editedFiles(s.key) ?? []).map((f) => ({ key: s.key, ...f })))
      }
    }
  }

  /** A local answer for a phone (computed here, returned, not saved), or "this one is a content question". */
  async phoneLocal(
    question: string
  ): Promise<
    { mode: 'local'; answer: LocalAnswer; chips: string[] } | { mode: 'content'; enabled: boolean }
  > {
    const q = cleanQuestion(question)
    const data = await this.localData()
    const r = routeQuestion(q, vocabOf(data), data.now, data.timeZone, data.weekStart)
    if (r.mode !== 'local') return { mode: 'content', enabled: this.settings().enabled }
    return { mode: 'local', answer: computeLocal(r.query, data), chips: r.chips }
  }

  // ---------------------------------------------------------- questions

  /**
   * A question. A local one is answered (and saved) at once; a content one
   * gets a preview of what would be sent (nothing is sent until send()).
   * `scope` (from the scope chips) is a content question's scope; `content`
   * asks Claude even when the question reads as a local one.
   */
  async ask(
    question: string,
    opts: { scope?: AskScope; content?: boolean; phoneRequest?: string } = {}
  ): Promise<AskResult> {
    const q = cleanQuestion(question)
    if (!q) throw new Error('Type a question first.')
    const data = await this.localData()
    const routed = routeQuestion(q, vocabOf(data), data.now, data.timeZone, data.weekStart)
    const req = opts.phoneRequest ? this.request(opts.phoneRequest) : undefined
    if (opts.phoneRequest && (!req || req.status !== 'pending'))
      throw new Error(
        'That question from your phone is no longer waiting (it was answered, declined or expired).'
      )
    // Local questions carry their own filters; the scope chips are for content questions.
    if (routed.mode === 'local' && !opts.content && !req) {
      const item: AskSessionsItem = {
        id: randomBytes(8).toString('hex'),
        at: now(),
        question: q,
        mode: 'local',
        ok: true,
        local: computeLocal(routed.query, data),
        ...(routed.chips.length ? { scopeText: routed.chips.join(' · ') } : {})
      }
      this.save(item)
      return { mode: 'local', item }
    }
    const st = this.settings()
    if (!st.enabled) return { mode: 'content', blocked: ASK_OFF }
    const status = this.status()
    if (!this.host || status.phase === 'error')
      return {
        mode: 'content',
        blocked: status.error ?? 'The index isn’t running. Try again in a moment.'
      }
    const scope = sanitizeScope(
      opts.scope ?? req?.scope ?? (routed.mode === 'content' ? routed.scope : {})
    )
    if (
      opts.scope === undefined &&
      !req &&
      scope.subagents === undefined &&
      this.deps.settings().showSubagents
    )
      scope.subagents = true
    const allowed = this.deps.sessions
      .list()
      .filter((s) => inScope(s, scope))
      .map((s) => s.key)
    const searchText = routed.mode === 'content' ? routed.searchText : q
    const res = await this.host.search({
      query: searchText,
      allowed,
      ...(scope.from !== undefined ? { from: scope.from } : {}),
      ...(scope.to !== undefined ? { to: scope.to } : {}),
      limit: st.maxSnippets * 3,
      perSession: st.perSession
    })
    const tz = this.tz()
    const candidates: AskSnippet[] = []
    for (const h of res.hits) {
      const s = this.deps.sessions.get(h.key)
      if (!s) continue
      const ts = h.ts ?? ms(s.lastActivityAt)
      candidates.push({
        sid: '',
        key: s.key,
        title: redactSecrets(s.title).slice(0, 200),
        project: s.projectName,
        agent: PROVIDER_LABEL[providerOf(s)],
        where: whereOf(s),
        ...(ts ? { date: localStamp(ts, tz) } : {}),
        kind: h.kind,
        ...(h.msgIds[0] ? { messageId: h.msgIds[0], msgIds: h.msgIds } : {}),
        ...(h.sha ? { sha: h.sha } : {}),
        text: redactSecrets(h.text)
      })
    }
    const { kept, cut } = fitSnippets(candidates, st)
    kept.forEach((s, i) => (s.sid = `S${i + 1}`))
    const choice = askChoice(st)
    const today = dayKey(data.now, tz)
    const preview: AskPreview = {
      id: randomBytes(8).toString('hex'),
      question: q,
      searchText,
      scope,
      scopeText: scopeChips(scope).join(' · ') || 'all my sessions',
      today: `${today} (${WEEKDAY[new Date(`${today}T12:00:00Z`).getUTCDay()]})`,
      snippets: kept,
      matched: res.matched,
      cut,
      model: choice.model,
      effort: choice.effort,
      guard: await this.guard(),
      index: {
        sessions: status.sessions,
        passages: status.passages,
        skipped: status.skipped,
        ...(status.since ? { since: status.since } : {})
      },
      ...(req ? { phone: { device: req.device, requestId: req.id } } : {})
    }
    const t = Date.now()
    for (const [k, v] of this.previews) if (t - v.at > PREVIEW_TTL) this.previews.delete(k)
    this.previews.set(preview.id, { preview, at: t })
    return { mode: 'content', preview }
  }

  private async guard(): Promise<AskGuard> {
    const limit = this.deps.settings().pauseAbovePct
    const g = await this.deps.fiveHourPct().catch(() => undefined)
    if (!g) return { limit, above: false }
    return {
      pct: g.pct,
      limit,
      above: g.pct > limit,
      ...(g.unknown ? { unknown: true } : {})
    }
  }

  private kept(previewId: string, keep: string[]): { p: AskPreview; snippets: AskSnippet[] } {
    const stored = this.previews.get(previewId)
    if (!stored || Date.now() - stored.at > PREVIEW_TTL)
      throw new Error('This preview has expired. Ask again.')
    const want = new Set(keep)
    return { p: stored.preview, snippets: stored.preview.snippets.filter((s) => want.has(s.sid)) }
  }

  /** Exactly what Send would send, with the snippets I kept. */
  promptText(previewId: string, keep: string[]): { prompt: string; chars: number } {
    const { p, snippets } = this.kept(previewId, keep)
    const prompt = this.prompt(p, snippets)
    return { prompt, chars: prompt.length }
  }

  private prompt(p: AskPreview, snippets: AskSnippet[]): string {
    return buildAskSessionsPrompt({
      question: p.question,
      today: p.today,
      timeZone: this.tz(),
      scopeText: p.scopeText,
      snippets
    })
  }

  /** The estimate for the snippets I kept and the model I picked. */
  estimate(previewId: string, keep: string[], model: AskModel) {
    const { p, snippets } = this.kept(previewId, keep)
    return estimateAsk(
      this.prompt(p, snippets).length,
      model,
      this.deps.settings().prices,
      this.deps.limits.dollarsPerPct()
    )
  }

  cancel(previewId: string): void {
    const r = this.running.get(previewId)
    if (r) this.deps.runner.cancel(r)
  }

  /** Send a previewed question with the snippets I kept (what the preview showed is what is sent). */
  async send(
    previewId: string,
    opts: { keep: string[]; model: AskModel; effort: AskEffort }
  ): Promise<AskSessionsItem> {
    if (!this.settings().enabled) throw new Error(ASK_OFF)
    if (!isAskModel(opts.model) || !isAskEffort(opts.effort))
      throw new Error('Unknown model or effort level.')
    const { p, snippets } = this.kept(previewId, opts.keep)
    if (!snippets.length)
      throw new Error('Keep at least one snippet to send, or ask in other words.')
    if (this.running.has(previewId)) throw new Error('This question is already being answered.')
    this.previews.delete(previewId)
    const prompt = this.prompt(p, snippets)
    this.deps.remember({ lastModel: opts.model, lastEffort: opts.effort })
    const req = this.deps.runner.newRequest()
    this.running.set(previewId, req)
    const started = Date.now()
    // `sent` is added only once the prompt reached Claude (not for "no CLI",
    // a refused subscription check or a Cancel before the run started).
    const base: AskSessionsItem = {
      id: previewId,
      at: now(),
      question: p.question,
      mode: 'content',
      ok: false,
      scope: p.scope,
      scopeText: p.scopeText,
      searched: p.searchText,
      matched: p.matched,
      modelChoice: opts.model,
      effort: opts.effort,
      ...(p.phone ? { phone: p.phone.device } : {})
    }
    let item: AskSessionsItem
    try {
      item = await this.answer(prompt, snippets, req, base, started, opts)
    } finally {
      this.running.delete(previewId)
    }
    this.save(item)
    if (p.phone) {
      const r = this.requests.get(p.phone.requestId)
      if (r) {
        r.status = 'sent'
        r.itemId = item.id
      }
      this.emit('changed')
    }
    return item
  }

  private async answer(
    prompt: string,
    snippets: AskSnippet[],
    req: PrintRequest,
    base: AskSessionsItem,
    started: number,
    opts: { model: AskModel; effort: AskEffort }
  ): Promise<AskSessionsItem> {
    const sent: NonNullable<AskSessionsItem['sent']> = {
      snippets: snippets.length,
      sessions: new Set(snippets.map((s) => s.key)).size,
      chars: prompt.length
    }
    const failed = (error: string, where = '—', reached = false): AskSessionsItem => ({
      ...base,
      ...(reached ? { sent } : {}),
      ok: false,
      error,
      where,
      durationMs: Date.now() - started
    })
    let raw: string
    let where: string
    let records: UsageRecord[] = []
    let costUsd: number | undefined
    if (this.deps.simulate) {
      await this.deps.runner.until(req, new Promise((r) => setTimeout(r, 900)))
      if (req.cancelled) return failed('Cancelled.', 'Sample answer (fixtures mode)')
      raw = sampleAnswer(snippets)
      where = 'Sample answer (fixtures mode)'
    } else {
      const extra = [
        '--no-session-persistence',
        ...(opts.model === 'default' ? [] : ['--model', opts.model]),
        ...(opts.effort === 'default' ? [] : ['--effort', opts.effort])
      ]
      const ranAt = now()
      const timeoutSec = this.deps.settings().timeoutSec
      const out = await this.deps.runner.run(req, prompt, {
        cwd: join(this.deps.dataDir, 'ask'),
        timeoutMs: timeoutSec * 1000,
        command: (cli) => printCommand(cli, extra)
      })
      if (out.kind === 'cancelled') return failed('Cancelled.', out.where, !!out.started)
      if (out.kind === 'refused') return failed(out.error, out.where)
      const res = out.result
      // Whatever happened, the tokens used are counted.
      records = runUsageRecords(res.stdout, {
        kind: 'ask',
        runId: randomBytes(8).toString('hex'),
        ts: now(),
        startTs: ranAt,
        env: out.cli.kind === 'wsl' ? 'wsl' : 'windows'
      })
      if (records.length) this.deps.usage.addDashboardRecords(records)
      if (res.cancelled) return failed('Cancelled.', out.where, true)
      if (res.timedOut)
        return failed(
          `No answer after ${timeoutSec} seconds. Try again, or raise the Ask Claude timeout in Settings.`,
          out.where,
          true
        )
      const parsed = parseAskOutput(res.stdout, res.stderr, res.code)
      if (!parsed.ok)
        return failed(
          tooOldForAsk(res.stderr)
            ? 'This version of Claude Code is too old for Ask, which runs it in safe mode with none of your settings. Update it with `claude update`, then try again.'
            : (parsed.error ?? 'No answer.'),
          out.where,
          true
        )
      raw = parsed.answer
      where = out.where
      costUsd = parsed.costUsd
    }
    const valid = new Set(snippets.map((s) => s.sid))
    const checked = checkCitations(raw, valid)
    const bySid = new Map(snippets.map((s) => [s.sid, s]))
    const citations: Record<string, AskCitation> = {}
    for (const sid of checked.cited) {
      const s = bySid.get(sid)
      if (!s) continue
      citations[sid] = {
        key: s.key,
        title: s.title,
        kind: s.kind,
        ...(s.messageId ? { messageId: s.messageId } : {}),
        ...(s.msgIds && s.msgIds.length > 1 ? { msgIds: s.msgIds.slice(0, 20) } : {}),
        ...(s.sha ? { sha: s.sha } : {}),
        ...(s.date ? { date: s.date } : {}),
        preview: s.text.replace(/\s+/g, ' ').slice(0, 160)
      }
    }
    const model = answeringModel(records)
    return {
      ...base,
      sent,
      ok: true,
      answer: checked.answer,
      ...(checked.dropped.length ? { dropped: checked.dropped.slice(0, 30) } : {}),
      ...(checked.notFound ? { notFound: true } : {}),
      citations,
      ...(model ? { model } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Date.now() - started,
      where
    }
  }

  // ------------------------------------------------------------ history

  private save(item: AskSessionsItem): void {
    this.deps.store.update((d) => {
      d.items = [item, ...d.items.filter((x) => x.id !== item.id)].slice(0, MAX_HISTORY)
    })
    this.emit('changed')
  }

  history(): AskSessionsItem[] {
    return [...this.deps.store.value.items].sort((a, b) => b.at - a.at)
  }

  delete(id: string): boolean {
    const had = this.deps.store.value.items.some((x) => x.id === id)
    if (!had) return false
    this.deps.store.update((d) => {
      d.items = d.items.filter((x) => x.id !== id)
    })
    this.emit('changed')
    return true
  }

  flush(): Promise<void> {
    return this.deps.store.flush()
  }

  // ------------------------------------------------------------- phones

  private request(id: string): AskPhoneRequest | undefined {
    const r = this.requests.get(id)
    if (r && r.status === 'pending' && now() - r.at > PHONE_REQUEST_TTL) r.status = 'expired'
    return r
  }

  /** A phone's content question: it waits on the PC for my OK (nothing is sent before). */
  phoneRequest(
    device: { id: string; name: string },
    question: string,
    scope: unknown
  ): AskPhoneRequest {
    if (!this.settings().enabled)
      throw new Error('Ask on your PC: content questions are off there.')
    const q = cleanQuestion(question)
    if (!q) throw new Error('Type a question first.')
    const t = now()
    const times = (this.phoneTimes.get(device.id) ?? []).filter((x) => t - x < 3600_000)
    if (PHONE_LIMITS.some((l) => times.filter((x) => t - x < l.windowMs).length >= l.max))
      throw new Error('Too many questions from this phone. Wait a little, then ask again.')
    times.push(t)
    this.phoneTimes.set(device.id, times)
    const r: AskPhoneRequest = {
      id: randomBytes(8).toString('hex'),
      device: device.name,
      question: q,
      scope: sanitizeScope(scope),
      at: t,
      status: 'pending'
    }
    this.requests.set(r.id, r)
    for (const [k, v] of this.requests) if (t - v.at > 24 * 3600_000) this.requests.delete(k)
    this.deps.reveal?.()
    this.emit('changed')
    return { ...r }
  }

  /** Questions from phones waiting for me on the PC. */
  pending(): AskPhoneRequest[] {
    return [...this.requests.keys()]
      .map((k) => this.request(k)!)
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r }))
  }

  /** A phone checks on its question. */
  requestStatus(id: string): AskPhoneRequest | undefined {
    const r = this.request(id)
    return r ? { ...r } : undefined
  }

  decline(id: string): void {
    const r = this.request(id)
    if (r?.status === 'pending') {
      r.status = 'declined'
      this.emit('changed')
    }
  }
}

function cleanQuestion(q: unknown): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS) : ''
}

function whereOf(s: SessionSummary): string {
  if (s.source === 'cowork') return SOURCE_LABELS.cowork
  if (s.source === 'desktop') return SOURCE_LABELS.desktop
  if (s.availability === 'imported') return 'claude.ai'
  return s.env === 'wsl' ? `WSL${s.distro ? `: ${s.distro}` : ''}` : 'Windows'
}

/** Does a session belong to a content question's scope? */
export function inScope(s: SessionSummary, scope: AskScope): boolean {
  if (s.source === 'ask-claude') return false
  if (!scope.subagents && s.subagent) return false
  if (!scope.hidden && s.meta.hidden) return false
  if (scope.providers?.length && !scope.providers.includes(providerOf(s))) return false
  if (scope.sources?.length && !scope.sources.includes(s.source)) return false
  if (
    scope.projects?.length &&
    !scope.projects.some((p) => p.toLowerCase() === s.projectName.toLowerCase())
  )
    return false
  if (scope.envs?.length && !scope.envs.includes(s.env)) return false
  if (scope.models?.length && !s.models.some((m) => scope.models!.some((n) => modelMatches(m, n))))
    return false
  if (scope.from !== undefined || scope.to !== undefined) {
    const a = ms(s.startedAt) ?? ms(s.lastActivityAt)
    const b = ms(s.lastActivityAt) ?? a
    if (a === undefined || b === undefined) return false
    if (scope.to !== undefined && a >= scope.to) return false
    if (scope.from !== undefined && b < scope.from) return false
  }
  return true
}

function sampleAnswer(snippets: AskSnippet[]): string {
  const a = snippets[0]?.sid ?? 'S1'
  const b = snippets[1]?.sid ?? a
  return [
    `**Sample answer**: fixtures mode doesn't run Claude; on your PC this question goes to \`claude -p\` with the snippets shown. [${a}]`,
    '',
    `- The first snippet is from “${snippets[0]?.title ?? 'a session'}”. [${a}]`,
    `- Another one backs this up. [${b}]`,
    '- This line cites nothing, so it is removed.'
  ].join('\n')
}
