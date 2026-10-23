// Limit health: is each 1% of the plan buying less work than it used to?
//
// The method follows claude-nerf-watcher (MIT, see THIRD_PARTY_NOTICES):
// every 5-hour (and 7-day) window gets one score, "API-equivalent $ per 1%":
// the tokens used since the window started, priced at API rates, divided by
// the percentage the window reached. A baseline is the median score of
// windows on dates the user trusts, stored per 1x of plan, and a possible cut
// is flagged only after N windows in a row score below baseline ÷ threshold.
//
// Unlike nerf-watcher, the percentages come only from the status line bridge
// (and /usage output Claude Code recorded in old transcripts), never from an
// OAuth token or an undocumented endpoint.

import { costParts, type CostParts, type ModelPrice } from './pricing'
import type { TokenCounts, UsageRecord } from './types'
import { FIVE_HOURS, SEVEN_DAYS, type Plan, type WindowKind } from './limits'
import type { BridgeReading } from './bridge'

// ---------------------------------------------------------------- settings

export type PlanName = Plan | 'custom'

/** Limit size relative to Pro. */
export const PLAN_MULT: Record<Plan, number> = { pro: 1, max5: 5, max20: 20, team: 1, api: 1 }

export interface PlanChange {
  /** First day on this plan, local date `YYYY-MM-DD`. */
  from: string
  plan: PlanName
  mult: number
  /** Name for a custom plan. */
  label?: string
}

/** A time range marked by hand as "used Claude elsewhere" (claude.ai, mobile, cloud…). */
export interface ElsewhereRange {
  id: string
  from: number
  to: number
  note?: string
}

export interface HealthSettings {
  /** Trusted "normal" dates, local `YYYY-MM-DD`, both inclusive. */
  baselineFrom?: string
  baselineTo?: string
  /** Flag when a window's $ per 1% is below baseline ÷ threshold. */
  threshold: number
  /** …for this many windows in a row. */
  streak: number
  /** Windows under this % are too coarse to score. */
  minPct: number
  /** Leave out windows where at least this share (%) of the usage clearly came from elsewhere. */
  untrackedLimit: number
  excludeUntracked: boolean
  /**
   * Price every model of a family (Opus, Sonnet, Haiku…) at the newest
   * family member's rates, so a cheaper new model doesn't read as a cut.
   */
  familyPricing: boolean
}

export const DEFAULT_HEALTH: HealthSettings = {
  threshold: 1.5,
  streak: 2,
  minPct: 10,
  untrackedLimit: 25,
  excludeUntracked: true,
  familyPricing: true
}

/** Fewest baseline windows before a verdict is given. */
export const MIN_BASELINE = 3

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

export function sanitizeHealth(v: unknown): HealthSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown, d: number, lo: number, hi: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : d
  const ymd = (x: unknown): string | undefined =>
    typeof x === 'string' && YMD_RE.test(x) ? x : undefined
  let from = ymd(o.baselineFrom)
  let to = ymd(o.baselineTo)
  if (from && to && from > to) [from, to] = [to, from]
  return {
    baselineFrom: from,
    baselineTo: from ? (to ?? from) : undefined,
    threshold: num(o.threshold, DEFAULT_HEALTH.threshold, 1.01, 10),
    streak: Math.round(num(o.streak, DEFAULT_HEALTH.streak, 1, 20)),
    minPct: num(o.minPct, DEFAULT_HEALTH.minPct, 1, 90),
    untrackedLimit: num(o.untrackedLimit, DEFAULT_HEALTH.untrackedLimit, 1, 100),
    excludeUntracked: typeof o.excludeUntracked === 'boolean' ? o.excludeUntracked : true,
    familyPricing: typeof o.familyPricing === 'boolean' ? o.familyPricing : true
  }
}

