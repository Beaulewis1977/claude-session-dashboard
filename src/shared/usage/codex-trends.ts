// Codex trends ("is it nerfed?"), kept apart from Claude Code's (trends.ts).
// Indicators only: they depend heavily on what you were working on, so the
// UI says so. Built from Codex's own logs, never their text:
// - per response (token_count events, one usage record each): output and
//   reasoning tokens, and the share of input served from the cache;
// - per turn (task_started → task_complete / turn_aborted): how long it took,
//   time to first token, tool outcomes (finished tool items' status, else
//   exit codes in tool output), interruptions and errors;
// - per prompt I wrote (turns of the main thread started by my message):
//   responses and tool calls. A subagent's thread is left out here (its
//   "prompts" are the main agent's instructions) but counts per response;
// - context use: the last reading of each session in each week.

import { modelLabel } from './pricing'
import { bucketRange, weekKey } from './time'
import {
  compareVersions,
  type CompareResult,
  type CompareSide,
  type MetricDef,
  type TrendGroupBy,
  type TrendMarker,
  type TrendsReport
} from './trends'
import type { CodexTurnSample, UsageRecord, WeekStart } from './types'

export type CodexMetricId =
  | 'outputPerResponse'
  | 'reasoningPerResponse'
  | 'turnDuration'
  | 'firstToken'
  | 'toolErrorRate'
  | 'abortRate'
  | 'responsesPerPrompt'
  | 'toolCallsPerPrompt'
  | 'cachedInputRatio'
  | 'contextUsage'

export const CODEX_METRICS: MetricDef<CodexMetricId>[] = [
  {
    id: 'outputPerResponse',
    title: 'Output per response',
    subtitle: 'Average output tokens in each response (reasoning included)',
    unit: 'tokens',
    better: 'neutral',
    info: 'Shorter answers can mean less effort, or just simpler tasks.'
  },
  {
    id: 'reasoningPerResponse',
    title: 'Reasoning per response',
    subtitle: 'Average reasoning tokens in each response',
    unit: 'tokens',
    better: 'neutral',
    info: 'Depends on the reasoning effort you chose, as much as on the model.'
  },
  {
    id: 'turnDuration',
    title: 'Turn time',
    subtitle: 'Median time from the start of a turn to its end',
    unit: 'seconds',
    better: 'lower',
    info: 'From Codex’s own task_started and task_complete events. Long agentic turns take longer by design.'
  },
  {
    id: 'firstToken',
    title: 'Time to first token',
    subtitle: 'Median time until the first output of a turn',
    unit: 'seconds',
    better: 'lower'
  },
  {
    id: 'toolErrorRate',
    title: 'Tool error rate',
    subtitle: 'Share of tool calls that failed',
    unit: 'percent',
    better: 'lower',
    info: 'Newer Codex records each tool’s outcome; older versions only show a failing exit code in the output.'
  },
  {
    id: 'abortRate',
    title: 'Interrupted or failed turns',
    subtitle: 'Share of turns you interrupted, or that ended with an error',
    unit: 'percent',
    better: 'lower'
  },
  {
    id: 'responsesPerPrompt',
    title: 'Responses per prompt',
    subtitle: 'Model responses Codex needed for each message you sent',
    unit: 'count',
    better: 'neutral',
    info: 'Main threads only: a subagent’s work isn’t counted in the prompt that started it.'
  },
  {
    id: 'toolCallsPerPrompt',
    title: 'Tool calls per prompt',
    subtitle: 'Tools Codex used for each message you sent',
    unit: 'count',
    better: 'neutral',
    info: 'Main threads only, as above.'
  },
  {
    id: 'cachedInputRatio',
    title: 'Cached input ratio',
    subtitle: 'Share of input tokens served from the prompt cache',
    unit: 'percent',
    better: 'higher'
  },
  {
    id: 'contextUsage',
    title: 'Context window used',
    subtitle: 'Median context window use per session, from Codex’s token counts',
    unit: 'percent',
    better: 'neutral'
  }
]

