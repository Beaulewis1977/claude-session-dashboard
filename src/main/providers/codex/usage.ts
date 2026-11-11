// Codex token usage and plan limits from a rollout's `token_count` events
// (the text from readCodexUsageText, or a plain rollout in tests).
//
// Each `event_msg` / `token_count` carries:
// - `info.last_token_usage`: the usage of the response it follows
//   (`input_tokens` includes `cached_input_tokens`; `output_tokens` includes
//   `reasoning_output_tokens`), and `info.total_token_usage`, the session's
//   running total. The last usage always equals the change in the total;
//   very old Codex wrote no last usage, so the change is used then.
// - `rate_limits`: the plan limits as of that response.
//
// Counting each response once:
// - Codex sends the same event again with an unchanged total (e.g. when
//   only the limits changed): that's no new usage.
// - A fork's rollout (`codex fork`, forked_from_id) starts with a copy of
//   its parent's events, with new timestamps. So an event's identity is its
//   thread lineage (the first thread of its fork chain, from the catalogue)
//   plus its exact token counts (running total and last usage), never its
//   time or file: the copy and the original are the same response, and the
//   usage store counts it once (the parent's, at its real time).
// - Subagent threads don't copy their parent's usage: they're counted in full.
// - Resumes append to the same rollout; a total that went down (a reset)
//   counts the new event's own usage only.

import { createHash } from 'node:crypto'
import type { CodexLimitReading, CodexLimitWindow } from '@shared/usage/codex'
import { MAIN_LIMIT_ID } from '@shared/usage/codex'
import { parseResetsAt } from '@shared/usage/bridge'
import type { UsageContext } from '@shared/usage/parse'
import type { CodexTurnSample, UsageAnalysis, UsageRecord } from '@shared/usage/types'
import { isContextItem } from './provenance'
import { isToolItemType } from './read'

export type CodexUsageContext = UsageContext

interface Counts {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

const KEYS: (keyof Counts)[] = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens'
]

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function counts(v: unknown): Counts | undefined {
  const o = obj(v)
  if (!o) return undefined
  const c = {} as Counts
  let any = false
  for (const k of KEYS) {
    c[k] = num(o[k])
    if (k in o) any = true
  }
  if (!c.total_tokens) c.total_tokens = c.input_tokens + c.output_tokens
  return any ? c : undefined
}

function minus(a: Counts, b: Counts): Counts {
  const c = {} as Counts
  for (const k of KEYS) c[k] = Math.max(0, a[k] - b[k])
  return c
}

/** A stable text of the counts (for the identity), independent of key order. */
const sig = (c: Counts | undefined): string => (c ? KEYS.map((k) => c[k]).join(',') : '-')

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 20)
}

/**
 * An event's identity: its fork lineage (the first thread of its fork chain),
 * its exact counts (running total and last usage; for an event without new
 * usage, also its limits) and which occurrence of those it is in its file. A
 * fork's rollout copies its parent's events in order, so a copy gets exactly
 * its original's identity, while a counter reset or a repeated reading in one
 * file gets a new one. A response in one fork that happens to match one in a
 * sibling fork is told apart by the store (by ancestry, see codex-usage.ts).
 */
export function codexEventId(root: string, counts: string, occurrence: number): string {
  return `codex:${hash(`${root}|${counts}|${occurrence}`)}`
}

function limitWindow(v: unknown): CodexLimitWindow | undefined {
  const o = obj(v)
  if (!o) return undefined
  const pct = typeof o.used_percent === 'number' ? o.used_percent : Number.NaN
  const minutes = typeof o.window_minutes === 'number' ? o.window_minutes : Number.NaN
  if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(minutes) || minutes <= 0)
    return undefined
  const resetsAt = parseResetsAt(o.resets_at)
  return {
    pct: Math.min(pct, 1000),
    minutes: Math.round(minutes),
    ...(resetsAt ? { resetsAt } : {})
  }
}

