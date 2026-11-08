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
import type { UsageAnalysis, UsageRecord } from '@shared/usage/types'

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
  for (const l of ls) {
    if (l.type === 'turn_context') {
      model = str(l.payload.model) ?? model
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
    if (used && hasUsage) {
      const cached = Math.min(used.cached_input_tokens, used.input_tokens)
      const cw = Math.min(used.cache_write_input_tokens, used.input_tokens - cached)
      const rec: UsageRecord = {
        id,
        ts,
        key: ctx.key,
        project: ctx.project,
        env: ctx.env,
        model: model ?? 'unknown',
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
      records.push(rec)
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
  return { records, turns: [], limitHits: [], usageReadings: [], codexLimits: readings }
}
