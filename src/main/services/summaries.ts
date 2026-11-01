// Session summaries: written by Claude through `claude -p` on the user's
// subscription (see print-runner.ts, shared with Ask Claude), one at a time,
// only when asked (one session, a selection) or, opt-in, for big idle sessions.
//
// Before each run the live 5-hour limit is checked: above the threshold in
// Settings a bulk run pauses (Resume goes on anyway), and auto-summarize skips.
// The usage of every run is recorded from the CLI's answer, because
// --no-session-persistence leaves no session file to read it from.
//
// Summaries are stored in the app's metadata only, never in Claude's files.

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { parseAskOutput, printCommand, tooOldForAsk } from '@shared/ask'
import { now } from '@shared/clock'
import {
  answeringModel,
  buildSummaryPrompt,
  cleanSummaryFields,
  estimateSummaries,
  newSinceSummary,
  parseSummaryAnswer,
  runUsageRecords,
  transcriptForSummary,
  type AiSummary,
  type SummaryEstimate,
  type SummarySettings
} from '@shared/summary'
import type { SummaryJob, SummaryPreview, SummaryQueueState } from '@shared/summary-queue'
import type { SessionSummary } from '@shared/types'
import type { ModelPrice } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'
import type { PrintRequest, PrintRunner } from './print-runner'
import type { SessionService } from './sessions'

export interface SummaryServiceDeps {
  sessions: SessionService
  dataDir: string
  runner: PrintRunner
  settings: () => SummarySettings
  /** Seconds before a run is given up. */
  timeoutSec: () => number
  prices: () => ModelPrice[]
  /** The live 5-hour %, if there's a current reading. */
  fiveHourPct: () => Promise<number | undefined>
  /** Limit-health baseline: $ per 1% of the 5-hour window at the current plan, if known. */
  dollarsPerPct: () => number | undefined
  /** Record a run's usage in the app's usage data. */
  recordUsage: (recs: UsageRecord[]) => void
  /** Fixtures mode: write a sample summary instead of running anything. */
  simulate?: boolean
}

/** Most sessions one request can queue or estimate. */
export const MAX_BATCH = 500
/** Auto-summarize: a session must have been idle this long (so a running one is left alone). */
export const AUTO_IDLE_MS = 30 * 60_000
/** Auto-summarize: at most this many runs an hour. */
export const AUTO_PER_HOUR = 6
/** Auto-summarize: a failed session isn't tried again for this long. */
const AUTO_RETRY_MS = 6 * 3600_000
/** Finished jobs shown in the queue panel. */
const KEEP_FINISHED = 50

export const NOT_ACCEPTED =
  'Read and accept the notice about what is sent to Claude first (Summarize shows it).'

function isFinished(j: SummaryJob): boolean {
  return j.status === 'done' || j.status === 'failed' || j.status === 'cancelled'
}

/** Which sessions auto-summarize would pick now, oldest activity first. */
export function autoCandidates(
  list: SessionSummary[],
  settings: Pick<SummarySettings, 'autoMinMessages'>,
  t: number,
  skip: (key: string) => boolean = () => false
): SessionSummary[] {
  return list
    .filter((s) => {
      if (s.availability === 'imported' || s.source === 'ask-claude' || s.meta.hidden) return false
      if (s.messageCount < settings.autoMinMessages || skip(s.key)) return false
      const last = Date.parse(s.lastActivityAt ?? '')
      if (!Number.isFinite(last) || t - last < AUTO_IDLE_MS) return false
      const sum = s.meta.aiSummary
      if (!sum) return true
      // A summary edited by hand is never replaced automatically.
      if (sum.editedAt) return false
      return newSinceSummary(sum, s.messageCount) >= Math.max(20, settings.autoMinMessages / 2)
    })
    .sort((a, b) => (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? ''))
}

