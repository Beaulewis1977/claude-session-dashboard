// Turning usage records into the numbers the Usage view shows: time series,
// breakdowns, period cards and 5-hour blocks.

import { isFast, medianSpeed, notFast, outputSpeed, speedMedian, thinkingTokens } from './speed'
import { modelLabel, recordCost, type ModelPrice } from './pricing'
import { totalTokens } from './parse'
import {
  addDays,
  bucketKey,
  bucketKeys,
  bucketRange,
  dayKey,
  monthKey,
  prevBucket,
  startOfDayKey,
  weekKey
} from './time'
import type {
  BreakdownRow,
  Dimension,
  PeriodCard,
  SeriesPoint,
  Totals,
  UsageBlock,
  UsageQuery,
  UsageRecord,
  UsageReport,
  WeekStart
} from './types'

export function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, responses: 0 }
}

export function addRecord(t: Totals, r: UsageRecord, cost: number): void {
  t.input += r.input
  t.output += r.output
  t.cacheWrite += r.cacheWrite
  t.cacheRead += r.cacheRead
  t.total += totalTokens(r)
  t.cost += cost
  t.responses++
  if (r.reasoning) t.reasoning = (t.reasoning ?? 0) + r.reasoning
}

/** A record's provider id ("claude" for Claude Code's). */
export function providerOfRecord(r: Pick<UsageRecord, 'provider'>): 'claude' | 'codex' {
  return r.provider ?? 'claude'
}

// --------------------------------------------------------------- the index
//
// Reports are worked out from the raw records every time (so every number is
// exactly what one pass over them gives), but a record list is indexed once:
// its times (for binary search: a range scans only its own records, in the
// same order) and each record's cost at a price table. Lists are replaced,
// never changed, when records change (the usage service sorts a new one).

interface RecordIndex {
  /** Each record's time, in list order. */
  ts: Float64Array
  /** The list is in time order (ranges can be found by binary search). */
  sorted: boolean
  first: number
  last: number
  costs?: { prices: ModelPrice[]; map: Map<UsageRecord, number> }
  /** Each record's cost at a price table, by position. */
  costArr?: { prices: ModelPrice[]; arr: Float64Array }
  /** The list's model ids, sorted. */
  models?: string[]
  /** Total tokens and cost of the whole list (the all-time card). */
  all?: { costs: Map<UsageRecord, number>; total: number; cost: number }
  /** Normal-mode median speed of the whole list. */
  speed?: { tps?: number }
}

const indexes = new WeakMap<UsageRecord[], RecordIndex>()

function indexOf(records: UsageRecord[]): RecordIndex {
  const n = records.length
  let x = indexes.get(records)
  // A list changed in place since it was indexed: index it again.
  if (
    x &&
    (x.ts.length !== n || (n && (x.first !== records[0].ts || x.last !== records[n - 1].ts)))
  )
    x = undefined
  if (!x) {
    const ts = new Float64Array(n)
    let sorted = true
    for (let i = 0; i < n; i++) {
      ts[i] = records[i].ts
      if (i && !(ts[i] >= ts[i - 1])) sorted = false
    }
    x = { ts, sorted, first: n ? records[0].ts : NaN, last: n ? records[n - 1].ts : NaN }
    indexes.set(records, x)
  }
  return x
}

