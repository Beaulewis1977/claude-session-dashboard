// Model performance trends ("is it nerfed?"). These are indicators only:
// they depend heavily on what you were working on, so the UI says so.

import type { BridgeReading } from './bridge'
import type { CapacityPoint } from './limits'
import { planLabel, type PlanSpan } from './health'
import { modelLabel } from './pricing'
import { bucketRange, weekKey } from './time'
import type { TurnSample, UsageRecord, WeekStart } from './types'

export type TrendGroupBy = 'all' | 'model' | 'version'

export type MetricId =
  | 'outputPerResponse'
  | 'outputPerTurn'
  | 'latency'
  | 'toolErrorRate'
  | 'apiErrorShare'
  | 'responsesPerTurn'
  | 'toolCallsPerTurn'
  | 'correctionRate'
  | 'cacheReadRatio'
  | 'thinkingPerResponse'
  | 'thinkingLength'
  | 'contextUsage'

export interface MetricDef {
  id: MetricId
  title: string
  subtitle: string
  unit: 'tokens' | 'seconds' | 'percent' | 'count' | 'chars'
  /** Which direction is "better", for the compare table. */
  better: 'higher' | 'lower' | 'neutral'
  info?: string
}

export const METRICS: MetricDef[] = [
  {
    id: 'outputPerResponse',
    title: 'Output per response',
    subtitle: 'Average output tokens in each API response',
    unit: 'tokens',
    better: 'neutral',
    info: 'Shorter answers can mean less effort, or just simpler tasks.'
  },
  {
    id: 'outputPerTurn',
    title: 'Output per request',
    subtitle: 'Average output tokens for each message you sent',
    unit: 'tokens',
    better: 'neutral'
  },
  {
    id: 'latency',
    title: 'Response time',
    subtitle: 'Median time from your message to the first reply',
    unit: 'seconds',
    better: 'lower'
  },
  {
    id: 'toolErrorRate',
    title: 'Tool error rate',
    subtitle: 'Share of tool calls that returned an error',
    unit: 'percent',
    better: 'lower'
  },
  {
    id: 'apiErrorShare',
    title: 'API errors and retries',
    subtitle: 'Share of requests that hit an API error or a retry',
    unit: 'percent',
    better: 'lower'
  },
  {
    id: 'responsesPerTurn',
    title: 'Assistant turns per request',
    subtitle: 'API responses Claude needed for each message you sent',
    unit: 'count',
    better: 'neutral'
  },
  {
    id: 'toolCallsPerTurn',
    title: 'Tool calls per request',
    subtitle: 'Tools Claude used for each message you sent',
    unit: 'count',
    better: 'neutral'
  },
  {
    id: 'correctionRate',
    title: 'Interruptions and corrections',
    subtitle:
      'Share of your messages that interrupt or correct Claude (“no”, “wrong”, “that’s not…”)',
    unit: 'percent',
    better: 'lower',
    info: 'Counts messages right after an interruption and messages that start with “no”, “wrong” or “that’s not”.'
  },
  {
    id: 'cacheReadRatio',
    title: 'Cache read ratio',
    subtitle: 'Share of input tokens served from the prompt cache',
    unit: 'percent',
    better: 'higher'
  },
  {
    id: 'thinkingPerResponse',
    title: 'Thinking blocks per response',
    subtitle: 'How often Claude thinks before answering',
    unit: 'count',
    better: 'neutral'
  },
  {
    id: 'thinkingLength',
    title: 'Thinking length',
    subtitle: 'Average characters per thinking block (when Claude Code saves the text)',
    unit: 'chars',
    better: 'neutral',
    info: 'Newer Claude Code versions often store thinking without its text, so this can drop to zero for reasons unrelated to the model.'
  },
  {
    id: 'contextUsage',
    title: 'Context window used',
    subtitle: 'Median context window use per session, from the status line',
    unit: 'percent',
    better: 'neutral'
  }
]

/** Additive pieces of every metric, so groups can be merged and compared. */
export interface MetricAcc {
  records: number
  output: number
  inputAll: number
  cacheRead: number
  turns: number
  turnOutput: number
  latencies: number[]
  toolResults: number
  toolErrors: number
  apiErrorTurns: number
  responses: number
  toolCalls: number
  corrections: number
  thinkingBlocks: number
  thinkingChars: number
  contexts: number[]
}