/** A reading from `rate_limits`, or undefined if it carries no usable window. */
export function parseRateLimits(
  v: unknown,
  ts: number,
  meta: { id: string; key: string; source: string; sessionId?: string }
): CodexLimitReading | undefined {
  const rl = obj(v)
  if (!rl) return undefined
  const windows: CodexLimitWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const o = obj(rl[slot])
    let w = limitWindow(o)
    // Older Codex: seconds until the reset instead of a time.
    if (w && !w.resetsAt && typeof o?.resets_in_seconds === 'number' && o.resets_in_seconds > 0)
      w = { ...w, resetsAt: ts + Math.round(o.resets_in_seconds * 1000), relative: true }
    // A window that had already reset when it was read says nothing.
    if (w && w.resetsAt !== undefined && w.resetsAt < ts - 60_000) continue
    if (w) windows.push(w)
  }
  if (!windows.length) return undefined
  const credits = obj(rl.credits)
  const r: CodexLimitReading = {
    id: meta.id,
    ts,
    key: meta.key,
    source: meta.source,
    limitId: str(rl.limit_id) ?? MAIN_LIMIT_ID,
    windows
  }
  if (meta.sessionId) r.sessionId = meta.sessionId
  const name = str(rl.limit_name)
  if (name) r.limitName = name
  const plan = str(rl.plan_type)
  if (plan) r.planType = plan
  if (credits)
    r.credits = {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      ...(str(credits.balance) ? { balance: str(credits.balance) } : {})
    }
  const reached = str(rl.rate_limit_reached_type)
  if (reached) r.reached = reached
  return r
}

/** An unchanged limit reading is still kept this often. */
const READING_EVERY_MS = 10 * 60_000

interface Line {
  timestamp?: string
  type?: string
  payload: Record<string, unknown>
}

function lines(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    try {
      const o = obj(JSON.parse(s))
      if (!o) continue
      out.push({
        timestamp: str(o.timestamp),
        type: str(o.type),
        payload: obj(o.payload) ?? {}
      })
    } catch {
      // skipped
    }
  }
  return out
}

/**
 * A user message I wrote (not only context Codex added). The usage reader
 * marks it (`prompt`); a plain rollout is checked here the same way.
 */
function isPrompt(p: Record<string, unknown>): boolean {
  if (p.role !== 'user') return false
  if (typeof p.prompt === 'boolean') return p.prompt
  const content = Array.isArray(p.content) ? p.content : []
  return content.some((c: unknown, i) => {
    const t = (c as { text?: unknown } | null)?.text
    return typeof t === 'string' && t.trim() !== '' && !isContextItem(p, i, t)
  })
}

const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
  'tool_search_call'
])

/**
 * Codex turns for trends: `task_started` → `task_complete` / `turn_aborted`
 * (Codex 0.1xx), each with the responses, tool calls and tool outcomes in it.
 * Rollouts without turn events (older Codex) are split at each prompt I
 * wrote instead. A turn that hasn't ended yet isn't counted.
 *
 * A turn's model is the one its own turn_context names (task_started comes
 * first, so the model in force then may be the previous turn's). A turn that
 * failed before any response still counts (its failure and its prompt).
 *
 * A prompt-split turn (older Codex, no turn ids) takes the identity and the
 * model of its first response. That identity is the response's own (its fork
 * lineage plus its exact token counts, see codexEventId), so a fork's copy of
 * its parent's turn is the same turn (counted once by the store, and still
 * counted when the parent's file is gone), while sibling forks' own turns
 * differ. No time window is involved.
 */
class TurnTracker {
  readonly turns: CodexTurnSample[] = []
  private cur?: CodexTurnSample & {
    fallback: boolean
    /** Its model came from its own turn_context. */
    ownModel: boolean
    items: number
    itemErrors: number
    outputs: number
    outputErrors: number
  }
  private fallbackN = 0
  private sawTaskEvents = false

  constructor(
    private readonly ctx: CodexUsageContext,
    /** This rollout's own session id (a prompt-split turn without a response is numbered per session). */
    private readonly sessionId: string,
    private readonly subagent: boolean
  ) {}