export function sanitizePlanHistory(v: unknown): PlanChange[] {
  if (!Array.isArray(v)) return []
  const out = new Map<string, PlanChange>()
  for (const x of v.slice(0, 100)) {
    const o = (x ?? {}) as Record<string, unknown>
    if (typeof o.from !== 'string' || !YMD_RE.test(o.from)) continue
    const plan = (['pro', 'max5', 'max20', 'team', 'api', 'custom'] as PlanName[]).find(
      (p) => p === o.plan
    )
    if (!plan) continue
    const mult =
      plan === 'custom'
        ? typeof o.mult === 'number' && Number.isFinite(o.mult) && o.mult > 0
          ? Math.min(o.mult, 1000)
          : undefined
        : typeof o.mult === 'number' && Number.isFinite(o.mult) && o.mult > 0
          ? Math.min(o.mult, 1000)
          : PLAN_MULT[plan]
    if (mult === undefined) continue
    const label =
      typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 40) : undefined
    // One change per day: the last one wins.
    out.set(o.from, { from: o.from, plan, mult, ...(label ? { label } : {}) })
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from))
}

export function sanitizeElsewhere(v: unknown): ElsewhereRange[] {
  if (!Array.isArray(v)) return []
  const out: ElsewhereRange[] = []
  for (const x of v.slice(0, 500)) {
    const o = (x ?? {}) as Record<string, unknown>
    const from = typeof o.from === 'number' && Number.isFinite(o.from) ? o.from : undefined
    const to = typeof o.to === 'number' && Number.isFinite(o.to) ? o.to : undefined
    if (from === undefined || to === undefined || to <= from) continue
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id.slice(0, 40) : `e-${from}`,
      from,
      to,
      ...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim().slice(0, 120) } : {})
    })
  }
  return out.sort((a, b) => a.from - b.from)
}

export function planLabel(p: Pick<PlanChange, 'plan' | 'mult' | 'label'>): string {
  const names: Record<PlanName, string> = {
    pro: 'Pro',
    max5: 'Max 5x',
    max20: 'Max 20x',
    team: 'Team',
    api: 'API',
    custom: 'Custom'
  }
  const name = p.plan === 'custom' ? (p.label ?? 'Custom') : names[p.plan]
  return p.plan === 'custom' || p.mult !== PLAN_MULT[p.plan as Plan] ? `${name} (${p.mult}x)` : name
}