export function emptyAcc(): MetricAcc {
  return {
    records: 0,
    output: 0,
    inputAll: 0,
    cacheRead: 0,
    turns: 0,
    turnOutput: 0,
    latencies: [],
    toolResults: 0,
    toolErrors: 0,
    apiErrorTurns: 0,
    responses: 0,
    toolCalls: 0,
    corrections: 0,
    thinkingBlocks: 0,
    thinkingChars: 0,
    contexts: []
  }
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function addRecordToAcc(a: MetricAcc, r: UsageRecord): void {
  a.records++
  a.output += r.output
  a.inputAll += r.input + r.cacheRead + r.cacheWrite
  a.cacheRead += r.cacheRead
}

export function addTurnToAcc(a: MetricAcc, t: TurnSample): void {
  a.turns++
  a.turnOutput += t.outputTokens
  // Ignore idle gaps (e.g. the laptop slept): latencies over 10 minutes aren't response times.
  if (t.latencyMs !== undefined && t.latencyMs < 600_000) a.latencies.push(t.latencyMs)
  a.toolResults += t.toolResults
  a.toolErrors += t.toolErrors
  if (t.apiErrors > 0) a.apiErrorTurns++
  a.responses += t.responses
  a.toolCalls += t.toolCalls
  if (t.correction || t.interrupted) a.corrections++
  a.thinkingBlocks += t.thinkingBlocks
  a.thinkingChars += t.thinkingChars
}

/** Value of a metric, or undefined when there's not enough data. */
export function metricValue(a: MetricAcc, id: MetricId): number | undefined {
  const div = (x: number, y: number, min = 1): number | undefined => (y >= min ? x / y : undefined)
  switch (id) {
    case 'outputPerResponse':
      return div(a.output, a.records, 3)
    case 'outputPerTurn':
      return div(a.turnOutput, a.turns, 2)
    case 'latency': {
      const m = a.latencies.length >= 2 ? median(a.latencies) : undefined
      return m === undefined ? undefined : m / 1000
    }
    case 'toolErrorRate': {
      const v = div(a.toolErrors, a.toolResults, 3)
      return v === undefined ? undefined : v * 100
    }
    case 'apiErrorShare': {
      const v = div(a.apiErrorTurns, a.turns, 2)
      return v === undefined ? undefined : v * 100
    }
    case 'responsesPerTurn':
      return div(a.responses, a.turns, 2)
    case 'toolCallsPerTurn':
      return div(a.toolCalls, a.turns, 2)
    case 'correctionRate': {
      const v = div(a.corrections, a.turns, 2)
      return v === undefined ? undefined : v * 100
    }
    case 'cacheReadRatio': {
      const v = div(a.cacheRead, a.inputAll, 1)
      return v === undefined ? undefined : v * 100
    }
    case 'thinkingPerResponse':
      return div(a.thinkingBlocks, a.responses, 3)
    case 'thinkingLength':
      return div(a.thinkingChars, a.thinkingBlocks, 1)
    case 'contextUsage':
      return median(a.contexts)
  }
}

// --------------------------------------------------------------- weekly

export interface TrendPoint {
  week: string
  /** Week start, epoch ms. */
  start: number
  value?: number
}

export interface TrendSeries {
  metric: MetricId
  group: string
  label: string
  points: TrendPoint[]
}

export interface TrendMarker {
  week: string
  start: number
  kind: 'model' | 'version' | 'capacity' | 'plan'
  label: string
}

export interface TrendsReport {
  groupBy: TrendGroupBy
  weeks: { week: string; start: number }[]
  groups: { key: string; label: string; volume: number }[]
  series: TrendSeries[]
  markers: TrendMarker[]
  versions: string[]
  models: string[]
}

export interface TrendsInput {
  records: UsageRecord[]
  turns: TurnSample[]
  readings: BridgeReading[]
  capacity?: CapacityPoint[]
  /** Plan changes, marked on the charts. */
  plans?: PlanSpan[]
  timeZone: string
  weekStart: WeekStart
  groupBy: TrendGroupBy
  /** Only the busiest groups get their own line. */
  maxGroups?: number
}

const groupOf = (by: TrendGroupBy, model?: string, version?: string): string =>
  by === 'all' ? 'all' : by === 'model' ? (model ?? 'unknown') : (version ?? 'unknown')

/** Order versions numerically (2.1.9 before 2.1.10). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x))
  const pb = b.split(/[.-]/).map((x) => Number(x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return a.localeCompare(b)
}

export function buildTrends(input: TrendsInput): TrendsReport {
  const { timeZone: tz, weekStart, groupBy } = input
  const accs = new Map<string, Map<string, MetricAcc>>() // group → week → acc
  const volume = new Map<string, number>()
  const weekSet = new Set<string>()
  const acc = (group: string, week: string): MetricAcc => {
    let g = accs.get(group)
    if (!g) accs.set(group, (g = new Map()))
    let a = g.get(week)
    if (!a) g.set(week, (a = emptyAcc()))
    weekSet.add(week)
    return a
  }
  const models = new Set<string>()
  const versions = new Set<string>()
  // First week each model / version appears; dominant version per week.
  const firstModel = new Map<string, string>()
  const versionWeek = new Map<string, Map<string, number>>()

  for (const r of input.records) {
    const w = weekKey(r.ts, tz, weekStart)
    const g = groupOf(groupBy, r.model, r.version)
    addRecordToAcc(acc(g, w), r)
    volume.set(g, (volume.get(g) ?? 0) + 1)
    models.add(r.model)
    if (r.version) versions.add(r.version)
    const fm = firstModel.get(r.model)
    if (!fm || w < fm) firstModel.set(r.model, w)
    if (r.version) {
      let vw = versionWeek.get(w)
      if (!vw) versionWeek.set(w, (vw = new Map()))
      vw.set(r.version, (vw.get(r.version) ?? 0) + 1)
    }
  }
  for (const t of input.turns) {
    const w = weekKey(t.ts, tz, weekStart)
    addTurnToAcc(acc(groupOf(groupBy, t.model, t.version), w), t)
  }
  // Context window use: the last reading of each session in each week.
  const lastCtx = new Map<string, BridgeReading>()
  for (const r of input.readings) {
    if (r.contextPct === undefined || !r.sessionId) continue
    const k = `${r.sessionId}|${weekKey(r.ts, tz, weekStart)}`
    const prev = lastCtx.get(k)
    if (!prev || r.ts > prev.ts) lastCtx.set(k, r)
  }
  for (const r of lastCtx.values()) {
    acc(groupOf(groupBy, r.model, r.version), weekKey(r.ts, tz, weekStart)).contexts.push(
      r.contextPct!
    )
  }

  const weeks = [...weekSet]
    .sort()
    .map((week) => ({ week, start: bucketRange(week, 'week', tz).start }))
  const groups = [...volume.entries()]
    .filter(([k]) => accs.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupBy === 'all' ? 1 : (input.maxGroups ?? 5))
    .map(([key, v]) => ({
      key,
      label: groupBy === 'model' ? modelLabel(key) : groupBy === 'version' ? `v${key}` : 'All',
      volume: v
    }))
  if (groupBy === 'all' && !groups.length && accs.has('all'))
    groups.push({ key: 'all', label: 'All', volume: 0 })

  const series: TrendSeries[] = []
  for (const m of METRICS) {
    for (const g of groups) {
      const byWeek = accs.get(g.key)!
      series.push({
        metric: m.id,
        group: g.key,
        label: g.label,
        points: weeks.map((w) => {
          const a = byWeek.get(w.week)
          return { ...w, value: a ? metricValue(a, m.id) : undefined }
        })
      })
    }
  }

  const markers: TrendMarker[] = []
  const firstWeek = weeks[0]?.week
  for (const [model, w] of firstModel) {
    if (w === firstWeek) continue
    markers.push({
      week: w,
      start: bucketRange(w, 'week', tz).start,
      kind: 'model',
      label: modelLabel(model)
    })
  }
  let prevDominant: string | undefined
  for (const w of weeks) {
    const vw = versionWeek.get(w.week)
    if (!vw) continue
    const dominant = [...vw.entries()].sort((a, b) => b[1] - a[1])[0][0]
    if (prevDominant && dominant !== prevDominant && compareVersions(dominant, prevDominant) > 0) {
      // Only mark minor-or-larger jumps, or every change when grouped by version.
      const [a1, b1] = [prevDominant.split('.'), dominant.split('.')]
      const big = a1[0] !== b1[0] || a1[1] !== b1[1] || Number(b1[2]) - Number(a1[2]) >= 20
      if (groupBy === 'version' || big)
        markers.push({ ...w, kind: 'version', label: `v${dominant}` })
    }
    prevDominant = dominant
  }
  // Implied capacity: mark weeks whose median moved ≥15% from the previous week with data.
  if (input.capacity?.length) {
    const byWeek = new Map<string, number[]>()
    for (const p of input.capacity) {
      const w = weekKey(p.ts, tz, weekStart)
      byWeek.set(w, [...(byWeek.get(w) ?? []), p.capacity])
    }
    let prev: number | undefined
    for (const w of [...byWeek.keys()].sort()) {
      const m = median(byWeek.get(w)!)!
      if (prev !== undefined && Math.abs(m - prev) / prev >= 0.15) {
        markers.push({
          week: w,
          start: bucketRange(w, 'week', tz).start,
          kind: 'capacity',
          label: `$/1% ${m < prev ? '−' : '+'}${Math.round((Math.abs(m - prev) / prev) * 100)}%`
        })
      }
      prev = m
    }
  }
  const first = weeks[0]?.start ?? 0
  for (const p of input.plans ?? []) {
    if (p.start <= first) continue
    const w = weekKey(p.start, tz, weekStart)
    markers.push({
      week: w,
      start: bucketRange(w, 'week', tz).start,
      kind: 'plan',
      label: `Plan: ${planLabel(p)}`
    })
  }
  markers.sort((a, b) => a.start - b.start)

  return {
    groupBy,
    weeks,
    groups,
    series,
    markers,
    versions: [...versions].sort(compareVersions),
    models: [...models].sort()
  }
}

// -------------------------------------------------------------- compare

export interface CompareSide {
  from?: number
  to?: number
  version?: string
  model?: string
}

export interface CompareRow {
  metric: MetricId
  a?: number
  b?: number
  /** (b − a) ÷ a, in %. */
  changePct?: number
}