  private open(id: string, ts: number, model: string | undefined, fallback: boolean): void {
    this.cur = {
      ownModel: false,
      id,
      ts,
      key: this.ctx.key,
      ...(model ? { model } : {}),
      ...(this.ctx.version ? { version: this.ctx.version } : {}),
      responses: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0,
      toolResults: 0,
      toolErrors: 0,
      aborted: false,
      failed: false,
      prompted: false,
      ...(this.subagent ? { subagent: true as const } : {}),
      fallback,
      items: 0,
      itemErrors: 0,
      outputs: 0,
      outputErrors: 0
    }
  }

  private close(): void {
    const c = this.cur
    this.cur = undefined
    if (!c || (!c.responses && !c.toolCalls && !c.aborted && !c.failed)) return
    const { fallback: _f, ownModel: _m, items, itemErrors, outputs, outputErrors, ...t } = c
    // Finished tool items say how each tool ended (newer Codex); else the exit codes in outputs.
    if (items) {
      t.toolResults = items
      t.toolErrors = itemErrors
    } else {
      t.toolResults = outputs
      t.toolErrors = outputErrors
    }
    this.turns.push(t)
  }

  started(p: Record<string, unknown>, ts: number, model: string | undefined): void {
    this.sawTaskEvents = true
    // An earlier turn that never ended (Codex was closed mid-turn) isn't counted.
    this.cur = undefined
    const id = str(p.turn_id)
    if (id) this.open(`codex-turn:${id}`, ts, model, false)
  }

  ended(p: Record<string, unknown>, aborted: boolean): void {
    const c = this.cur
    if (!c || c.fallback) return
    const id = str(p.turn_id)
    if (id && c.id !== `codex-turn:${id}`) return
    const n = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
    const started = n(p.started_at)
    const completed = n(p.completed_at)
    // started_at / completed_at are in seconds.
    const dur =
      n(p.duration_ms) ??
      (started !== undefined && completed !== undefined && completed >= started
        ? (completed - started) * 1000
        : undefined)
    if (dur !== undefined) c.durationMs = dur
    const ttft = n(p.time_to_first_token_ms)
    if (ttft !== undefined) c.firstTokenMs = ttft
    if (aborted) c.aborted = true
    if (p.error) c.failed = true
    this.close()
  }

  prompt(ts: number, model: string | undefined): void {
    if (!this.sawTaskEvents) {
      // Older Codex: a prompt starts the next turn (once the current one has a response).
      if (!this.cur || this.cur.responses > 0 || this.cur.toolCalls > 0) {
        this.close()
        this.open(`codex-turn:${this.sessionId}:p${this.fallbackN++}`, ts, model, true)
      }
    }
    if (this.cur) this.cur.prompted = !this.subagent
  }

  /**
   * A turn_context: the model of the turn it belongs to (the first one in the
   * turn). Only for turns with turn events: in older rollouts the next
   * prompt's turn_context comes while the previous prompt-split turn is still
   * open, so those take their first response's model instead.
   */
  context(model: string | undefined): void {
    const c = this.cur
    if (!c || !model || c.ownModel || c.fallback) return
    c.model = model
    c.ownModel = true
  }

  response(rec: UsageRecord, contextPct: number | undefined): void {
    const c = this.cur
    if (!c) return
    if (c.fallback && c.responses === 0) {
      // A prompt-split turn: its first response's identity and model (see the class comment).
      c.id = `codex-turn:${rec.id}`
      if (rec.model !== 'unknown') c.model = rec.model
    }
    // Fast mode switched on after the turn's context: the turn is a fast one.
    if (c.model && rec.model === `${c.model}-fast`) c.model = rec.model
    c.responses++
    c.outputTokens += rec.output
    c.reasoningTokens += rec.reasoning ?? 0
    if (!c.model && rec.model !== 'unknown') c.model = rec.model
    if (contextPct !== undefined) c.contextPct = contextPct
  }