/** Local `YYYY-MM-DD` of a moment. */
export function toYmd(d: Date | number): string {
  const x = new Date(d)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

/** Local midnight of a `YYYY-MM-DD` date. */
export function ymdStart(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

export interface PlanSpan extends PlanChange {
  /** Epoch ms the plan starts (local midnight). */
  start: number
}

/**
 * Plan in effect over time. Before the first recorded change, the first one
 * applies; with no history the current plan setting applies everywhere.
 */
export function planSpans(history: PlanChange[], current: Plan): PlanSpan[] {
  if (!history.length)
    return [{ from: '1970-01-01', plan: current, mult: PLAN_MULT[current], start: 0 }]
  return [...history]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((p) => ({ ...p, start: ymdStart(p.from) }))
}

export function planAt(spans: PlanSpan[], ts: number): PlanSpan {
  let cur = spans[0]
  for (const p of spans) if (p.start <= ts) cur = p
  return cur
}

// ---------------------------------------------------------- family prices

const FAMILY_RE = /(opus|sonnet|haiku|fable|mythos)/i

export function familyOf(model: string): string | undefined {
  return FAMILY_RE.exec(model)?.[1].toLowerCase()
}

/** Version numbers in a model id, e.g. claude-opus-5-5 → [5, 5], claude-3-5-sonnet → [3, 5]. */
function versionOf(model: string): number[] {
  return (model.replace(/-\d{8}$/, '').match(/\d+/g) ?? []).map(Number).filter((n) => n < 100)
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Maps a model id to the model whose prices score it (the newest of its family). */
export function familyPricer(table: ModelPrice[]): (model: string) => string {
  const ref = new Map<string, { model: string; v: number[] }>()
  for (const row of table) {
    const f = familyOf(row.model)
    if (!f || row.model.endsWith('-preview')) continue
    const v = versionOf(row.model)
    const cur = ref.get(f)
    if (!cur || newer(v, cur.v)) ref.set(f, { model: row.model, v })
  }
  return (model) => {
    const fast = model.endsWith('-fast')
    const f = familyOf(model)
    const r = f ? ref.get(f) : undefined
    return r ? `${r.model}${fast ? '-fast' : ''}` : model
  }
}

// ---------------------------------------------------------------- readings

export interface WindowReading {
  ts: number
  pct: number
  resetsAt: number
  /** "bridge" = status line payload; "usage-command" = /usage output in a transcript. */
  from: 'bridge' | 'usage-command'
}

export const windowLength = (k: WindowKind): number => (k === 'five_hour' ? FIVE_HOURS : SEVEN_DAYS)

/** The bridge's readings for one window kind. */
export function bridgeWindowReadings(readings: BridgeReading[], kind: WindowKind): WindowReading[] {
  const out: WindowReading[] = []
  for (const r of readings) {
    const w = kind === 'five_hour' ? r.fiveHour : r.sevenDay
    if (w?.resetsAt && w.pct >= 0 && w.pct <= 1000)
      out.push({ ts: r.ts, pct: w.pct, resetsAt: w.resetsAt, from: 'bridge' })
  }
  return out
}

// ----------------------------------------------------------------- scoring

export interface WindowScore {
  kind: WindowKind
  /** Window start and reset (end), epoch ms. */
  start: number
  resetsAt: number
  /** Time of the reading used (the highest %). */
  at: number
  closed: boolean
  pct: number
  /** API-equivalent dollars of local usage from the window start to `at`. */
  dollars: number
  /** dollars ÷ pct: "$ per 1%". 0 when nothing ran locally. */
  perPct: number
  tokens: TokenCounts
  /** Dollars by token type, to show the token mix. */
  mix: CostParts
  /** Responses per model. */
  models: Record<string, number>
  plan: string
  mult: number
  from: WindowReading['from']
  readings: number
  /** Expected $ per 1% for this window's plan (baseline × multiplier). */
  expected?: number
  /** perPct ÷ expected. */
  ratio?: number
  /** Below baseline ÷ threshold. */
  low?: boolean
  /** Percentage points that rose while nothing ran locally (clear evidence of use elsewhere). */
  untrackedClear: number
  /** Clear + the part of the rise that local tokens can't explain at the baseline rate. */
  untrackedPct: number
  /** True when `untrackedPct` used the baseline (otherwise it's the clear part only). */
  untrackedEstimated: boolean
  /** Overlaps a range marked by hand as "used Claude elsewhere". */
  elsewhere: boolean
  /** Left out of the baseline and the verdict, and why. */
  excluded?: 'elsewhere' | 'untracked'
  /** Shown with a warning: a large share of the % may come from usage not in the logs. */
  warning?: string
}

export interface ScoreOptions {
  kind: WindowKind
  prices: ModelPrice[]
  now: number
  settings: HealthSettings
  planHistory: PlanChange[]
  currentPlan: Plan
  elsewhere?: ElsewhereRange[]
  isSubscription?: (key: string) => boolean
  /** Use this baseline instead of computing one from `windows` (e.g. for the open window alone). */
  baseline?: Baseline | null
}

const RESET_TOLERANCE = 60 * 60_000
/** A rise this small with no local tokens can be lag or rounding. */
const NOISE_PCT = 1.5

interface Group {
  resetsAt: number
  items: WindowReading[]
}

/** Readings of the same window share a reset time (within an hour: /usage rounds it). */
function groupByWindow(readings: WindowReading[], kind: WindowKind): Group[] {
  const len = windowLength(kind)
  const sorted = readings
    .filter((r) => r.ts >= r.resetsAt - len - 60_000 && r.ts <= r.resetsAt + 60_000)
    .sort((a, b) => a.resetsAt - b.resetsAt)
  const groups: Group[] = []
  for (const r of sorted) {
    const g = groups[groups.length - 1]
    if (g && r.resetsAt - g.resetsAt <= RESET_TOLERANCE) g.items.push(r)
    else groups.push({ resetsAt: r.resetsAt, items: [r] })
  }
  for (const g of groups) {
    // The bridge's exact reset wins over /usage's rounded one.
    const bridge = g.items.filter((r) => r.from === 'bridge').map((r) => r.resetsAt)
    g.resetsAt = bridge.length
      ? Math.max(...bridge)
      : 10 * 60_000 * Math.round(median(g.items.map((r) => r.resetsAt)) / (10 * 60_000))
    g.items.sort((a, b) => a.ts - b.ts)
  }
  return groups
}

function emptyParts(): CostParts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Index of the first record with ts ≥ t (records sorted by ts). */
function lowerBound(records: UsageRecord[], t: number): number {
  let lo = 0
  let hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (records[mid].ts < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface Tally {
  dollars: number
  mix: CostParts
  tokens: TokenCounts
  models: Record<string, number>
}

function tally(
  records: UsageRecord[],
  from: number,
  to: number,
  prices: ModelPrice[],
  isSub: (key: string) => boolean,
  inclusiveFrom = true,
  priceAs: (model: string) => string = (m) => m
): Tally {
  const t: Tally = {
    dollars: 0,
    mix: emptyParts(),
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    models: {}
  }
  for (let i = lowerBound(records, from); i < records.length; i++) {
    const r = records[i]
    if (r.ts > to) break
    if ((!inclusiveFrom && r.ts === from) || !isSub(r.key)) continue
    const p = costParts({ ...r, model: priceAs(r.model) }, prices)
    t.mix.input += p.input
    t.mix.output += p.output
    t.mix.cacheRead += p.cacheRead
    t.mix.cacheWrite += p.cacheWrite
    t.dollars += p.input + p.output + p.cacheRead + p.cacheWrite
    t.tokens.input += r.input
    t.tokens.output += r.output
    t.tokens.cacheWrite += r.cacheWrite
    t.tokens.cacheRead += r.cacheRead
    t.models[r.model] = (t.models[r.model] ?? 0) + 1
  }
  return t
}

export interface Baseline {
  kind: WindowKind
  /** Median $ per 1% per 1x of plan. */
  value: number
  n: number
  from: string
  to: string
  /** Share of dollars by token type across the baseline windows. */
  mixShare: CostParts
}

/**
 * Score every window that reached `minPct`. `records` must be sorted by time
 * and counted once (the usage service dedupes them, subagents included).
 */
export function scoreWindows(
  readings: WindowReading[],
  records: UsageRecord[],
  opts: ScoreOptions
): { windows: WindowScore[]; skippedLow: number; baseline?: Baseline } {
  const { kind, prices, now, settings } = opts
  const isSub = opts.isSubscription ?? (() => true)
  const len = windowLength(kind)
  const spans = planSpans(opts.planHistory, opts.currentPlan)
  const elsewhere = opts.elsewhere ?? []
  const priceAs = settings.familyPricing ? familyPricer(prices) : (m: string) => m
  const windows: WindowScore[] = []
  let skippedLow = 0
  const intervals = new Map<
    WindowScore,
    { t0: number; t1: number; dp: number; dollars: number }[]
  >()

  for (const g of groupByWindow(readings, kind)) {
    const start = g.resetsAt - len
    const inWindow = g.items.filter((r) => r.ts >= start && r.ts <= g.resetsAt + 60_000)
    if (!inWindow.length) continue
    // The highest reading (the latest, barring rounding) has the least rounding noise.
    let top = inWindow[0]
    for (const r of inWindow) if (r.pct >= top.pct) top = r
    if (top.pct < settings.minPct) {
      skippedLow++
      continue
    }
    const t = tally(records, start, top.ts, prices, isSub, true, priceAs)
    const plan = planAt(spans, g.resetsAt)
    const w: WindowScore = {
      kind,
      start,
      resetsAt: g.resetsAt,
      at: top.ts,
      closed: g.resetsAt <= now,
      pct: top.pct,
      dollars: t.dollars,
      perPct: t.dollars / top.pct,
      tokens: t.tokens,
      mix: t.mix,
      models: t.models,
      plan: planLabel(plan),
      mult: plan.mult,
      from: inWindow.some((r) => r.from === 'bridge') ? 'bridge' : 'usage-command',
      readings: inWindow.length,
      untrackedClear: 0,
      untrackedPct: 0,
      untrackedEstimated: false,
      elsewhere: elsewhere.some((e) => e.from < top.ts && e.to > start)
    }
    // Rises between readings: from 0% at the window start, reading by reading.
    const steps: { t0: number; t1: number; dp: number; dollars: number }[] = []
    let prevT = start
    let prevP = 0
    for (const r of inWindow) {
      if (r.ts > top.ts) break
      const d = tally(records, prevT, r.ts, prices, isSub, prevT === start, priceAs).dollars
      steps.push({ t0: prevT, t1: r.ts, dp: Math.max(0, r.pct - prevP), dollars: d })
      prevT = r.ts
      prevP = Math.max(prevP, r.pct)
    }
    w.untrackedClear = steps
      .filter((s) => s.dollars <= 0 && s.dp >= NOISE_PCT)
      .reduce((a, s) => a + s.dp, 0)
    intervals.set(w, steps)
    windows.push(w)
  }

  const markExcluded = (w: WindowScore): void => {
    if (w.elsewhere) w.excluded = 'elsewhere'
    else if (
      settings.excludeUntracked &&
      (w.untrackedClear / w.pct) * 100 >= settings.untrackedLimit
    )
      w.excluded = 'untracked'
    else w.excluded = undefined
  }
  windows.forEach(markExcluded)

  const baseline =
    opts.baseline !== undefined
      ? (opts.baseline ?? undefined)
      : computeBaseline(windows, settings, kind)
  for (const w of windows) {
    if (baseline) {
      w.expected = baseline.value * w.mult
      w.ratio = w.perPct / w.expected
      w.low = w.ratio < 1 / settings.threshold
      // Estimate: whatever local tokens can't explain at the baseline rate.
      let est = 0
      for (const s of intervals.get(w) ?? []) {
        if (s.dollars <= 0) est += s.dp >= NOISE_PCT ? s.dp : 0
        else est += Math.max(0, s.dp - s.dollars / w.expected)
      }
      w.untrackedPct = Math.min(w.pct, est)
      w.untrackedEstimated = true
    } else {
      w.untrackedPct = w.untrackedClear
    }
    const share = (w.untrackedPct / w.pct) * 100
    if (!w.excluded && share >= settings.untrackedLimit && w.untrackedPct > w.untrackedClear) {
      w.warning = `About ${Math.round(share)}% of this window's usage isn't in the local logs, or each 1% bought less. Used Claude elsewhere? Mark the time range so it's left out.`
    } else if (w.excluded === 'untracked') {
      w.warning = `${Math.round((w.untrackedClear / w.pct) * 100)}% of this window's usage happened while nothing ran on this computer (claude.ai, mobile, cloud…). Left out.`
    } else if (w.excluded === 'elsewhere') {
      w.warning = 'You marked this time as "used Claude elsewhere". Left out.'
    }
  }
  return { windows, skippedLow, baseline }
}

export function computeBaseline(
  windows: WindowScore[],
  s: Pick<HealthSettings, 'baselineFrom' | 'baselineTo'>,
  kind: WindowKind
): Baseline | undefined {
  if (!s.baselineFrom) return undefined
  const lo = ymdStart(s.baselineFrom)
  const hi = ymdStart(s.baselineTo ?? s.baselineFrom) + 86_400_000
  const picked = windows.filter(
    (w) => w.closed && !w.excluded && w.dollars > 0 && w.resetsAt >= lo && w.resetsAt < hi
  )
  if (!picked.length) return undefined
  const total = picked.reduce((a, w) => a + w.dollars, 0) || 1
  const share = (k: keyof CostParts): number => picked.reduce((a, w) => a + w.mix[k], 0) / total
  return {
    kind,
    value: median(picked.map((w) => w.perPct / w.mult)),
    n: picked.length,
    from: s.baselineFrom,
    to: s.baselineTo ?? s.baselineFrom,
    mixShare: {
      input: share('input'),
      output: share('output'),
      cacheRead: share('cacheRead'),
      cacheWrite: share('cacheWrite')
    }
  }
}

// ----------------------------------------------------------------- verdict

export type VerdictStatus = 'normal' | 'possible-reduction' | 'not-enough-data' | 'needs-baseline'

export interface Verdict {
  status: VerdictStatus
  /** More windows needed before a verdict. */
  needed?: number
  /** Trailing closed windows below the flag line. */
  lowStreak: number
  /** The flagged windows (possible-reduction) — their average ratio to baseline. */
  avgRatio?: number
  flagged?: number[]
  headline: string
  detail: string
}

export function verdictOf(
  windows: WindowScore[],
  baseline: Baseline | undefined,
  s: HealthSettings
): Verdict {
  const eligible = windows.filter((w) => w.closed && !w.excluded && w.dollars > 0)
  let lowStreak = 0
  for (let i = eligible.length - 1; i >= 0 && eligible[i].low; i--) lowStreak++
  if (!s.baselineFrom) {
    return {
      status: 'needs-baseline',
      lowStreak,
      headline: 'Pick your normal dates',
      detail:
        'Choose a few days when your limits felt normal. Each window is compared with the median of those days.'
    }
  }
  const n = baseline?.n ?? 0
  if (n < MIN_BASELINE || eligible.length < s.streak) {
    const needed = Math.max(MIN_BASELINE - n, 0) + Math.max(s.streak - eligible.length, 0)
    return {
      status: 'not-enough-data',
      needed: Math.max(needed, 1),
      lowStreak,
      headline: `Not enough data yet, ${Math.max(needed, 1)} window${needed === 1 ? '' : 's'} needed`,
      detail:
        n < MIN_BASELINE
          ? `Your normal dates have ${n} scored window${n === 1 ? '' : 's'}; at least ${MIN_BASELINE} are needed. Widen the dates, or keep live limits on.`
          : `A verdict needs ${s.streak} finished window${s.streak === 1 ? '' : 's'} that reached ${s.minPct}% or more.`
    }
  }
  const recent = eligible.slice(-s.streak)
  if (recent.every((w) => w.low)) {
    const avg = recent.reduce((a, w) => a + (w.ratio ?? 0), 0) / recent.length
    return {
      status: 'possible-reduction',
      lowStreak,
      avgRatio: avg,
      flagged: recent.map((w) => w.resetsAt),
      headline: 'Possible reduction',
      detail: `Your last ${recent.length} windows bought about ${Math.round(avg * 100)}% of your normal work per 1% of the limit (flag line: ${Math.round(100 / s.threshold)}%).`
    }
  }
  return {
    status: 'normal',
    lowStreak,
    headline: 'Normal',
    detail:
      lowStreak > 0
        ? `${lowStreak} recent window${lowStreak === 1 ? '' : 's'} scored low, but not ${s.streak} in a row yet.`
        : 'Each 1% of your limit is buying about as much work as on your normal dates.'
  }
}

// ----------------------------------------------------------------- compare

export interface CompareRange {
  from: string
  to: string
}

export interface CompareSideResult {
  from: string
  to: string
  n: number
  /** Median $ per 1%, per 1x of plan. */
  perPct?: number
  /** Median $ per 1% as measured (not plan-adjusted). */
  rawPerPct?: number
  mixShare?: CostParts
  plans: string[]
}

export interface HealthCompare {
  kind: WindowKind
  a: CompareSideResult
  b: CompareSideResult
  /** Change from A to B in %, plan-adjusted. Negative = each 1% buys less now. */
  changePct?: number
}

function side(windows: WindowScore[], r: CompareRange): CompareSideResult {
  const lo = ymdStart(r.from)
  const hi = ymdStart(r.to) + 86_400_000
  const ws = windows.filter(
    (w) => !w.excluded && w.dollars > 0 && w.resetsAt >= lo && w.resetsAt < hi
  )
  const out: CompareSideResult = {
    from: r.from,
    to: r.to,
    n: ws.length,
    plans: [...new Set(ws.map((w) => w.plan))]
  }
  if (!ws.length) return out
  out.perPct = median(ws.map((w) => w.perPct / w.mult))
  out.rawPerPct = median(ws.map((w) => w.perPct))
  const total = ws.reduce((a, w) => a + w.dollars, 0) || 1
  const sh = (k: keyof CostParts): number => ws.reduce((a, w) => a + w.mix[k], 0) / total
  out.mixShare = {
    input: sh('input'),
    output: sh('output'),
    cacheRead: sh('cacheRead'),
    cacheWrite: sh('cacheWrite')
  }
  return out
}

export function compareHealth(
  windows: WindowScore[],
  kind: WindowKind,
  a: CompareRange,
  b: CompareRange
): HealthCompare {
  const sa = side(windows, a)
  const sb = side(windows, b)
  return {
    kind,
    a: sa,
    b: sb,
    changePct:
      sa.perPct && sb.perPct !== undefined ? ((sb.perPct - sa.perPct) / sa.perPct) * 100 : undefined
  }
}

// --------------------------------------------------------- where it went

export interface WindowSplit {
  kind: WindowKind
  pct: number
  /** Percentage points by session source label, from local tokens. */
  bySource: { label: string; pct: number; dollars: number }[]
  /** Percentage points not explained by local usage. */
  elsewhere: number
  estimated: boolean
}

/**
 * Split a window's % into local sources (by their share of the local
 * dollars) and "elsewhere" (cloud, claude.ai, mobile).
 */
export function splitWindow(
  w: WindowScore,
  records: UsageRecord[],
  prices: ModelPrice[],
  sourceOf: (key: string) => string,
  isSub: (key: string) => boolean = () => true,
  familyPricing = true
): WindowSplit {
  const priceAs = familyPricing ? familyPricer(prices) : (m: string) => m
  const by = new Map<string, number>()
  let total = 0
  for (let i = lowerBound(records, w.start); i < records.length; i++) {
    const r = records[i]
    if (r.ts > w.at) break
    if (!isSub(r.key)) continue
    const p = costParts({ ...r, model: priceAs(r.model) }, prices)
    const d = p.input + p.output + p.cacheRead + p.cacheWrite
    const label = sourceOf(r.key)
    by.set(label, (by.get(label) ?? 0) + d)
    total += d
  }
  const local = Math.max(0, w.pct - w.untrackedPct)
  return {
    kind: w.kind,
    pct: w.pct,
    elsewhere: w.untrackedPct,
    estimated: w.untrackedEstimated,
    bySource: [...by.entries()]
      .map(([label, dollars]) => ({ label, dollars, pct: total ? (local * dollars) / total : 0 }))
      .sort((a, b) => b.pct - a.pct)
  }
}

// ----------------------------------------------------------- full report

export interface HealthReport {
  kind: WindowKind
  windows: WindowScore[]
  baseline?: Baseline
  verdict: Verdict
  skippedLow: number
  plans: PlanSpan[]
  settings: HealthSettings
}

export function healthReport(
  readings: WindowReading[],
  records: UsageRecord[],
  opts: ScoreOptions
): HealthReport {
  const { windows, skippedLow, baseline } = scoreWindows(readings, records, opts)
  return {
    kind: opts.kind,
    windows,
    baseline,
    verdict: verdictOf(windows, baseline, opts.settings),
    skippedLow,
    plans: planSpans(opts.planHistory, opts.currentPlan),
    settings: opts.settings
  }
}
