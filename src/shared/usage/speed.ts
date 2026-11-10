// Token speed (output tokens per second) and time to first token, from the
// timing each usage record carries (see timing.ts for Claude Code and
// providers/codex/usage.ts for Codex). An estimate from log timestamps: it
// includes waiting and thinking time, and network and server load affect it.
//
// Per response: speed = output tokens ÷ generation time (request sent →
// last part of the response written; tool time is never in it). Responses
// that say little about speed are left out (they still count everywhere
// else): very short replies, generation times that are too short (a clock
// jump, a copy) or too long (a stalled request), and impossible speeds.
// Medians, never averages: one stuck response can't move them.

import { isFastModel, modelLabel } from './pricing'
import { bucketRange, weekKey } from './time'
import type { TrendMarker, TrendsReport } from './trends'
import type { CodexTurnSample, UsageRecord, WeekStart } from './types'

/** Replies shorter than this say more about latency than speed. */
export const SPEED_MIN_OUTPUT = 50
/** Shorter generation times are clock jumps or copied events. */
export const SPEED_MIN_MS = 250
/** Longer ones are stalls, retries or a sleeping laptop, not generation. */
export const SPEED_MAX_MS = 10 * 60_000
/** Faster than this isn't a real response. */
export const SPEED_MAX_TPS = 1500
/** A median needs at least this many responses. */
export const SPEED_MIN_SAMPLES = 5

/** Claude Code's thinking tokens (part of output), as flattened into `extra`. */
export const THINKING_FIELD = 'output_tokens_details.thinking_tokens'

const isCodex = (r: Pick<UsageRecord, 'provider'>): boolean => r.provider === 'codex'

/** Thinking (Claude) or reasoning (Codex) tokens of a response, a part of its output. */
export function thinkingTokens(r: UsageRecord): number {
  const v = isCodex(r) ? r.reasoning : r.extra?.[THINKING_FIELD]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, r.output) : 0
}

/** A response's output speed in tokens per second, or undefined when it says nothing. */
export function outputSpeed(r: UsageRecord): number | undefined {
  const ms = r.genMs
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  if (r.output < SPEED_MIN_OUTPUT || ms < SPEED_MIN_MS || ms > SPEED_MAX_MS) return undefined
  const tps = r.output / (ms / 1000)
  return tps > SPEED_MAX_TPS ? undefined : tps
}

/** Speed without thinking / reasoning tokens (same time, same responses as outputSpeed). */
export function visibleSpeed(r: UsageRecord): number | undefined {
  if (outputSpeed(r) === undefined) return undefined
  return (r.output - thinkingTokens(r)) / (r.genMs! / 1000)
}

/** Claude Code's estimated time to first token of a response, in ms. */
export function firstTokenMs(r: UsageRecord): number | undefined {
  const v = r.ttftMs
  return v !== undefined && Number.isFinite(v) && v >= 0 && v <= SPEED_MAX_MS ? v : undefined
}