  toolCall(): void {
    if (this.cur) this.cur.toolCalls++
  }

  toolOutput(exit: number | undefined): void {
    if (!this.cur || exit === undefined) return
    this.cur.outputs++
    if (exit !== 0) this.cur.outputErrors++
  }

  toolItem(status: string | undefined): void {
    if (!this.cur || !status || status === 'inProgress' || status === 'in_progress') return
    this.cur.items++
    if (status === 'failed' || status === 'declined') this.cur.itemErrors++
  }

  /** The end of the file: an older rollout's last turn ends here. */
  finish(): CodexTurnSample[] {
    if (this.cur?.fallback) this.close()
    this.cur = undefined
    return this.turns
  }
}

/**
 * When each response was generated (for token speed, see shared/usage/speed.ts),
 * from the rollout's timestamps only:
 * - request sent: the last input before the response's first output item
 *   (the turn's start, a message, a tool's output, or the previous
 *   response's token_count, written after its tools ran);
 * - response end: its token_usage_record (newer Codex, written right after
 *   the response), else its last output item before a tool output. Never
 *   the token_count: Codex writes it after the response's tools have run,
 *   so tool time would count as generation time.
 */
export class ResponseTimer {
  private lastInput?: number
  private start?: number
  private end?: number
  private recordEnd?: number
  /** A tool output came after this response's items: its end is known. */
  private closed = false

  private clear(): void {
    this.start = this.end = this.recordEnd = undefined
    this.closed = false
  }

  /** A turn starts (at its time) or ends (no time). */
  turn(ts?: number): void {
    this.clear()
    this.lastInput = ts
  }

  /** Something the next request sends: a message, a tool's output. */
  input(ts: number): void {
    if (!Number.isFinite(ts)) return
    if (this.start !== undefined) this.closed = true
    this.lastInput = ts
  }

  /** One of the response's own items: reasoning, a message, a tool call. */
  output(ts: number): void {
    if (!Number.isFinite(ts)) return
    // An output after this response's tools ran is the next response (its token_count was missing).
    if (this.closed) this.clear()
    if (this.start === undefined) {
      if (this.lastInput === undefined) return
      this.start = this.lastInput
    }
    this.end = ts
  }

  /** Newer Codex: the response's usage record, right after it ended. */
  recorded(ts: number): void {
    if (Number.isFinite(ts) && this.start !== undefined && this.recordEnd === undefined)
      this.recordEnd = ts
  }

  /** A token_count with new usage: the response's generation time, if known. */
  finish(ts: number): number | undefined {
    const end = this.recordEnd ?? this.end
    const start = this.start
    this.clear()
    this.lastInput = ts
    return start !== undefined && end !== undefined && end >= start ? end - start : undefined
  }

  /** A token_count without new usage (e.g. only the limits changed). */
  idle(ts: number): void {
    if (this.start === undefined && Number.isFinite(ts)) this.lastInput = ts
  }
}

/**
 * A thread with inherited history (a fork, or a subagent started with its
 * parent's history) begins with a copy of those events, written in one burst
 * right after its own meta (often all with the same time). Their timing is
 * the copy's, not the responses': the burst ends at the first gap longer than
 * this, and nothing in it gets a generation time.
 */
const COPY_BURST_GAP_MS = 100

/** Inherited history: a fork, or a subagent that starts from its parent's history. */
function inheritsHistory(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false
  return (
    !!str(meta.forked_from_id) ||
    meta.inherits_history === true ||
    typeof meta.subagent_history_start_ordinal === 'number'
  )
}

/** When the copied burst after the own meta (line `at`) ends, or -Infinity. */
function copiedUntil(ls: Line[], at: number): number {
  const meta = ls[at]
  if (!meta || !inheritsHistory(meta.payload)) return -Infinity
  let prev = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN
  if (!Number.isFinite(prev)) return -Infinity
  for (let i = at + 1; i < ls.length; i++) {
    const t = ls[i].timestamp ? Date.parse(ls[i].timestamp!) : Number.NaN
    if (!Number.isFinite(t)) continue
    if (t - prev > COPY_BURST_GAP_MS) break
    prev = t
  }
  return prev
}

