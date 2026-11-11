// Turning usage records into the numbers the Usage view shows: time series,
// breakdowns, period cards and 5-hour blocks.

import {
  isFast,
  medianSpeed,
  notFast,
  outputSpeed,
  outputSpeedOrNone,
  NO_SPEED,
  speedMedian,
  thinkingTokens
} from './speed'
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

/** Fields of one group in TotalsSums: input, output, cacheWrite, cacheRead, total, cost, responses, reasoning. */
const F = 8

/**
 * Totals of many groups, added up in a typed array: the same additions in
 * the same order as addRecord (so the same numbers, to the last bit), with
 * no number boxed per record (writing a sum into an object field that
 * several kinds of objects share allocates a new number each time, which
 * made a report over all records hundreds of bytes of garbage per record).
 */
export class TotalsSums {
  private s: Float64Array
  /** Groups that had reasoning tokens (addRecord adds the field only then). */
  private reasoning: Uint8Array
  /** Groups whose first record had reasoning tokens (the field came before anything added after it). */
  private reasonedFirst: Uint8Array
  size = 0

  constructor(capacity = 16) {
    const n = Math.max(1, capacity)
    this.s = new Float64Array(n * F)
    this.reasoning = new Uint8Array(n)
    this.reasonedFirst = new Uint8Array(n)
  }

  /** A new group (its index). */
  group(): number {
    if (this.size === this.reasoning.length) {
      const n = this.reasoning.length * 2
      const s = new Float64Array(n * F)
      s.set(this.s)
      this.s = s
      const r = new Uint8Array(n)
      r.set(this.reasoning)
      this.reasoning = r
      const f = new Uint8Array(n)
      f.set(this.reasonedFirst)
      this.reasonedFirst = f
    }
    return this.size++
  }

  /** addRecord into group g. */
  add(g: number, r: UsageRecord, cost: number): void {
    const s = this.s
    const o = g * F
    s[o] += r.input
    s[o + 1] += r.output
    s[o + 2] += r.cacheWrite
    s[o + 3] += r.cacheRead
    s[o + 4] += r.input + r.output + r.cacheWrite + r.cacheRead
    s[o + 5] += cost
    if (r.reasoning) {
      // No record counted yet: this is the group's first.
      if (s[o + 6] === 0) this.reasonedFirst[g] = 1
      s[o + 7] += r.reasoning
      this.reasoning[g] = 1
    }
    s[o + 6]++
  }

  /** Group g's first record had reasoning tokens. */
  reasonedAtFirst(g: number): boolean {
    return this.reasonedFirst[g] === 1
  }

  hasReasoning(g: number): boolean {
    return this.reasoning[g] === 1
  }

  reasoningOf(g: number): number {
    return this.s[g * F + 7]
  }

  /** Group g's totals, as addRecord leaves them (reasoning only when there was some, unless left out). */
  totals(g: number, withReasoning = true): Totals {
    const s = this.s
    const o = g * F
    const t: Totals = {
      input: s[o],
      output: s[o + 1],
      cacheWrite: s[o + 2],
      cacheRead: s[o + 3],
      total: s[o + 4],
      cost: s[o + 5],
      responses: s[o + 6]
    }
    if (withReasoning && this.reasoning[g]) t.reasoning = s[o + 7]
    return t
  }
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
  /** Each record's cost at a price table, by position. */
  costArr?: { prices: ModelPrice[]; arr: Float64Array }
  /** The list's model ids, sorted. */
  models?: string[]
  /** Total tokens and cost of the whole list (the all-time card), at its own cost table. */
  all?: { costs: Float64Array; total: number; cost: number }
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

/** Each record's cost at a price table, by position in the list (worked out once per list and table). */
export function costArrOf(records: UsageRecord[], prices: ModelPrice[]): Float64Array {
  const x = indexOf(records)
  if (x.costArr?.prices === prices) return x.costArr.arr
  const arr = new Float64Array(records.length)
  for (let i = 0; i < records.length; i++) arr[i] = recordCost(records[i], prices)
  x.costArr = { prices, arr }
  return arr
}

/** Costs by position: record i of the list being added up costs arr[pos[i]] (arr[i] without pos). */
export interface CostTable {
  arr: Float64Array
  pos?: Int32Array
}

/**
 * Records' costs: a map by record, a lookup by position in the list being
 * added up, or a table by position (quickest for big lists: no number is
 * boxed per record).
 */
export type Costs = Map<UsageRecord, number> | ((i: number) => number) | CostTable

function isTable(c: Costs | undefined): c is CostTable {
  return !!c && typeof c === 'object' && !(c instanceof Map)
}

/**
 * The costs of a list as a table by position (a table as it is; a map or a
 * lookup copied into one, with `missing` for a record a map doesn't have):
 * a loop then reads every cost from one typed array, so none is boxed.
 */
function tableOf(
  records: UsageRecord[],
  costs: Costs | undefined,
  missing: (r: UsageRecord) => number
): CostTable {
  if (isTable(costs)) return costs
  const arr = new Float64Array(records.length)
  if (typeof costs === 'function') for (let i = 0; i < records.length; i++) arr[i] = costs(i)
  else
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      const c = costs?.get(r)
      arr[i] = c ?? missing(r)
    }
  return { arr }
}