/** A Codex turn's own time to first token, in ms. */
export function codexFirstTokenMs(t: CodexTurnSample): number | undefined {
  const v = t.firstTokenMs
  return v !== undefined && Number.isFinite(v) && v >= 0 && v <= SPEED_MAX_MS ? v : undefined
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** The median when there are enough samples. */
export function speedMedian(xs: number[], min = SPEED_MIN_SAMPLES): number | undefined {
  return xs.length >= min ? median(xs) : undefined
}

/** A fast-mode response (Claude Code's `usage.speed: "fast"`, Codex's priority tier). */
export const isFast = (r: Pick<UsageRecord, 'model'>): boolean => isFastModel(r.model)

/** Median output speed of some records (only those `keep` accepts, when given). */
export function medianSpeed(
  records: Iterable<UsageRecord>,
  keep?: (r: UsageRecord) => boolean
): { tps?: number; samples: number } {
  const xs: number[] = []
  for (const r of records) {
    if (keep && !keep(r)) continue
    const v = outputSpeed(r)
    if (v !== undefined) xs.push(v)
  }
  const tps = speedMedian(xs)
  return { ...(tps !== undefined ? { tps } : {}), samples: xs.length }
}

/** Normal-mode records only: fast mode never moves the normal baseline. */
export const notFast = (r: UsageRecord): boolean => !isFast(r)

export interface SpeedStats {
  /** Median output speed in normal mode, tokens per second. */
  tps?: number
  /** Normal-mode responses the speed comes from. */
  samples: number
  /** Median time to first token in normal mode, ms. */
  ttftMs?: number
  /** Responses (Claude Code) or turns (Codex) the time to first token comes from. */
  ttftSamples: number
  /** Claude Code: the time to first token is estimated (from responses that start with thinking). */
  ttftEstimated?: true
  /** Claude Code: the share of normal-mode responses with an estimate (0–1). */
  ttftCoverage?: number
  /** Some responses ran in fast mode. */
  fast?: true
  /** Their median speed, and how many. */
  fastTps?: number
  fastSamples?: number
}

/**
 * Speed and time to first token of one set of records, fast mode apart.
 * Codex's time to first token is its own per-turn value (pass its turns);
 * Claude Code's is the estimate its records carry.
 */
export function speedStats(records: UsageRecord[], codexTurns?: CodexTurnSample[]): SpeedStats {
  const { tps, samples } = medianSpeed(records, notFast)
  const out: SpeedStats = { ...(tps !== undefined ? { tps } : {}), samples, ttftSamples: 0 }
  if (records.some(isFast)) {
    const f = medianSpeed(records, isFast)
    out.fast = true
    out.fastSamples = f.samples
    if (f.tps !== undefined) out.fastTps = f.tps
  }
  if (codexTurns) {
    const xs = codexTurns
      .filter((t) => !t.model || !isFastModel(t.model))
      .map(codexFirstTokenMs)
      .filter((v): v is number => v !== undefined)
    const m = speedMedian(xs)
    if (m !== undefined) out.ttftMs = m
    out.ttftSamples = xs.length
    return out
  }
  const xs: number[] = []
  let responses = 0
  for (const r of records) {
    // The app's own runs (summaries) have no timing of their own.
    if (isCodex(r) || r.startTs !== undefined || isFast(r)) continue
    responses++
    const v = firstTokenMs(r)
    if (v !== undefined) xs.push(v)
  }
  const m = speedMedian(xs)
  if (m !== undefined) out.ttftMs = m
  out.ttftSamples = xs.length
  if (responses) {
    out.ttftEstimated = true
    out.ttftCoverage = xs.length / responses
  }
  return out
}

/** Claude Code's share of (normal-mode) responses with a time-to-first-token estimate. */
export function ttftCoverage(records: Iterable<UsageRecord>): number | undefined {
  let n = 0
  let with_ = 0
  for (const r of records) {
    if (isCodex(r) || r.startTs !== undefined || isFast(r)) continue
    n++
    if (firstTokenMs(r) !== undefined) with_++
  }
  return n ? with_ / n : undefined
}

// ------------------------------------------------- combined weekly chart

export type SpeedTrendsReport = TrendsReport<'outputSpeed'>

/** A model gets a "new model" marker only with at least this share of the samples. */
const MARKER_MIN_SHARE = 0.02

/**
 * Weekly median output speed per model, Claude Code's and Codex's together
 * (their model ids never overlap), for comparing speeds across providers.
 * Only the busiest models (by responses with a speed) get a line.
 */
export function buildSpeedTrends(input: {
  records: UsageRecord[]
  timeZone: string
  weekStart: WeekStart
  maxGroups?: number
}): SpeedTrendsReport {
  const { timeZone: tz, weekStart } = input
  const byModel = new Map<string, Map<string, number[]>>()
  const providerOf = new Map<string, 'claude' | 'codex'>()
  const weekSet = new Set<string>()
  const firstWeek = new Map<string, string>()
  let all = 0
  for (const r of input.records) {
    const v = outputSpeed(r)
    if (v === undefined) continue
    const w = weekKey(r.ts, tz, weekStart)
    let g = byModel.get(r.model)
    if (!g) byModel.set(r.model, (g = new Map()))
    let xs = g.get(w)
    if (!xs) g.set(w, (xs = []))
    xs.push(v)
    weekSet.add(w)
    all++
    providerOf.set(r.model, isCodex(r) ? 'codex' : 'claude')
    const f = firstWeek.get(r.model)
    if (!f || w < f) firstWeek.set(r.model, w)
  }
  const volume = (m: string): number =>
    [...(byModel.get(m)?.values() ?? [])].reduce((a, xs) => a + xs.length, 0)
  const weeks = [...weekSet]
    .sort()
    .map((week) => ({ week, start: bucketRange(week, 'week', tz).start }))
  const lineOf = (key: string): SpeedTrendsReport['series'][number] => ({
    metric: 'outputSpeed',
    group: key,
    label: modelLabel(key),
    points: weeks.map((w) => {
      const xs = byModel.get(key)?.get(w.week)
      return { ...w, value: xs ? speedMedian(xs) : undefined }
    })
  })
  // Only models with a week of enough responses get a line (and a legend entry).
  const lines = new Map(
    [...byModel.keys()]
      .map((key) => [key, lineOf(key)] as const)
      .filter(([, l]) => l.points.some((p) => p.value !== undefined))
  )
  const groups = [...lines.keys()]
    .map((key) => ({
      key,
      label: modelLabel(key),
      volume: volume(key),
      provider: providerOf.get(key)!
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, input.maxGroups ?? 8)
  const series = groups.map((g) => lines.get(g.key)!)
  const markers: TrendMarker[] = []
  const first = weeks[0]?.week
  for (const g of groups) {
    const w = firstWeek.get(g.key)!
    // Fast mode isn't a new model.
    if (w === first || isFastModel(g.key) || g.volume < all * MARKER_MIN_SHARE) continue
    markers.push({
      week: w,
      start: bucketRange(w, 'week', tz).start,
      kind: 'model',
      label: g.label
    })
  }
  markers.sort((a, b) => a.start - b.start)
  return {
    groupBy: 'model',
    weeks,
    groups,
    series,
    markers,
    versions: [],
    models: [...byModel.keys()].sort()
  }
}

// ------------------------------------------------ limit health: a signal

export interface SpeedSignalRow {
  model: string
  label: string
  /** Median speed in the recent days, and before them. */
  recent?: number
  recentSamples: number
  before?: number
  beforeSamples: number
  /** (recent − before) ÷ before, in %. */
  changePct?: number
}

export interface SpeedSignal {
  recentDays: number
  beforeDays: number
  rows: SpeedSignalRow[]
}

const DAY = 86_400_000

/**
 * Output speed in the last few days against the weeks before, for the
 * busiest models: an extra signal next to limit health (never part of its
 * score). Only models with enough recent responses get a row.
 */
export function speedSignal(
  records: UsageRecord[],
  now: number,
  opts: { recentDays?: number; beforeDays?: number; maxModels?: number } = {}
): SpeedSignal {
  const recentDays = opts.recentDays ?? 7
  const beforeDays = opts.beforeDays ?? 28
  const split = now - recentDays * DAY
  const from = split - beforeDays * DAY
  const recent = new Map<string, number[]>()
  const before = new Map<string, number[]>()
  for (const r of records) {
    if (r.ts < from || r.ts > now) continue
    const v = outputSpeed(r)
    if (v === undefined) continue
    const m = r.ts >= split ? recent : before
    let xs = m.get(r.model)
    if (!xs) m.set(r.model, (xs = []))
    xs.push(v)
  }
  const rows = [...recent.entries()]
    .filter(([, xs]) => xs.length >= SPEED_MIN_SAMPLES)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, opts.maxModels ?? 3)
    .map(([model, xs]): SpeedSignalRow => {
      const prev = before.get(model) ?? []
      const a = speedMedian(prev)
      const b = speedMedian(xs)
      return {
        model,
        label: modelLabel(model),
        ...(b !== undefined ? { recent: b } : {}),
        recentSamples: xs.length,
        ...(a !== undefined ? { before: a } : {}),
        beforeSamples: prev.length,
        ...(a !== undefined && b !== undefined && a > 0 ? { changePct: ((b - a) / a) * 100 } : {})
      }
    })
  return { recentDays, beforeDays, rows }
}

// ------------------------------------------------------------- wording

/** The caveat shown with every speed figure (ⓘ). */
export const SPEED_CAVEAT =
  'An estimate from log timestamps: from when the request was sent to when the last part of the reply was written, with tool time left out. It includes waiting and thinking time, and network and server load affect it. Replies under 50 tokens and outliers are left out; fast mode is counted apart.'

/** Claude Code's time to first token is an estimate (ⓘ). */
export const CLAUDE_TTFT_CAVEAT =
  'Estimated for replies that start with thinking: from when the request was sent to when the thinking began (the thinking line’s time minus how long it thought). Other replies have no estimate. Network and server load affect it.'

/** "est. from 54% of responses" (coverage 0–1). */
export function ttftCoverageText(coverage: number | undefined): string | undefined {
  if (coverage === undefined || !Number.isFinite(coverage)) return undefined
  const pct = coverage > 0 && coverage < 0.01 ? '<1' : String(Math.round(coverage * 100))
  return `est. from ${pct}% of responses`
}