export interface CompareResult {
  rows: CompareRow[]
  samples: {
    a: { responses: number; requests: number }
    b: { responses: number; requests: number }
  }
}

const inSide = (s: CompareSide, ts: number, model?: string, version?: string): boolean =>
  (s.from === undefined || ts >= s.from) &&
  (s.to === undefined || ts < s.to) &&
  (!s.version || version === s.version) &&
  (!s.model || model === s.model)

export function compareTrends(
  input: Pick<TrendsInput, 'records' | 'turns' | 'readings'>,
  a: CompareSide,
  b: CompareSide
): CompareResult {
  const side = (s: CompareSide): MetricAcc => {
    const acc = emptyAcc()
    for (const r of input.records) if (inSide(s, r.ts, r.model, r.version)) addRecordToAcc(acc, r)
    for (const t of input.turns) if (inSide(s, t.ts, t.model, t.version)) addTurnToAcc(acc, t)
    const last = new Map<string, BridgeReading>()
    for (const r of input.readings) {
      if (r.contextPct === undefined || !r.sessionId || !inSide(s, r.ts, r.model, r.version))
        continue
      const p = last.get(r.sessionId)
      if (!p || r.ts > p.ts) last.set(r.sessionId, r)
    }
    for (const r of last.values()) acc.contexts.push(r.contextPct!)
    return acc
  }
  const A = side(a)
  const B = side(b)
  return {
    rows: METRICS.map((m) => {
      const va = metricValue(A, m.id)
      const vb = metricValue(B, m.id)
      return {
        metric: m.id,
        a: va,
        b: vb,
        changePct:
          va !== undefined && vb !== undefined && va !== 0
            ? ((vb - va) / Math.abs(va)) * 100
            : undefined
      }
    }),
    samples: {
      a: { responses: A.records, requests: A.turns },
      b: { responses: B.records, requests: B.turns }
    }
  }
}