const noCost = (): number => 0

/** Record i's cost (0 when a map doesn't have it). */
function costOf(costs: Costs, records: UsageRecord[], i: number): number {
  if (costs instanceof Map) return costs.get(records[i]) ?? 0
  if (typeof costs === 'function') return costs(i)
  return costs.arr[costs.pos ? costs.pos[i] : i]
}

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
  const groups = uniq.map(() => new Map<string, number>())
  const sums = uniq.map(() => new TotalsSums())
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
  const { arr, pos } = tableOf(records, costs, (r) => recordCost(r, ctx.prices))
  for (let j = 0; j < records.length; j++) {
    const r = records[j]
    const cost = pos ? arr[pos[j]] : arr[j]
    grand += totalTokens(r)
    const speed = outputSpeedOrNone(r)
    const fast = isFast(r)
    for (let i = 0; i < uniq.length; i++) {
      const d = uniq[i]
      const k = dimensionKey(r, d, keyCtx)
      let g = groups[i].get(k)
      if (g === undefined) groups[i].set(k, (g = sums[i].group()))
      sums[i].add(g, r, cost)
      // Speed: by model, a fast-mode model is a row of its own; other rows show normal mode only.
      if (speed !== NO_SPEED && (d === 'model' || !fast)) {
        let xs = speeds[i].get(k)
        if (!xs) speeds[i].set(k, (xs = []))
        xs.push(speed)
      }
    }
  }
  const rows = uniq.map((d, i) =>
    [...groups[i].entries()]
      .map(([key, g]) => {
        const t = sums[i].totals(g)
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
  costs: Costs
): { total: number; cost: number } {
  let total = 0
  let cost = 0
  const [lo, hi] = spanOf(records, from, to)
  if (!isTable(costs)) {
    for (let i = lo; i < hi; i++) {
      const r = records[i]
      if (r.ts >= from && r.ts < to) {
        total += totalTokens(r)
        cost += costOf(costs, records, i)
      }
    }
    return { total, cost }
  }
  const { arr, pos } = costs
  for (let i = lo; i < hi; i++) {
    const r = records[i]
    if (r.ts >= from && r.ts < to) {
      total += totalTokens(r)
      cost += pos ? arr[pos[i]] : arr[i]
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
  costs: Costs
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
  costs: Costs
): { total: number; cost: number; first: number } {
  const x = indexOf(records)
  let first = Infinity
  if (x.sorted) first = records.length ? records[0].ts : Infinity
  else for (const r of records) if (r.ts < first) first = r.ts
  // At the list's own cost table, the sums are kept with the list (not for costs made for one report).
  const own = isTable(costs) && !costs.pos && costs.arr === x.costArr?.arr ? costs.arr : undefined
  if (own && x.all?.costs === own) return { total: x.all.total, cost: x.all.cost, first }
  let total = 0
  let cost = 0
  const { arr, pos } = tableOf(records, costs, noCost)
  for (let i = 0; i < records.length; i++) {
    total += totalTokens(records[i])
    cost += pos ? arr[pos[i]] : arr[i]
  }
  if (own) x.all = { costs: own, total, cost }
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
  // Each point's sums in typed arrays (see TotalsSums), its per-model and
  // per-provider sums too. The points are made at the end, their fields in
  // the order adding to an object record by record gave them.
  const pointOf = new Map<string, number>()
  const order: string[] = []
  const sums = new TotalsSums(64)
  /** Per point: model → its slot in modelSums (in the order the models came). */
  const modelSlots: Map<string, number>[] = []
  let modelSums = new Float64Array(256)
  let slots = 0
  /** Per point: tokens of Claude Code (2p) and Codex (2p + 1). */
  let provSums = new Float64Array(128)
  /** Per point: which providers came (bit 1 Claude Code, bit 2 Codex), and which first (1, 2). */
  let provSeen = new Uint8Array(64)
  let provFirst = new Uint8Array(64)
  let minTs = Infinity
  let maxTs = -Infinity
  const { arr, pos } = tableOf(records, costs, noCost)
  for (let j = 0; j < records.length; j++) {
    const r = records[j]
    const k = bucketKey(r.ts, period, tz, ctx.weekStart)
    let p = pointOf.get(k)
    if (p === undefined) {
      p = sums.group()
      pointOf.set(k, p)
      order.push(k)
      modelSlots.push(new Map())
      if (p >= provSeen.length) {
        const n = provSeen.length * 2
        const ps = new Float64Array(n * 2)
        ps.set(provSums)
        provSums = ps
        const seen = new Uint8Array(n)
        seen.set(provSeen)
        provSeen = seen
        const first = new Uint8Array(n)
        first.set(provFirst)
        provFirst = first
      }
    }
    sums.add(p, r, pos ? arr[pos[j]] : arr[j])
    const tokens = r.input + r.output + r.cacheWrite + r.cacheRead
    const ms = modelSlots[p]
    let slot = ms.get(r.model)
    if (slot === undefined) {
      if (slots === modelSums.length) {
        const m = new Float64Array(modelSums.length * 2)
        m.set(modelSums)
        modelSums = m
      }
      ms.set(r.model, (slot = slots++))
    }
    modelSums[slot] += tokens
    if (ctx.byProvider) {
      const pv = providerOfRecord(r) === 'codex' ? 1 : 0
      if (!provFirst[p]) provFirst[p] = pv + 1
      provSeen[p] |= 1 << pv
      provSums[p * 2 + pv] += tokens
    }
    if (r.ts < minTs) minTs = r.ts
    if (r.ts > maxTs) maxTs = r.ts
  }
  const points = new Map<string, SeriesPoint>()
  for (let p = 0; p < order.length; p++) {
    const k = order[p]
    const point: SeriesPoint = {
      bucket: k,
      start: bucketRange(k, period, tz).start,
      ...sums.totals(p, false),
      byModel: {}
    }
    for (const [model, slot] of modelSlots[p]) point.byModel[model] = modelSums[slot]
    // addRecord added reasoning at the first record that had some, and
    // byProvider came at the point's first record (after its reasoning).
    const reasoning = sums.hasReasoning(p)
    if (ctx.byProvider) {
      if (reasoning && sums.reasonedAtFirst(p)) point.reasoning = sums.reasoningOf(p)
      const by: Record<string, number> = {}
      const firstPv = provFirst[p] - 1
      for (const pv of firstPv === 1 ? [1, 0] : [0, 1])
        if (provSeen[p] & (1 << pv)) by[pv ? 'codex' : 'claude'] = provSums[p * 2 + pv]
      point.byProvider = by
      if (reasoning && !sums.reasonedAtFirst(p)) point.reasoning = sums.reasoningOf(p)
    } else if (reasoning) point.reasoning = sums.reasoningOf(p)
    points.set(k, point)
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
  const arr = costArrOf(all, ctx.prices)
  const { kept: inRange, pos } = filterWithPositions(all, query)
  // In-range record i's cost: arr[pos[i]].
  const costAt: CostTable = { arr, pos }
  const sums = new TotalsSums(1)
  sums.group()
  const extra = new Set<string>()
  for (let i = 0; i < inRange.length; i++) {
    const r = inRange[i]
    sums.add(0, r, arr[pos[i]])
    if (r.extra) for (const k in r.extra) extra.add(k)
  }
  const totals = sums.totals(0)
  const models = [...modelsOf(all)]
  const raw = query.raw === false ? [] : newestFirst(inRange, 500)
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
  // The cards' records (all of them unless models are picked) and their costs by position.
  let allForCards = all
  let cardCosts: CostTable = { arr }
  if (query.models?.length) {
    const f = filterWithPositions(all, { ...query, from: undefined, to: undefined })
    allForCards = f.kept
    cardCosts = { arr, pos: f.pos }
  }
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
    cards: periodCards(allForCards, ctx, cardCosts),
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