/** Token usage (one record per response) and limit readings of one rollout. */
export function analyzeCodexUsage(text: string, ctx: CodexUsageContext): UsageAnalysis {
  const records: UsageRecord[] = []
  const readings: CodexLimitReading[] = []
  const ls = lines(text)
  const sessionId = ctx.sessionId ?? ctx.key.split(':').pop() ?? ctx.key
  const root = ctx.lineageRoot ?? sessionId
  const source = ctx.source ?? ctx.key.split(':')[0]
  // Events before the first turn_context take the first model of the file.
  const firstModel = ls.find((l) => l.type === 'turn_context' && str(l.payload.model))?.payload
    .model as string | undefined
  let model = firstModel
  let prevTotal: Counts | undefined
  // How often each identity has come up in this file (see codexEventId).
  const occurrences = new Map<string, number>()
  // Codex repeats the same limits with every event: only changes are kept,
  // plus one reading every 10 minutes and the file's last one (so a gauge's
  // "updated" time is the last time Codex reported it, not the last change).
  const lastLimits = new Map<string, { same: string; ts: number }>()
  // Every plan_type seen (also in repeated readings), to tag each response with its account.
  const plans: { ts: number; plan: string }[] = []
  const pending = new Map<string, CodexLimitReading>()
  // The rollout's own meta (a fork's file also holds its parent's): is it a subagent's thread?
  const metas = ls.filter((l) => l.type === 'session_meta')
  const ownMeta = metas.find((l) => l.payload.id === sessionId) ?? metas[0]
  const turns = new TurnTracker(ctx, sessionId, ownMeta?.payload.subagent === true)
  const timer = new ResponseTimer()
  const copiesUntil = ownMeta ? copiedUntil(ls, ls.indexOf(ownMeta)) : -Infinity
  // Fast mode (Codex's /fast, the "priority" service tier): its responses are
  // counted under "<model>-fast" (priced and charted apart, like Claude Code's).
  let fast = false
  const as = (m: string | undefined): string | undefined =>
    m && fast && m !== 'unknown' && !m.endsWith('-fast') ? `${m}-fast` : m
  for (const l of ls) {
    if (l.type === 'turn_context') {
      model = str(l.payload.model) ?? model
      turns.context(as(str(l.payload.model)))
      continue
    }
    const p = l.payload
    const at = l.timestamp ? Date.parse(l.timestamp) : Number.NaN
    if (l.type === 'event_msg' && p.type === 'thread_settings_applied') {
      // A settings event without a tier says nothing about fast mode: not fast.
      fast = obj(p.thread_settings)?.service_tier === 'priority'
      continue
    }
    if (l.type === 'response_item') {
      if (p.type === 'message') {
        if (isPrompt(p) && Number.isFinite(at)) turns.prompt(at, as(model))
        if (p.role === 'user') timer.input(at)
        else if (p.role === 'assistant') timer.output(at)
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        turns.toolOutput(typeof p.exit === 'number' ? p.exit : undefined)
        timer.input(at)
      } else if (TOOL_CALL_TYPES.has(String(p.type))) {
        turns.toolCall()
        timer.output(at)
      } else if (p.type === 'reasoning') timer.output(at)
      continue
    }
    if (l.type === 'event_msg' && p.type === 'task_started') {
      if (Number.isFinite(at)) turns.started(p, at, as(model))
      timer.turn(Number.isFinite(at) ? at : undefined)
      continue
    }
    if (l.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      turns.ended(p, p.type === 'turn_aborted')
      timer.turn()
      continue
    }
    if (l.type === 'event_msg' && p.type === 'item_completed') {
      // Only tool calls (a plain rollout also has messages and reasoning as items).
      if (isToolItemType(obj(p.item)?.type)) turns.toolItem(str(obj(p.item)?.status))
      continue
    }
    if (l.type === 'token_usage_record') {
      timer.recorded(at)
      continue
    }
    if (l.type !== 'event_msg' || l.payload.type !== 'token_count') continue
    const ts = l.timestamp ? Date.parse(l.timestamp) : Number.NaN
    if (!Number.isFinite(ts)) continue
    const info = obj(l.payload.info)
    const total = counts(info?.total_token_usage)
    const last = counts(info?.last_token_usage)
    const repeat =
      !!total &&
      !!prevTotal &&
      total.total_tokens === prevTotal.total_tokens &&
      sig(total) === sig(prevTotal)
    let used: Counts | undefined
    if (total && !repeat) {
      if (last) used = last
      else if (prevTotal && total.total_tokens >= prevTotal.total_tokens)
        used = minus(total, prevTotal)
      else used = total
    } else if (!total && last && !repeat) used = last
    if (total) prevTotal = total
    const rl = l.payload.rate_limits
    const hasUsage = !!used && used.input_tokens + used.output_tokens > 0
    // Events without new usage are told apart by their limits.
    // Events without new usage are told apart by their limits.
    const base = [sig(total), sig(last), hasUsage ? '' : JSON.stringify(rl ?? null)].join('|')
    const n = occurrences.get(base) ?? 0
    occurrences.set(base, n + 1)
    const id = codexEventId(root, base, n)
    if (!used || !hasUsage) timer.idle(ts)
    if (used && hasUsage) {
      const cached = Math.min(used.cached_input_tokens, used.input_tokens)
      const cw = Math.min(used.cache_write_input_tokens, used.input_tokens - cached)
      const rec: UsageRecord = {
        id,
        ts,
        key: ctx.key,
        project: ctx.project,
        env: ctx.env,
        model: as(model) ?? 'unknown',
        provider: 'codex',
        input: used.input_tokens - cached - cw,
        output: used.output_tokens,
        cacheWrite: cw,
        cacheRead: cached,
        sid: sessionId
      }
      if (used.reasoning_output_tokens)
        rec.reasoning = Math.min(used.reasoning_output_tokens, used.output_tokens)
      if (ctx.version) rec.version = ctx.version
      const gen = timer.finish(ts)
      // A fork's copy of its parent's history has the copy's times, not the response's.
      if (gen !== undefined && ts > copiesUntil) rec.genMs = gen
      records.push(rec)
      // Context use after this response: what its next request sends, of the window.
      const window = num(info?.model_context_window)
      const inContext = last?.total_tokens ?? 0
      turns.response(
        rec,
        window && inContext ? Math.min(100, (inContext / window) * 100) : undefined
      )
    }
    const r = parseRateLimits(rl, ts, { id, key: ctx.key, source, sessionId })
    if (r?.planType && plans[plans.length - 1]?.plan !== r.planType)
      plans.push({ ts, plan: r.planType })
    if (r) {
      const same = JSON.stringify([r.windows, r.planType, r.limitName, r.credits, r.reached])
      const prev = lastLimits.get(r.limitId)
      if (!prev || prev.same !== same || r.ts - prev.ts >= READING_EVERY_MS) {
        lastLimits.set(r.limitId, { same, ts: r.ts })
        readings.push(r)
        pending.delete(r.limitId)
      } else pending.set(r.limitId, r)
    }
  }
  // Each response's account: the plan the limits reported at or before it (else the next one).
  if (plans.length)
    for (const rec of records) {
      let p = plans[0].plan
      for (const x of plans) if (x.ts <= rec.ts) p = x.plan
      rec.plan = p
    }
  for (const r of pending.values()) readings.push(r)
  if (plans.length)
    for (const r of readings) {
      if (r.planType) continue
      let p = plans[0].plan
      for (const x of plans) if (x.ts <= r.ts) p = x.plan
      r.planType = p
      r.planInferred = true
    }
  readings.sort((a, b) => a.ts - b.ts)
  return {
    records,
    turns: [],
    limitHits: [],
    usageReadings: [],
    codexLimits: readings,
    codexTurns: turns.finish()
  }
}