/** First index whose time is ≥ t (sorted lists). */
function lowerBound(ts: Float64Array, t: number): number {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ts[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Index bounds [lo, hi) holding every record with from ≤ ts < to (the whole
 * list when it isn't in time order). Callers still test each record, so the
 * bounds only ever skip records that would be skipped anyway.
 */
export function spanOf(records: UsageRecord[], from: number, to: number): [number, number] {
  const x = indexOf(records)
  if (!x.sorted) return [0, records.length]
  const lo = from === -Infinity ? 0 : lowerBound(x.ts, from)
  const hi = to === Infinity ? records.length : lowerBound(x.ts, to)
  return [lo, Math.max(lo, hi)]
}

/** Each record's cost at a price table (worked out once per list and table). */
export function costsOf(records: UsageRecord[], prices: ModelPrice[]): Map<UsageRecord, number> {
  const x = indexOf(records)
  if (x.costs?.prices === prices) return x.costs.map
  const map = new Map<UsageRecord, number>()
  for (const r of records) map.set(r, recordCost(r, prices))
  x.costs = { prices, map }
  return map
}

/** Each record's cost at a price table, by position in the list. */
function costArrOf(records: UsageRecord[], prices: ModelPrice[]): Float64Array {
  const x = indexOf(records)
  if (x.costArr?.prices === prices) return x.costArr.arr
  const map = costsOf(records, prices)
  const arr = new Float64Array(records.length)
  for (let i = 0; i < records.length; i++) arr[i] = map.get(records[i]) ?? 0
  x.costArr = { prices, arr }
  return arr
}

/**
 * Records' costs: a map by record, or a lookup by position in the list
 * being added up (quicker for big lists).
 */
export type Costs = Map<UsageRecord, number> | ((i: number) => number)

/** The records with from ≤ ts < to, in list order. */
export function inSpan(records: UsageRecord[], from: number, to: number): UsageRecord[] {
  const [lo, hi] = spanOf(records, from, to)
  const out: UsageRecord[] = []
  for (let i = lo; i < hi; i++) {
    const r = records[i]
    if (r.ts >= from && r.ts < to) out.push(r)
  }
  return out
}

/** records[lo..hi) without copying them. */
function* slice(records: UsageRecord[], lo: number, hi: number): Generator<UsageRecord> {
  for (let i = lo; i < hi; i++) yield records[i]
}

const DAY_MS = 86_400_000

export interface ReportContext {
  timeZone: string
  weekStart: WeekStart
  prices: ModelPrice[]
  now: number
  /** Session titles and billing labels, for breakdown rows. */
  sessionLabel?: (key: string) => { label: string; detail?: string } | undefined
  billingOf?: (key: string) => string
  /** Source label of a session (Terminal, VS Code, …). */
  sourceOf?: (key: string) => string
  loading?: boolean
  /** Split each series point by provider (reports covering Claude Code and Codex). */
  byProvider?: boolean
}

function dimensionKey(r: UsageRecord, d: Dimension, ctx: ReportContext): string {
  switch (d) {
    case 'model':
      return r.model
    case 'session':
      return r.key
    case 'project':
      return r.project || '(unknown)'
    case 'env':
      return r.env
    case 'version':
      return r.version ?? '(unknown)'
    case 'billing':
      return ctx.billingOf?.(r.key) ?? 'Unknown'
    case 'source':
      return ctx.sourceOf?.(r.key) ?? 'Local · unknown'
    case 'provider':
      return providerOfRecord(r)
  }
}

function dimensionLabel(
  key: string,
  d: Dimension,
  ctx: ReportContext
): { label: string; detail?: string } {
  switch (d) {
    case 'model':
      return { label: modelLabel(key), detail: key }
    case 'session':
      return ctx.sessionLabel?.(key) ?? { label: key.split(':').pop() ?? key }
    case 'env':
      return { label: key === 'wsl' ? 'WSL' : 'Windows' }
    case 'version':
      return { label: key === '(unknown)' ? 'Unknown version' : `v${key}` }
    case 'provider':
      return { label: key === 'codex' ? 'Codex' : 'Claude Code' }
    default:
      return { label: key }
  }
}

export function breakdown(
  records: UsageRecord[],
  d: Dimension,
  ctx: ReportContext,
  costs?: Map<UsageRecord, number>
): BreakdownRow[] {
  return breakdowns(records, [d], ctx, costs)[0]
}

/**
 * Breakdowns by several dimensions in one pass over the records (each group
 * adds its records in list order, as one breakdown at a time would). The
 * same dimension twice gives the same rows.
 */
export function breakdowns(
  records: UsageRecord[],
  dims: Dimension[],
  ctx: ReportContext,
  costs?: Costs
): BreakdownRow[][] {
  const uniq = [...new Set(dims)]
  const groups = uniq.map(() => new Map<string, Totals>())
  const speeds = uniq.map(() => new Map<string, number[]>())
  // A session's billing and source labels, asked once per session.
  const perKey = (f?: (key: string) => string): ((key: string) => string) | undefined => {
    if (!f) return undefined
    const seen = new Map<string, string>()
    return (key) => {
      let v = seen.get(key)
      if (v === undefined) seen.set(key, (v = f(key)))
      return v
    }
  }
  const keyCtx: ReportContext = {
    ...ctx,
    billingOf: perKey(ctx.billingOf),
    sourceOf: perKey(ctx.sourceOf)
  }
  let grand = 0
  const costAt = typeof costs === 'function' ? costs : undefined
  const costMap = typeof costs === 'function' ? undefined : costs
  for (let j = 0; j < records.length; j++) {
    const r = records[j]
    const cost = costAt ? costAt(j) : (costMap?.get(r) ?? recordCost(r, ctx.prices))
    grand += totalTokens(r)
    const speed = outputSpeed(r)
    const fast = isFast(r)
    for (let i = 0; i < uniq.length; i++) {
      const d = uniq[i]
      const k = dimensionKey(r, d, keyCtx)
      let t = groups[i].get(k)
      if (!t) groups[i].set(k, (t = emptyTotals()))
      addRecord(t, r, cost)
      // Speed: by model, a fast-mode model is a row of its own; other rows show normal mode only.
      const v = d === 'model' || !fast ? speed : undefined
      if (v !== undefined) {
        let xs = speeds[i].get(k)
        if (!xs) speeds[i].set(k, (xs = []))
        xs.push(v)
      }
    }
  }
  const rows = uniq.map((d, i) =>
    [...groups[i].entries()]
      .map(([key, t]) => {
        const xs = speeds[i].get(key) ?? []
        const tps = speedMedian(xs)
        return {
          key,
          ...dimensionLabel(key, d, ctx),
          ...t,
          share: grand ? t.total / grand : 0,
          ...(tps !== undefined ? { tps, tpsSamples: xs.length } : {})
        }
      })
      .sort((a, b) => b.total - a.total)
  )
  // A dimension asked for again gets its own copy (callers may sort or change theirs).
  return dims.map((d, j) => {
    const r = rows[uniq.indexOf(d)]
    return dims.indexOf(d) === j ? r : r.map((x) => ({ ...x }))
  })
}

function sumRange(
  records: UsageRecord[],
  from: number,
  to: number,
  costs: Map<UsageRecord, number>
): { total: number; cost: number } {
  let total = 0
  let cost = 0
  const [lo, hi] = spanOf(records, from, to)
  for (let i = lo; i < hi; i++) {
    const r = records[i]
    if (r.ts >= from && r.ts < to) {
      total += totalTokens(r)
      cost += costs.get(r) ?? 0
    }
  }
  return { total, cost }
}

/** Median normal-mode output speed in a range (fast mode never moves it), when there's enough data. */
function rangeSpeed(records: UsageRecord[], from: number, to: number): { tps?: number } {
  // The whole list's median is worked out once (a median doesn't depend on order).
  const x = from === -Infinity && to === Infinity ? indexOf(records) : undefined
  if (x?.speed) return x.speed
  const [lo, hi] = spanOf(records, from, to)
  const { tps } = medianSpeed(
    { [Symbol.iterator]: () => slice(records, lo, hi) },
    (r) => r.ts >= from && r.ts < to && notFast(r)
  )
  const out = tps !== undefined ? { tps } : {}
  if (x) x.speed = out
  return out
}

/** Daily totals for a range of day keys (for sparklines). */
function dailySpark(
  records: UsageRecord[],
  fromKey: string,
  days: number,
  timeZone: string
): number[] {
  const keys = Array.from({ length: days }, (_, i) => addDays(fromKey, i))
  const index = new Map(keys.map((k, i) => [k, i]))
  const out = new Array<number>(days).fill(0)
  // Only records near those days can have one of their keys (two days of margin each side).
  const [lo, hi] = spanOf(
    records,
    startOfDayKey(fromKey, timeZone) - 2 * DAY_MS,
    startOfDayKey(addDays(fromKey, days), timeZone) + 2 * DAY_MS
  )
  for (let j = lo; j < hi; j++) {
    const r = records[j]
    const i = index.get(dayKey(r.ts, timeZone))
    if (i !== undefined) out[i] += totalTokens(r)
  }
  return out
}

function deltaPct(cur: number, prev: number): number | undefined {
  if (!prev) return undefined
  return ((cur - prev) / prev) * 100
}

/** Today · This week · This month · All-time, each with change vs. the previous period. */
export function periodCards(
  records: UsageRecord[],
  ctx: ReportContext,
  costs: Map<UsageRecord, number>
): PeriodCard[] {
  const { now, timeZone: tz, weekStart } = ctx
  const today = dayKey(now, tz)
  const todayStart = startOfDayKey(today, tz)
  const yesterdayStart = startOfDayKey(addDays(today, -1), tz)
  const elapsedToday = now - todayStart

  const week = weekKey(now, tz, weekStart)
  const weekStartTs = startOfDayKey(week, tz)
  const prevWeekStart = startOfDayKey(addDays(week, -7), tz)

  const month = monthKey(now, tz)
  const { start: monthStart } = bucketRange(month, 'month', tz)
  const { start: prevMonthStart, end: prevMonthEnd } = bucketRange(
    prevBucket(month, 'month'),
    'month',
    tz
  )

  const cards: PeriodCard[] = []
  // Compare like with like: the same elapsed part of the previous period.
  const t = sumRange(records, todayStart, now + 1, costs)
  const tPrev = sumRange(records, yesterdayStart, yesterdayStart + elapsedToday, costs)
  cards.push({
    id: 'today',
    label: 'Today',
    from: todayStart,
    to: now,
    ...t,
    prevTotal: tPrev.total,
    deltaPct: deltaPct(t.total, tPrev.total),
    spark: hourlySpark(records, todayStart, now),
    ...rangeSpeed(records, todayStart, now + 1)
  })

  const w = sumRange(records, weekStartTs, now + 1, costs)
  const wPrev = sumRange(records, prevWeekStart, prevWeekStart + (now - weekStartTs), costs)
  cards.push({
    id: 'week',
    label: 'This week',
    from: weekStartTs,
    to: now,
    ...w,
    prevTotal: wPrev.total,
    deltaPct: deltaPct(w.total, wPrev.total),
    spark: dailySpark(records, week, 7, tz),
    ...rangeSpeed(records, weekStartTs, now + 1)
  })

  const m = sumRange(records, monthStart, now + 1, costs)
  const prevLen = Math.min(now - monthStart, prevMonthEnd - prevMonthStart)
  const mPrev = sumRange(records, prevMonthStart, prevMonthStart + prevLen, costs)
  const monthDays = Math.round((now - monthStart) / 86_400_000) + 1
  cards.push({
    id: 'month',
    label: 'This month',
    from: monthStart,
    to: now,
    ...m,
    prevTotal: mPrev.total,
    deltaPct: deltaPct(m.total, mPrev.total),
    spark: dailySpark(records, `${month}-01`, Math.max(1, monthDays), tz),
    ...rangeSpeed(records, monthStart, now + 1)
  })

  const { total: allTotal, cost: allCost, first } = allTime(records, costs)
  cards.push({
    id: 'all',
    label: 'All-time',
    from: Number.isFinite(first) ? first : now,
    to: now,
    total: allTotal,
    cost: allCost,
    spark: weeklySpark(records, now, tz, weekStart, 12),
    ...rangeSpeed(records, -Infinity, Infinity)
  })
  return cards
}

/** Total tokens, cost (summed in list order) and first time of a whole list. */
function allTime(
  records: UsageRecord[],
  costs: Map<UsageRecord, number>
): { total: number; cost: number; first: number } {
  const x = indexOf(records)
  let first = Infinity
  if (x.sorted) first = records.length ? records[0].ts : Infinity
  else for (const r of records) if (r.ts < first) first = r.ts
  if (x.all?.costs === costs) return { total: x.all.total, cost: x.all.cost, first }
  let total = 0
  let cost = 0
  for (const r of records) {
    total += totalTokens(r)
    cost += costs.get(r) ?? 0
  }
  // Kept for the list's own cost table only (a map made for one report isn't kept).
  if (x.costs?.map === costs) x.all = { costs, total, cost }
  return { total, cost, first }
}

function hourlySpark(records: UsageRecord[], from: number, now: number): number[] {
  const hours = Math.max(1, Math.ceil((now - from) / 3_600_000))
  const out = new Array<number>(Math.min(24, hours)).fill(0)
  const [lo, hi] = spanOf(records, from, now + 1)
  for (let j = lo; j < hi; j++) {
    const r = records[j]
    if (r.ts < from || r.ts > now) continue
    const i = Math.min(out.length - 1, Math.floor((r.ts - from) / 3_600_000))
    out[i] += totalTokens(r)
  }
  return out
}

function weeklySpark(
  records: UsageRecord[],
  now: number,
  tz: string,
  weekStart: WeekStart,
  weeks: number
): number[] {
  const last = weekKey(now, tz, weekStart)
  const keys = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)))
  const index = new Map(keys.map((k, i) => [k, i]))
  const out = new Array<number>(weeks).fill(0)
  // Records long before the first week can't be in any (two days of margin).
  const [lo, hi] = spanOf(records, startOfDayKey(keys[0], tz) - 2 * DAY_MS, Infinity)
  for (let j = lo; j < hi; j++) {
    const r = records[j]
    const i = index.get(weekKey(r.ts, tz, weekStart))
    if (i !== undefined) out[i] += totalTokens(r)
  }
  return out
}

