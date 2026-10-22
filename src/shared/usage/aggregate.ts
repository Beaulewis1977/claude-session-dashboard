// Turning usage records into the numbers the Usage view shows: time series,
// breakdowns, period cards and 5-hour blocks.

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
}

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
  const groups = new Map<string, Totals>()
  let grand = 0
  for (const r of records) {
    const k = dimensionKey(r, d, ctx)
    let t = groups.get(k)
    if (!t) groups.set(k, (t = emptyTotals()))
    addRecord(t, r, costs?.get(r) ?? recordCost(r, ctx.prices))
    grand += totalTokens(r)
  }
  return [...groups.entries()]
    .map(([key, t]) => ({
      key,
      ...dimensionLabel(key, d, ctx),
      ...t,
      share: grand ? t.total / grand : 0
    }))
    .sort((a, b) => b.total - a.total)
}

function sumRange(
  records: UsageRecord[],
  from: number,
  to: number,
  costs: Map<UsageRecord, number>
): { total: number; cost: number } {
  let total = 0
  let cost = 0
  for (const r of records) {
    if (r.ts >= from && r.ts < to) {
      total += totalTokens(r)
      cost += costs.get(r) ?? 0
    }
  }
  return { total, cost }
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
  for (const r of records) {
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
    spark: hourlySpark(records, todayStart, now)
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
    spark: dailySpark(records, week, 7, tz)
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
    spark: dailySpark(records, `${month}-01`, Math.max(1, monthDays), tz)
  })

  let allTotal = 0
  let allCost = 0
  let first = Infinity
  for (const r of records) {
    allTotal += totalTokens(r)
    allCost += costs.get(r) ?? 0
    if (r.ts < first) first = r.ts
  }
  cards.push({
    id: 'all',
    label: 'All-time',
    from: Number.isFinite(first) ? first : now,
    to: now,
    total: allTotal,
    cost: allCost,
    spark: weeklySpark(records, now, tz, weekStart, 12)
  })
  return cards
}

function hourlySpark(records: UsageRecord[], from: number, now: number): number[] {
  const hours = Math.max(1, Math.ceil((now - from) / 3_600_000))
  const out = new Array<number>(Math.min(24, hours)).fill(0)
  for (const r of records) {
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
  for (const r of records) {
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
  costs: Map<UsageRecord, number>
): SeriesPoint[] {
  const { period } = query
  const tz = ctx.timeZone
  const points = new Map<string, SeriesPoint>()
  let minTs = Infinity
  let maxTs = -Infinity
  for (const r of records) {
    const k = bucketKey(r.ts, period, tz, ctx.weekStart)
    let p = points.get(k)
    if (!p) {
      p = { bucket: k, start: bucketRange(k, period, tz).start, ...emptyTotals(), byModel: {} }
      points.set(k, p)
    }
    addRecord(p, r, costs.get(r) ?? 0)
    p.byModel[r.model] = (p.byModel[r.model] ?? 0) + totalTokens(r)
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
        byModel: {}
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
  return records.filter(
    (r) =>
      (q.from === undefined || r.ts >= q.from) &&
      (q.to === undefined || r.ts < q.to) &&
      (!models || models.has(r.model)) &&
      (!q.sessionKey || r.key === q.sessionKey)
  )
}

export function buildReport(
  all: UsageRecord[],
  query: UsageQuery,
  ctx: ReportContext
): UsageReport {
  const costs = new Map<UsageRecord, number>()
  for (const r of all) costs.set(r, recordCost(r, ctx.prices))
  const inRange = filterRecords(all, query)
  const totals = emptyTotals()
  const extra = new Set<string>()
  for (const r of inRange) {
    addRecord(totals, r, costs.get(r) ?? 0)
    if (r.extra) for (const k of Object.keys(r.extra)) extra.add(k)
  }
  const models = [...new Set(all.map((r) => r.model))].sort()
  const raw = [...inRange].sort((a, b) => b.ts - a.ts).slice(0, 500)
  let first: number | undefined
  let last: number | undefined
  for (const r of all) {
    if (first === undefined || r.ts < first) first = r.ts
    if (last === undefined || r.ts > last) last = r.ts
  }
  const allForCards = query.models?.length
    ? filterRecords(all, { ...query, from: undefined, to: undefined })
    : all
  return {
    generatedAt: ctx.now,
    timeZone: ctx.timeZone,
    weekStart: ctx.weekStart,
    loading: ctx.loading ?? false,
    firstRecordAt: first,
    lastRecordAt: last,
    models,
    totals,
    series: timeSeries(inRange, query, ctx, costs),
    breakdown: breakdown(inRange, query.groupBy ?? 'model', ctx, costs),
    byModel: breakdown(inRange, 'model', ctx, costs),
    topSessions: breakdown(inRange, 'session', ctx, costs).slice(0, 12),
    cards: periodCards(allForCards, ctx, costs),
    blocks: fiveHourBlocks(
      all.filter((r) => r.ts >= ctx.now - 8 * 86_400_000),
      ctx.now,
      ctx.prices
    ).slice(-40),
    raw,
    extraFields: [...extra].sort()
  }
}

/** CSV with one row per day and model (or per record when `perRecord`). */
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
      'est_cost_usd'
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
          recordCost(r, ctx.prices).toFixed(6)
        ]
          .map(esc)
          .join(',')
      )
    }
    return lines.join('\r\n') + '\r\n'
  }
  const rows = new Map<string, Totals & { date: string; model: string }>()
  for (const r of records) {
    const date = dayKey(r.ts, ctx.timeZone)
    const k = `${date}|${r.model}`
    let t = rows.get(k)
    if (!t) rows.set(k, (t = { date, model: r.model, ...emptyTotals() }))
    addRecord(t, r, recordCost(r, ctx.prices))
  }
  const lines = ['date,model,responses,input,output,cache_write,cache_read,total,est_cost_usd']
  for (const t of [...rows.values()].sort((a, b) =>
    a.date === b.date ? a.model.localeCompare(b.model) : a.date.localeCompare(b.date)
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
        t.cost.toFixed(4)
      ]
        .map(esc)
        .join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}
