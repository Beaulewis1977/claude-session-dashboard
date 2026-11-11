// Model performance trends ("is it nerfed?"). These are indicators only:
// they depend heavily on what you were working on, so the UI says so.

import type { BridgeReading } from './bridge'
import type { CapacityPoint } from './limits'
import { planLabel, type PlanSpan } from './health'
import { isFastModel, modelLabel } from './pricing'
import {
  CLAUDE_TTFT_CAVEAT,
  firstTokenMs,
  outputSpeed,
  SPEED_CAVEAT,
  speedMedian,
  ttftCoverage,
  ttftCoverageText,
  visibleSpeed
} from './speed'
import { bucketRange, weekKey } from './time'
import type { TurnSample, UsageRecord, WeekStart } from './types'

export type TrendGroupBy = 'all' | 'model' | 'version'

export type MetricId =
  | 'outputPerResponse'
  | 'outputPerTurn'
  | 'latency'
  | 'outputSpeed'
  | 'visibleSpeed'
  | 'firstToken'
  | 'outputSpeedFast'
  | 'firstTokenFast'
  | 'toolErrorRate'
  | 'apiErrorShare'
  | 'responsesPerTurn'
  | 'toolCallsPerTurn'
  | 'correctionRate'
  | 'cacheReadRatio'
  | 'thinkingPerResponse'
  | 'thinkingLength'
  | 'contextUsage'

/** A metric's definition (Claude Code's by default; Codex trends have their own ids). */
export interface MetricDef<M extends string = MetricId> {
  id: M
  title: string
  subtitle: string
  unit: 'tokens' | 'seconds' | 'percent' | 'count' | 'chars' | 'tps'
  /** Which direction is "better", for the compare table. */
  better: 'higher' | 'lower' | 'neutral'
  info?: string
  /** Only a row of the compare table (shown when it has data), never a chart. */
  compareOnly?: true
}

/** Speed metrics, shared by Claude Code's and Codex's trends (see speed.ts). */
export const OUTPUT_SPEED_DEF = {
  title: 'Output speed',
  subtitle: 'Median output tokens per second of each response (fast mode is its own line)',
  unit: 'tps',
  better: 'higher',
  info: SPEED_CAVEAT
} as const
export const FAST_SPEED_DEF = {
  title: 'Output speed · fast mode',
  subtitle: 'Median output tokens per second of fast-mode responses',
  unit: 'tps',
  better: 'higher',
  info: SPEED_CAVEAT,
  compareOnly: true
} as const

/** Which group a fast-mode response's speed goes to: its own line, never the normal baseline. */
export function speedGroup(by: TrendGroupBy, group: string, model: string | undefined): string {
  // By model, a fast-mode model ("…-fast") is a group of its own already.
  return by !== 'model' && model && isFastModel(model) ? `${group}|fast` : group
}

/** "Opus 5.5", "v2.1.30", "All", and "… · fast" for a fast-mode line. */
export function groupLabel(by: TrendGroupBy, key: string): string {
  if (key.endsWith('|fast')) return `${groupLabel(by, key.slice(0, -5))} · fast`
  return by === 'model' ? modelLabel(key) : by === 'version' ? `v${key}` : 'All'
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
  { id: 'outputSpeed', ...OUTPUT_SPEED_DEF },
  {
    id: 'visibleSpeed',
    title: 'Output speed without thinking',
    subtitle: 'Median tokens per second of each response, thinking tokens left out',
    unit: 'tps',
    better: 'higher',
    info: `The same responses and time as Output speed, counting only the tokens that aren’t thinking (Claude Code logs them apart). ${SPEED_CAVEAT}`
  },
  {
    id: 'firstToken',
    title: 'Time to first token (est.)',
    subtitle: 'Median time from sending a request to the start of its thinking',
    unit: 'seconds',
    better: 'lower',
    info: CLAUDE_TTFT_CAVEAT
  },
  { id: 'outputSpeedFast', ...FAST_SPEED_DEF },
  {
    id: 'firstTokenFast',
    title: 'Time to first token (est.) · fast mode',
    subtitle: 'Median estimated time to first token of fast-mode responses',
    unit: 'seconds',
    better: 'lower',
    info: CLAUDE_TTFT_CAVEAT,
    compareOnly: true
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
  /** Per response (normal mode, or a fast group's own), see speed.ts. */
  speeds: number[]
  visibleSpeeds: number[]
  ttfts: number[]
  /** Fast mode, for the compare table. */
  fastSpeeds: number[]
  fastTtfts: number[]
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
    contexts: [],
    speeds: [],
    visibleSpeeds: [],
    ttfts: [],
    fastSpeeds: [],
    fastTtfts: []
  }
}

/** The speed lists of a metric accumulator (Claude Code's or Codex's). */
export interface SpeedLists {
  speeds: number[]
  visibleSpeeds: number[]
  ttfts?: number[]
  fastSpeeds: number[]
  fastTtfts?: number[]
}

/**
 * A response's speed and (Claude Code) estimated time to first token. A
 * fast-mode one goes to the fast lists when `apart` (the compare table),
 * else to the normal ones (it's then in a fast group of its own, see
 * speedGroup), so it never moves a normal-mode median.
 */