/** Bucketed series with every token type and a per-model split. Empty buckets are filled. */
export function timeSeries(
  records: UsageRecord[],
  query: Pick<UsageQuery, 'period' | 'from' | 'to'>,
  ctx: ReportContext,
  costs: Costs
): SeriesPoint[] {
  const { period } = query
  const tz = ctx.timeZone
  const points = new Map<string, SeriesPoint>()
  let minTs = Infinity
  let maxTs = -Infinity
  const costAt = typeof costs === 'function' ? costs : undefined
  const costMap = typeof costs === 'function' ? undefined : costs
  for (let j = 0; j < records.length; j++) {
    const r = records[j]
    const k = bucketKey(r.ts, period, tz, ctx.weekStart)
    let p = points.get(k)
    if (!p) {
      p = { bucket: k, start: bucketRange(k, period, tz).start, ...emptyTotals(), byModel: {} }
      points.set(k, p)
    }
    addRecord(p, r, costAt ? costAt(j) : (costMap?.get(r) ?? 0))
    p.byModel[r.model] = (p.byModel[r.model] ?? 0) + totalTokens(r)
    if (ctx.byProvider) {
      const pv = providerOfRecord(r)
      p.byProvider ??= {}
      p.byProvider[pv] = (p.byProvider[pv] ?? 0) + totalTokens(r)
    }
    if (r.ts < minTs) minTs = r.ts
    if (r.ts > maxTs) maxTs = r.ts
  }
  const from = query.from ?? (Number.isFinite(minTs) ? minTs : ctx.now)
  const to = Math.min(query.to ?? ctx.now, ctx.now)
  if (!points.size && query.from === undefined) return []
  const keys = bucketKeys(
    bucketKey(from, period, tz, ctx.weekStart),
    bucketKey(Math.max(from, to - 1), period, tz, ctx.weekStart),
    period
  )
  return keys.map(
    (k) =>
      points.get(k) ?? {
        bucket: k,
        start: bucketRange(k, period, tz).start,
        ...emptyTotals(),
        byModel: {},
        ...(ctx.byProvider ? { byProvider: {} } : {})
      }
  )
}