/** Additive pieces of every Codex metric, so groups can be merged and compared. */
export interface CodexAcc {
  records: number
  output: number
  reasoning: number
  inputAll: number
  cached: number
  turns: number
  durations: number[]
  firstTokens: number[]
  toolResults: number
  toolErrors: number
  abortedOrFailed: number
  prompts: number
  promptResponses: number
  promptToolCalls: number
  contexts: number[]
}

export function emptyCodexAcc(): CodexAcc {
  return {
    records: 0,
    output: 0,
    reasoning: 0,
    inputAll: 0,
    cached: 0,
    turns: 0,
    durations: [],
    firstTokens: [],
    toolResults: 0,
    toolErrors: 0,
    abortedOrFailed: 0,
    prompts: 0,
    promptResponses: 0,
    promptToolCalls: 0,
    contexts: []
  }
}

/** Turns longer than this aren't response times (a turn left waiting for approval overnight). */
const MAX_TURN_MS = 2 * 3600_000

export function addCodexRecord(a: CodexAcc, r: UsageRecord): void {
  a.records++
  a.output += r.output
  a.reasoning += r.reasoning ?? 0
  a.inputAll += r.input + r.cacheRead + r.cacheWrite
  a.cached += r.cacheRead
}

export function addCodexTurn(a: CodexAcc, t: CodexTurnSample): void {
  a.turns++
  if (t.durationMs !== undefined && t.durationMs < MAX_TURN_MS && !t.aborted)
    a.durations.push(t.durationMs)
  if (t.firstTokenMs !== undefined && t.firstTokenMs < MAX_TURN_MS)
    a.firstTokens.push(t.firstTokenMs)
  a.toolResults += t.toolResults
  a.toolErrors += t.toolErrors
  if (t.aborted || t.failed) a.abortedOrFailed++
  if (t.prompted && !t.subagent) {
    a.prompts++
    a.promptResponses += t.responses
    a.promptToolCalls += t.toolCalls
  }
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Value of a Codex metric, or undefined when there's not enough data. */
export function codexMetricValue(a: CodexAcc, id: CodexMetricId): number | undefined {
  const div = (x: number, y: number, min = 1): number | undefined => (y >= min ? x / y : undefined)
  const pct = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * 100)
  const secs = (xs: number[]): number | undefined => {
    const m = xs.length >= 2 ? median(xs) : undefined
    return m === undefined ? undefined : m / 1000
  }
  switch (id) {
    case 'outputPerResponse':
      return div(a.output, a.records, 3)
    case 'reasoningPerResponse':
      return div(a.reasoning, a.records, 3)
    case 'turnDuration':
      return secs(a.durations)
    case 'firstToken':
      return secs(a.firstTokens)
    case 'toolErrorRate':
      return pct(div(a.toolErrors, a.toolResults, 3))
    case 'abortRate':
      return pct(div(a.abortedOrFailed, a.turns, 2))
    case 'responsesPerPrompt':
      return div(a.promptResponses, a.prompts, 2)
    case 'toolCallsPerPrompt':
      return div(a.promptToolCalls, a.prompts, 2)
    case 'cachedInputRatio':
      return pct(div(a.cached, a.inputAll, 1))
    case 'contextUsage':
      return median(a.contexts)
  }
}

export interface CodexTrendsInput {
  records: UsageRecord[]
  turns: CodexTurnSample[]
  timeZone: string
  weekStart: WeekStart
  groupBy: TrendGroupBy
  /** Only the busiest groups get their own line. */
  maxGroups?: number
}

export type CodexTrendsReport = TrendsReport<CodexMetricId>

const groupOf = (by: TrendGroupBy, model?: string, version?: string): string =>
  by === 'all' ? 'all' : by === 'model' ? (model ?? 'unknown') : (version ?? 'unknown')