export function addSpeedToAcc(a: SpeedLists, r: UsageRecord, apart: boolean): void {
  const v = outputSpeed(r)
  const t = firstTokenMs(r)
  if (apart && isFastModel(r.model)) {
    if (v !== undefined) a.fastSpeeds.push(v)
    if (t !== undefined) a.fastTtfts?.push(t)
    return
  }
  if (v !== undefined) {
    a.speeds.push(v)
    a.visibleSpeeds.push(visibleSpeed(r)!)
  }
  if (t !== undefined) a.ttfts?.push(t)
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
    case 'outputSpeed':
      return speedMedian(a.speeds)
    case 'visibleSpeed':
      return speedMedian(a.visibleSpeeds)
    case 'outputSpeedFast':
      return speedMedian(a.fastSpeeds)
    case 'firstToken':
    case 'firstTokenFast': {
      const m = speedMedian(id === 'firstToken' ? a.ttfts : a.fastTtfts)
      return m === undefined ? undefined : m / 1000
    }
  }
}

// --------------------------------------------------------------- weekly

export interface TrendPoint {
  week: string
  /** Week start, epoch ms. */
  start: number
  value?: number
}

export interface TrendSeries<M extends string = MetricId> {
  metric: M
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

export interface TrendsReport<M extends string = MetricId> {
  groupBy: TrendGroupBy
  weeks: { week: string; start: number }[]
  groups: { key: string; label: string; volume: number; provider?: 'claude' | 'codex' }[]
  series: TrendSeries<M>[]
  markers: TrendMarker[]
  versions: string[]
  models: string[]
  /** A note per metric, shown with its chart (e.g. how much of the data an estimate covers). */
  notes?: Partial<Record<M, string>>
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
    const sg = speedGroup(groupBy, g, r.model)
    addSpeedToAcc(acc(sg, w), r, false)
    if (sg !== g) volume.set(sg, (volume.get(sg) ?? 0) + 1)
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
  const groups = pickGroups(groupBy, volume, accs, input.maxGroups)

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
    // Fast mode isn't a new model.
    if (w === firstWeek || isFastModel(model)) continue
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

  const coverage = ttftCoverageText(ttftCoverage(input.records))
  return {
    groupBy,
    weeks,
    groups,
    series,
    markers,
    versions: [...versions].sort(compareVersions),
    models: [...models].sort(),
    ...(coverage ? { notes: { firstToken: coverage } } : {})
  }
}

/**
 * The groups that get a line: the busiest real groups (by responses), each
 * followed by its fast-mode line ("…|fast", speed metrics only) when it has
 * one. A fast-mode line never takes a real group's place.
 */
export function pickGroups<A>(
  groupBy: TrendGroupBy,
  volume: Map<string, number>,
  accs: Map<string, A>,
  maxGroups = 5
): { key: string; label: string; volume: number }[] {
  const sorted = [...volume.entries()].filter(([k]) => accs.has(k)).sort((a, b) => b[1] - a[1])
  const real = sorted.filter(([k]) => !k.endsWith('|fast'))
  const picked = groupBy === 'all' ? real.filter(([k]) => k === 'all') : real.slice(0, maxGroups)
  if (groupBy === 'all' && !picked.length && accs.has('all')) picked.push(['all', 0])
  const groups: { key: string; label: string; volume: number }[] = []
  for (const [key, v] of picked) {
    groups.push({ key, label: groupLabel(groupBy, key), volume: v })
    const fast = `${key}|fast`
    if (accs.has(fast))
      groups.push({ key: fast, label: groupLabel(groupBy, fast), volume: volume.get(fast) ?? 0 })
  }
  return groups
}

// -------------------------------------------------------------- compare

export interface CompareSide {
  from?: number
  to?: number
  version?: string
  model?: string
}

export interface CompareRow<M extends string = MetricId> {
  metric: M
  a?: number
  b?: number
  /** (b − a) ÷ a, in %. */
  changePct?: number
}

export interface CompareResult<M extends string = MetricId> {
  rows: CompareRow<M>[]
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
    for (const r of input.records)
      if (inSide(s, r.ts, r.model, r.version)) {
        addRecordToAcc(acc, r)
        addSpeedToAcc(acc, r, true)
      }
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
    rows: compareRows(METRICS, (id) => [metricValue(A, id), metricValue(B, id)]),
    samples: {
      a: { responses: A.records, requests: A.turns },
      b: { responses: B.records, requests: B.turns }
    }
  }
}

/** Compare rows for some metrics; a compare-only row is left out when neither side has data. */
export function compareRows<M extends string>(
  metrics: MetricDef<M>[],
  value: (id: M) => [number | undefined, number | undefined]
): CompareRow<M>[] {
  const rows: CompareRow<M>[] = []
  for (const m of metrics) {
    const [va, vb] = value(m.id)
    if (m.compareOnly && va === undefined && vb === undefined) continue
    rows.push({
      metric: m.id,
      a: va,
      b: vb,
      changePct:
        va !== undefined && vb !== undefined && va !== 0
          ? ((vb - va) / Math.abs(va)) * 100
          : undefined
    })
  }
  return rows
}