// ------------------------------------------------------------ 5-hour blocks

export const BLOCK_MS = 5 * 3_600_000

/**
 * Group records into 5-hour blocks, like `ccusage blocks`: a block starts at the
 * hour of its first message and lasts 5 hours; a message after the block ends
 * (or after a 5-hour gap) starts a new block.
 */
export function fiveHourBlocks(
  records: UsageRecord[],
  now: number,
  prices: ModelPrice[]
): UsageBlock[] {
  const sorted = [...records].sort((a, b) => a.ts - b.ts)
  const blocks: UsageBlock[] = []
  let cur: (UsageBlock & { modelSet: Set<string> }) | undefined
  for (const r of sorted) {
    // As in ccusage: a block starts at the hour of its first response and
    // holds every response within 5 hours of that start, until a gap of more
    // than 5 hours.
    if (!cur || r.ts - cur.start > BLOCK_MS || r.ts - cur.lastActivity > BLOCK_MS) {
      if (cur) blocks.push(finishBlock(cur, now))
      const start = Math.floor(r.ts / 3_600_000) * 3_600_000
      cur = {
        start,
        end: start + BLOCK_MS,
        lastActivity: r.ts,
        active: false,
        models: [],
        modelSet: new Set(),
        ...emptyTotals()
      }
    }
    addRecord(cur, r, recordCost(r, prices))
    cur.lastActivity = r.ts
    cur.modelSet.add(r.model)
  }
  if (cur) blocks.push(finishBlock(cur, now))
  return blocks
}