/** The last context reading of each session in each week (by its turns). */
function lastContexts(
  turns: CodexTurnSample[],
  bucket: (t: CodexTurnSample) => string
): CodexTurnSample[] {
  const last = new Map<string, CodexTurnSample>()
  for (const t of turns) {
    if (t.contextPct === undefined) continue
    const k = `${t.key}|${bucket(t)}`
    const prev = last.get(k)
    if (!prev || t.ts > prev.ts) last.set(k, t)
  }
  return [...last.values()]
}

export function buildCodexTrends(input: CodexTrendsInput): CodexTrendsReport {
  const { timeZone: tz, weekStart, groupBy } = input
  const accs = new Map<string, Map<string, CodexAcc>>() // group → week → acc
  const volume = new Map<string, number>()
  const weekSet = new Set<string>()
  const acc = (group: string, week: string): CodexAcc => {
    let g = accs.get(group)
    if (!g) accs.set(group, (g = new Map()))
    let a = g.get(week)
    if (!a) g.set(week, (a = emptyCodexAcc()))
    weekSet.add(week)
    return a
  }
  const models = new Set<string>()
  const versions = new Set<string>()
  const firstModel = new Map<string, string>()
  const versionWeek = new Map<string, Map<string, number>>()
  const week = (ts: number): string => weekKey(ts, tz, weekStart)

  for (const r of input.records) {
    const w = week(r.ts)
    const g = groupOf(groupBy, r.model, r.version)
    addCodexRecord(acc(g, w), r)
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
  for (const t of input.turns)
    addCodexTurn(acc(groupOf(groupBy, t.model, t.version), week(t.ts)), t)
  for (const t of lastContexts(input.turns, (x) => week(x.ts)))
    acc(groupOf(groupBy, t.model, t.version), week(t.ts)).contexts.push(t.contextPct!)

  const weeks = [...weekSet]
    .sort()
    .map((w) => ({ week: w, start: bucketRange(w, 'week', tz).start }))
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

  const series: CodexTrendsReport['series'] = []
  for (const m of CODEX_METRICS)
    for (const g of groups) {
      const byWeek = accs.get(g.key)!
      series.push({
        metric: m.id,
        group: g.key,
        label: g.label,
        points: weeks.map((w) => {
          const a = byWeek.get(w.week)
          return { ...w, value: a ? codexMetricValue(a, m.id) : undefined }
        })
      })
    }

  // Markers: a model's first week, and a new Codex CLI version taking over.
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
      // Codex numbers releases 0.<minor>.<patch>: mark a new minor, or every change by version.
      const [a1, b1] = [prevDominant.split(/[.-]/), dominant.split(/[.-]/)]
      const big = a1[0] !== b1[0] || a1[1] !== b1[1]
      if (groupBy === 'version' || big)
        markers.push({ ...w, kind: 'version', label: `v${dominant}` })
    }
    prevDominant = dominant
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

const inSide = (s: CompareSide, ts: number, model?: string, version?: string): boolean =>
  (s.from === undefined || ts >= s.from) &&
  (s.to === undefined || ts < s.to) &&
  (!s.version || version === s.version) &&
  (!s.model || model === s.model)

export function compareCodexTrends(
  input: Pick<CodexTrendsInput, 'records' | 'turns'>,
  a: CompareSide,
  b: CompareSide
): CompareResult<CodexMetricId> {
  const side = (s: CompareSide): CodexAcc => {
    const acc = emptyCodexAcc()
    for (const r of input.records) if (inSide(s, r.ts, r.model, r.version)) addCodexRecord(acc, r)
    const turns = input.turns.filter((t) => inSide(s, t.ts, t.model, t.version))
    for (const t of turns) addCodexTurn(acc, t)
    for (const t of lastContexts(turns, () => '')) acc.contexts.push(t.contextPct!)
    return acc
  }
  const A = side(a)
  const B = side(b)
  return {
    rows: CODEX_METRICS.map((m) => {
      const va = codexMetricValue(A, m.id)
      const vb = codexMetricValue(B, m.id)
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
      a: { responses: A.records, requests: A.prompts },
      b: { responses: B.records, requests: B.prompts }
    }
  }
}