export class SummaryService extends EventEmitter<{ changed: [] }> {
  private jobs: SummaryJob[] = []
  private running: { job: SummaryJob; req: PrintRequest } | undefined
  private pumping = false
  private paused: SummaryQueueState['paused']
  /** Resume was clicked: go on above the threshold until the queue is empty. */
  private override = false
  private autoRuns: number[] = []
  private autoFailed = new Map<string, number>()
  private autoTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: SummaryServiceDeps) {
    super()
  }

  state(): SummaryQueueState {
    return {
      jobs: this.jobs.map((j) => ({ ...j })),
      running: this.running?.job.key,
      paused: this.paused ? { ...this.paused } : undefined,
      override: this.override,
      simulated: this.deps.simulate === true
    }
  }

  private changed(): void {
    this.emit('changed')
  }

  // ------------------------------------------------------------ preparing

  /** The exact prompt for a session, and the size of what's sent. */
  private async prepare(
    key: string
  ): Promise<{ s: SessionSummary; prompt: string; chars: number; kept: number; total: number }> {
    const d = await this.deps.sessions.detail(key)
    if (!d) throw new Error("This session's file can't be read right now.")
    const t = transcriptForSummary(d.messages, this.deps.settings().maxChars)
    if (!t.total) throw new Error('This session has no conversation to summarize yet.')
    const s = d.summary
    const prompt = buildSummaryPrompt(
      {
        title: s.title,
        cwd: s.cwd,
        gitBranch: s.gitBranch,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        messageCount: s.messageCount
      },
      t
    )
    return { s, prompt, chars: prompt.length, kept: t.kept, total: t.total }
  }

  private estimateFor(chars: number[]): SummaryEstimate {
    return estimateSummaries(
      chars,
      this.deps.settings().model,
      this.deps.prices(),
      this.deps.dollarsPerPct()
    )
  }

  /** Exactly what would be sent for one session, with an estimate. */
  async preview(key: string): Promise<SummaryPreview> {
    const p = await this.prepare(key)
    return {
      key,
      prompt: p.prompt,
      bytes: Buffer.byteLength(p.prompt),
      chars: p.chars,
      kept: p.kept,
      total: p.total,
      estimate: this.estimateFor([p.chars]),
      fiveHourPct: await this.deps.fiveHourPct().catch(() => undefined)
    }
  }

  /** What summarizing these sessions would send and use, roughly. */
  async estimate(
    keys: string[]
  ): Promise<SummaryEstimate & { skipped: number; fiveHourPct?: number }> {
    const chars: number[] = []
    let skipped = 0
    for (const key of [...new Set(keys)].slice(0, MAX_BATCH)) {
      try {
        chars.push((await this.prepare(key)).chars)
      } catch {
        skipped++
      }
    }
    return {
      ...this.estimateFor(chars),
      skipped,
      fiveHourPct: await this.deps.fiveHourPct().catch(() => undefined)
    }
  }

  // --------------------------------------------------------------- queue

  /** Queue sessions to summarize (one at a time, in order). Returns how many were added. */
  enqueue(keys: string[], origin: SummaryJob['origin'] = 'manual'): number {
    if (!this.deps.settings().noticeAccepted) throw new Error(NOT_ACCEPTED)
    let added = 0
    const active = new Set(this.jobs.filter((j) => !isFinished(j)).map((j) => j.key))
    for (const key of [...new Set(keys)].slice(0, MAX_BATCH)) {
      const s = this.deps.sessions.get(key)
      if (!s || active.has(key)) continue
      // A key queued again replaces its finished entry.
      this.jobs = this.jobs.filter((j) => j.key !== key)
      this.jobs.push({
        id: randomBytes(6).toString('hex'),
        key,
        title: s.title,
        origin,
        status: 'queued'
      })
      added++
    }
    // A new manual request is a new decision about the limit.
    if (added && origin !== 'auto') {
      this.override = false
      this.paused = undefined
    }
    this.trim()
    this.changed()
    void this.pump()
    return added
  }

  private trim(): void {
    const finished = this.jobs.filter(isFinished)
    if (finished.length <= KEEP_FINISHED) return
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((j) => j.id))
    this.jobs = this.jobs.filter((j) => !drop.has(j.id))
  }

  /** Cancel one session's job (queued or running), or all of them. */
  cancel(key?: string): void {
    for (const j of this.jobs) {
      if (isFinished(j) || (key && j.key !== key)) continue
      if (this.running?.job === j) this.deps.runner.cancel(this.running.req)
      else {
        j.status = 'cancelled'
        j.error = 'Cancelled.'
      }
    }
    if (!this.jobs.some((j) => j.status === 'queued')) {
      this.paused = undefined
      this.override = false
    }
    this.changed()
  }

  /** Go on with a paused queue, above the threshold, until it's empty. */
  resume(): void {
    this.override = true
    this.paused = undefined
    this.changed()
    void this.pump()
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => !isFinished(j))
    this.changed()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.status === 'queued')
        if (!job) break
        if (this.paused) break
        const limit = this.deps.settings().pauseAbovePct
        const pct = await this.deps.fiveHourPct().catch(() => undefined)
        if (pct !== undefined && pct > limit) {
          if (job.origin === 'auto') {
            // Auto-summarize never goes above the threshold.
            job.status = 'cancelled'
            job.error = `Skipped: the 5-hour limit is at ${Math.round(pct)}%.`
            this.changed()
            continue
          }
          if (!this.override) {
            this.paused = { pct, limit }
            this.changed()
            break
          }
        }
        await this.runJob(job)
      }
    } finally {
      this.pumping = false
    }
    if (!this.jobs.some((j) => j.status === 'queued')) {
      this.override = false
      this.changed()
    }
  }

  private async runJob(job: SummaryJob): Promise<void> {
    const req = this.deps.runner.newRequest()
    this.running = { job, req }
    job.status = 'running'
    job.startedAt = now()
    this.changed()
    try {
      const res = await this.summarize(job, req)
      if (req.cancelled) {
        job.status = 'cancelled'
        job.error = 'Cancelled.'
      } else if (res.ok) job.status = 'done'
      else {
        job.status = 'failed'
        job.error = res.error
      }
    } catch (err) {
      job.status = 'failed'
      job.error = (err as Error).message
    } finally {
      this.running = undefined
    }
    if (job.origin === 'auto' && job.status === 'failed') this.autoFailed.set(job.key, Date.now())
    job.finishedAt = now()
    this.changed()
  }

  /** Write one session's summary. */
  private async summarize(
    job: SummaryJob,
    req: PrintRequest
  ): Promise<{ ok: boolean; error?: string }> {
    const p = await this.prepare(job.key)
    // Shown in the queue before anything is sent (auto-summarize included).
    job.estimate = this.estimateFor([p.chars])
    this.changed()
    if (req.cancelled) return { ok: false, error: 'Cancelled.' }
    const settings = this.deps.settings()
    const ranAt = now()
    if (this.deps.simulate) {
      await this.deps.runner.until(req, new Promise((r) => setTimeout(r, 1200)))
      if (req.cancelled) return { ok: false, error: 'Cancelled.' }
      this.store(p.s, sampleSummary(p.s), {
        model: 'claude-sonnet-5-5 (sample)',
        at: ranAt,
        chars: p.chars
      })
      return { ok: true }
    }
    const extra = [
      '--no-session-persistence',
      ...(settings.model === 'default' ? [] : ['--model', settings.model])
    ]
    const out = await this.deps.runner.run(req, p.prompt, {
      cwd: join(this.deps.dataDir, 'ask'),
      timeoutMs: this.deps.timeoutSec() * 1000,
      command: (cli) => printCommand(cli, extra)
    })
    if (out.kind === 'cancelled') return { ok: false, error: 'Cancelled.' }
    if (out.kind === 'refused') return { ok: false, error: out.error }
    const res = out.result
    // Whatever happened, the tokens used are counted.
    const records = runUsageRecords(res.stdout, {
      runId: randomBytes(8).toString('hex'),
      ts: ranAt,
      env: out.cli.kind === 'wsl' ? 'wsl' : 'windows',
      fallbackModel: settings.model
    })
    if (records.length) this.deps.recordUsage(records)
    if (res.cancelled) return { ok: false, error: 'Cancelled.' }
    if (res.timedOut)
      return {
        ok: false,
        error: `No answer after ${this.deps.timeoutSec()} seconds. Try again, or raise the Ask Claude timeout in Settings.`
      }
    const parsed = parseAskOutput(res.stdout, res.stderr, res.code)
    if (!parsed.ok)
      return {
        ok: false,
        error: tooOldForAsk(res.stderr)
          ? 'This version of Claude Code is too old for summaries, which run it in safe mode with none of your settings. Update it with `claude update`, then try again.'
          : parsed.error
      }
    const fields = parseSummaryAnswer(parsed.answer)
    if (!fields) return { ok: false, error: "Claude's answer wasn't a summary. Try again." }
    this.store(p.s, fields, {
      model: answeringModel(records),
      at: ranAt,
      chars: p.chars,
      costUsd: parsed.costUsd
    })
    return { ok: true }
  }

  private store(
    s: SessionSummary,
    fields: ReturnType<typeof cleanSummaryFields>,
    run: { model?: string; at: number; chars: number; costUsd?: number }
  ): void {
    const summary: AiSummary = {
      ...fields,
      ...(run.model ? { model: run.model } : {}),
      generatedAt: new Date(run.at).toISOString(),
      messageCount: s.messageCount,
      sentChars: run.chars,
      ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {})
    }
    this.deps.sessions.setAiSummary(s.key, summary)
  }

  // --------------------------------------------------------------- edits

  /** Save a summary edited by hand. */
  save(key: string, patch: unknown): SessionSummary | null {
    const s = this.deps.sessions.get(key)
    if (!s) return null
    const prev = s.meta.aiSummary
    if (!prev) throw new Error('This session has no summary to edit yet.')
    const f = cleanSummaryFields({ ...prev, ...(patch && typeof patch === 'object' ? patch : {}) })
    const next: AiSummary = { ...prev, ...f, editedAt: new Date(now()).toISOString() }
    if (!f.title) delete next.title
    return this.deps.sessions.setAiSummary(key, next)
  }

  remove(key: string): SessionSummary | null {
    return this.deps.sessions.setAiSummary(key, undefined)
  }

  // ------------------------------------------------------- auto-summarize

  /** Look for big idle sessions now and then (opt-in, off by default). */
  startAuto(intervalMs = 10 * 60_000): void {
    this.stopAuto()
    this.autoTimer = setInterval(() => void this.autoTick(), intervalMs)
    this.autoTimer.unref?.()
  }

  stopAuto(): void {
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.autoTimer = undefined
  }

  /** Which sessions auto-summarize would summarize now (for Settings), with an estimate. */
  async autoPreview(): Promise<{ count: number; estimate: SummaryEstimate }> {
    const list = autoCandidates(this.deps.sessions.list(), this.deps.settings(), now(), (k) =>
      this.recentlyFailed(k)
    )
    const sample = list.slice(0, 50)
    const est = await this.estimate(sample.map((s) => s.key))
    // Scale the sample to the whole list (reading every file just for this would be slow).
    const f = sample.length ? list.length / sample.length : 0
    return {
      count: list.length,
      estimate: {
        sessions: list.length,
        chars: Math.round(est.chars * f),
        tokens: Math.round(est.tokens * f),
        costUsd: est.costUsd * f,
        ...(est.pct5h !== undefined ? { pct5h: est.pct5h * f } : {})
      }
    }
  }

  private recentlyFailed(key: string): boolean {
    const at = this.autoFailed.get(key)
    return at !== undefined && Date.now() - at < AUTO_RETRY_MS
  }

  /** One auto-summarize check: queue at most what this hour still allows. Returns how many. */
  async autoTick(): Promise<number> {
    const st = this.deps.settings()
    if (!st.autoEnabled || !st.noticeAccepted) return 0
    if (this.jobs.some((j) => !isFinished(j))) return 0
    const pct = await this.deps.fiveHourPct().catch(() => undefined)
    if (pct !== undefined && pct > st.pauseAbovePct) return 0
    const t = Date.now()
    this.autoRuns = this.autoRuns.filter((x) => t - x < 3600_000)
    const room = AUTO_PER_HOUR - this.autoRuns.length
    if (room <= 0) return 0
    const pick = autoCandidates(this.deps.sessions.list(), st, now(), (k) =>
      this.recentlyFailed(k)
    ).slice(0, room)
    if (!pick.length) return 0
    this.autoRuns.push(...pick.map(() => t))
    return this.enqueue(
      pick.map((s) => s.key),
      'auto'
    )
  }
}

/** Fixtures mode: a plausible summary made from the session's own fields. */
function sampleSummary(s: SessionSummary): ReturnType<typeof cleanSummaryFields> {
  const topic = (s.firstPrompt ?? s.title).replace(/\s+/g, ' ').slice(0, 90)
  return {
    title: s.title.slice(0, 60),
    done: [
      `Worked on: ${topic}`,
      `Went through ${s.messageCount} messages and ${s.toolCallCount} tool calls in ${s.projectName}.`,
      'Sample summary: fixtures mode does not run Claude.'
    ],
    files: [],
    decisions: ['(sample) On your PC, Claude lists the decisions made here.'],
    todos: ['(sample) On your PC, Claude lists what is still open.'],
    pickUp: `Sample summary for ${s.projectName}. On your PC, this says where to pick up next time.`
  }
}