function finishBlock(b: UsageBlock & { modelSet: Set<string> }, now: number): UsageBlock {
  const { modelSet, ...rest } = b
  return { ...rest, models: [...modelSet], active: now >= b.start && now < b.end }
}

// ------------------------------------------------------------------ report

export function filterRecords(records: UsageRecord[], q: UsageQuery): UsageRecord[] {
  const models = q.models?.length ? new Set(q.models) : undefined
  const [lo, hi] = spanOf(records, q.from ?? -Infinity, q.to ?? Infinity)
  const out: UsageRecord[] = []
  for (let i = lo; i < hi; i++) {
    const r = records[i]
    if (
      (q.from === undefined || r.ts >= q.from) &&
      (q.to === undefined || r.ts < q.to) &&
      (!models || models.has(r.model)) &&
      (!q.sessionKey || r.key === q.sessionKey)
    )
      out.push(r)
  }
  return out
}

/** filterRecords, also giving each kept record's position in `records`. */
function filterWithPositions(
  records: UsageRecord[],
  q: UsageQuery
): { kept: UsageRecord[]; pos: Int32Array } {
  const models = q.models?.length ? new Set(q.models) : undefined
  const [lo, hi] = spanOf(records, q.from ?? -Infinity, q.to ?? Infinity)
  const kept: UsageRecord[] = []
  const pos = new Int32Array(hi - lo)
  for (let i = lo; i < hi; i++) {
    const r = records[i]
    if (
      (q.from === undefined || r.ts >= q.from) &&
      (q.to === undefined || r.ts < q.to) &&
      (!models || models.has(r.model)) &&
      (!q.sessionKey || r.key === q.sessionKey)
    ) {
      pos[kept.length] = i
      kept.push(r)
    }
  }
  return { kept, pos }
}

