// Types for Phase 5: token usage, limits, credits and trends.

import type { EnvKind } from '../types'
import type { UsageCommandReading } from './usage-command'

export const TOKEN_TYPES = ['input', 'output', 'cacheWrite', 'cacheRead'] as const
export type TokenType = (typeof TOKEN_TYPES)[number]

export interface TokenCounts {
  input: number
  output: number
  /** All cache writes (5-minute + 1-hour). */
  cacheWrite: number
  cacheRead: number
}

/** One API response, counted once (deduped with ccusage's rules, see dedupe.ts). */
export interface UsageRecord extends TokenCounts {
  /** Dedupe key: `${message.id}:${requestId}`, or a fallback (see `recordId`). */
  id: string
  /** Epoch ms. */
  ts: number
  /** Session key in the app: `${sourceId}:${sessionId}`. */
  key: string
  project: string
  env: EnvKind
  model: string
  version?: string
  stop?: string
  /** Part of `cacheWrite` that went to the 1-hour cache, when reported. */
  cw1h?: number
  /** Other numeric usage fields, flattened (e.g. `server_tool_use.web_search_requests`). */
  extra?: Record<string, number>
  /** Cost Claude Code logged itself (`costUSD`, old versions only). Used instead of the estimate. */
  loggedCost?: number
  // Fields used only for deduplication:
  /** `message.id` */
  mid?: string
  /** `requestId` */
  rid?: string
  /** The entry's session id (its `sessionId` field, else the file's). */
  sid?: string
  /** The entry was logged as a sidechain (subagent or /btw). */
  sc?: true
  /** `usage.speed`, when present (e.g. "fast"). */
  speed?: string
  /** Other ids this response was logged under (copies that matched it). */
  aka?: string[]
  /** The app's own runs (summaries): when the run started; `ts` is when it finished. */
  startTs?: number
}

/** One user turn: a prompt and everything Claude did until the next prompt. */
export interface TurnSample {
  /** uuid of the user prompt event. */
  id: string
  ts: number
  key: string
  model?: string
  version?: string
  /** Time from the prompt to the first assistant event. */
  latencyMs?: number
  responses: number
  outputTokens: number
  inputTokens: number
  cacheReadTokens: number
  toolCalls: number
  toolResults: number
  toolErrors: number
  apiErrors: number
  thinkingBlocks: number
  thinkingChars: number
  /** The user interrupted Claude during this turn. */
  interrupted: boolean
  /** The prompt follows an interruption or starts with "no", "wrong", "that's not". */
  correction: boolean
}

/** A "usage limit reached" message found in a session. */
export interface LimitHit {
  id: string
  ts: number
  key: string
  text: string
  kind: 'five_hour' | 'weekly' | 'other'
  resetsAt?: number
}

export interface UsageAnalysis {
  records: UsageRecord[]
  turns: TurnSample[]
  limitHits: LimitHit[]
  /** Limit readings from /usage output recorded in the transcript. */
  usageReadings: UsageCommandReading[]
}

// --------------------------------------------------------------- reports

export type Period = 'hour' | 'day' | 'week' | 'month'
export type Dimension = 'model' | 'session' | 'project' | 'env' | 'version' | 'billing' | 'source'
export type WeekStart = 'monday' | 'sunday'

export interface UsageQuery {
  /** Epoch ms, inclusive. */
  from?: number
  /** Epoch ms, exclusive. */
  to?: number
  period: Period
  models?: string[]
  /** Dimension for the breakdown table. */
  groupBy?: Dimension
  sessionKey?: string
}

export interface Totals extends TokenCounts {
  total: number
  cost: number
  responses: number
}

export interface SeriesPoint extends Totals {
  /** Bucket key, e.g. "2026-10-22", "2026-10-19" (week start) or "2026-10". */
  bucket: string
  /** Bucket start, epoch ms (local time). */
  start: number
  byModel: Record<string, number>
}

export interface BreakdownRow extends Totals {
  key: string
  label: string
  detail?: string
  share: number
}

export interface PeriodCard {
  id: 'today' | 'week' | 'month' | 'all'
  label: string
  from: number
  to: number
  total: number
  cost: number
  prevTotal?: number
  /** Change vs. the previous period, in %. Undefined when there is no previous data. */
  deltaPct?: number
  spark: number[]
}

export interface UsageBlock extends Totals {
  start: number
  end: number
  lastActivity: number
  active: boolean
  models: string[]
}

export interface UsageReport {
  generatedAt: number
  timeZone: string
  weekStart: WeekStart
  /** True while the first full parse is still running. */
  loading: boolean
  firstRecordAt?: number
  lastRecordAt?: number
  models: string[]
  totals: Totals
  series: SeriesPoint[]
  breakdown: BreakdownRow[]
  byModel: BreakdownRow[]
  topSessions: BreakdownRow[]
  cards: PeriodCard[]
  blocks: UsageBlock[]
  /** Records for the raw table (most recent first, capped). */
  raw: UsageRecord[]
  extraFields: string[]
}

export interface SessionUsage extends Totals {
  key: string
  byModel: BreakdownRow[]
  firstAt?: number
  lastAt?: number
}

export interface UsageStatus {
  records: number
  files: number
  parsing: boolean
  lastUpdated?: number
}

export interface CcusageDay {
  date: string
  total: number
}

export interface CcusageComparison {
  available: boolean
  error?: string
  rows: { date: string; ours: number; theirs: number; diff: number }[]
}