/**
 * The newest `max` records, newest first: exactly what a stable sort by time
 * (newest first) and a slice give, without sorting a list already in order.
 */
export function newestFirst(records: UsageRecord[], max: number): UsageRecord[] {
  if (!indexOf(records).sorted) return [...records].sort((a, b) => b.ts - a.ts).slice(0, max)
  const out: UsageRecord[] = []
  let j = records.length - 1
  while (j >= 0 && out.length < max) {
    // A run of equal times keeps its list order (the sort is stable).
    let k = j
    while (k > 0 && records[k - 1].ts === records[j].ts) k--
    for (let i = k; i <= j && out.length < max; i++) out.push(records[i])
    j = k - 1
  }
  return out
}

/** The list's model ids, sorted (worked out once per list). */
function modelsOf(records: UsageRecord[]): string[] {
  const x = indexOf(records)
  return (x.models ??= [...new Set(records.map((r) => r.model))].sort())
}

export function buildReport(
  all: UsageRecord[],
  query: UsageQuery,
  ctx: ReportContext
): UsageReport {
  const costs = costsOf(all, ctx.prices)
  const arr = costArrOf(all, ctx.prices)
  const { kept: inRange, pos } = filterWithPositions(all, query)
  // In-range record i's cost (the same numbers as the map, by position).
  const costAt = (i: number): number => arr[pos[i]]
  const totals = emptyTotals()
  const extra = new Set<string>()
  for (let i = 0; i < inRange.length; i++) {
    const r = inRange[i]
    addRecord(totals, r, costAt(i))
    if (r.extra) for (const k in r.extra) extra.add(k)
  }
  const models = [...modelsOf(all)]
  const raw = newestFirst(inRange, 500)
  let first: number | undefined
  let last: number | undefined
  if (indexOf(all).sorted && all.length) {
    first = all[0].ts
    last = all[all.length - 1].ts
  } else
    for (const r of all) {
      if (first === undefined || r.ts < first) first = r.ts
      if (last === undefined || r.ts > last) last = r.ts
    }
  const allForCards = query.models?.length
    ? filterRecords(all, { ...query, from: undefined, to: undefined })
    : all
  const [byGroup, byModel, bySession] = breakdowns(
    inRange,
    [query.groupBy ?? 'model', 'model', 'session'],
    ctx,
    costAt
  )
  return {
    generatedAt: ctx.now,
    timeZone: ctx.timeZone,
    weekStart: ctx.weekStart,
    loading: ctx.loading ?? false,
    firstRecordAt: first,
    lastRecordAt: last,
    models,
    totals,
    series: timeSeries(inRange, query, ctx, costAt),
    breakdown: byGroup,
    byModel,
    topSessions: bySession.slice(0, 12),
    cards: periodCards(allForCards, ctx, costs),
    blocks: fiveHourBlocks(
      inSpan(all, ctx.now - 8 * 86_400_000, Infinity),
      ctx.now,
      ctx.prices
    ).slice(-40),
    raw,
    extraFields: [...extra].sort()
  }
}

/** CSV with one row per day and model (or per record when `perRecord`). */
/** A speed for the CSV: one decimal, empty when unknown. */
const speedText = (v: number | undefined): string | undefined =>
  v === undefined ? undefined : v.toFixed(1)

export function toCsv(
  records: UsageRecord[],
  ctx: Pick<ReportContext, 'timeZone' | 'prices'>,
  perRecord = false
): string {
  const esc = (v: string | number | undefined): string => {
    const s = v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  if (perRecord) {
    const header = [
      'timestamp',
      'session',
      'project',
      'environment',
      'model',
      'version',
      'stop_reason',
      'input',
      'output',
      'cache_write',
      'cache_read',
      'total',
      'est_cost_usd',
      'reasoning',
      'provider',
      'thinking_tokens',
      'gen_ms',
      'ttft_ms',
      'tokens_per_sec',
      'fast_mode'
    ]
    const lines = [header.join(',')]
    for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
      lines.push(
        [
          new Date(r.ts).toISOString(),
          r.key,
          r.project,
          r.env,
          r.model,
          r.version,
          r.stop,
          r.input,
          r.output,
          r.cacheWrite,
          r.cacheRead,
          totalTokens(r),
          recordCost(r, ctx.prices).toFixed(6),
          r.reasoning ?? 0,
          providerOfRecord(r),
          thinkingTokens(r),
          r.genMs === undefined ? undefined : Math.round(r.genMs),
          r.ttftMs === undefined ? undefined : Math.round(r.ttftMs),
          speedText(outputSpeed(r)),
          isFast(r) ? 'yes' : 'no'
        ]
          .map(esc)
          .join(',')
      )
    }
    return lines.join('\r\n') + '\r\n'
  }
  const rows = new Map<
    string,
    Totals & { date: string; model: string; provider: string; speeds: number[] }
  >()
  for (const r of records) {
    const date = dayKey(r.ts, ctx.timeZone)
    const provider = providerOfRecord(r)
    const k = `${date}|${provider}|${r.model}`
    let t = rows.get(k)
    if (!t) rows.set(k, (t = { date, model: r.model, provider, speeds: [], ...emptyTotals() }))
    addRecord(t, r, recordCost(r, ctx.prices))
    const v = outputSpeed(r)
    if (v !== undefined) t.speeds.push(v)
  }
  const lines = [
    'date,model,responses,input,output,cache_write,cache_read,total,est_cost_usd,reasoning,provider,median_tokens_per_sec,speed_samples'
  ]
  for (const t of [...rows.values()].sort((a, b) =>
    a.date !== b.date
      ? a.date.localeCompare(b.date)
      : a.provider !== b.provider
        ? a.provider.localeCompare(b.provider)
        : a.model.localeCompare(b.model)
  )) {
    lines.push(
      [
        t.date,
        t.model,
        t.responses,
        t.input,
        t.output,
        t.cacheWrite,
        t.cacheRead,
        t.total,
        t.cost.toFixed(4),
        t.reasoning ?? 0,
        t.provider,
        speedText(speedMedian(t.speeds)),
        t.speeds.length
      ]
        .map(esc)
        .join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}
