// Codex usage and plan limits (docs/ROADMAP.md, feature 5, Phase C).
//
// Everything comes from Codex's own session logs (rollouts): every
// `event_msg` / `token_count` line carries the token usage of one model
// response (`info.last_token_usage`, plus the running `total_token_usage`)
// and, for a ChatGPT sign-in, the plan limits (`rate_limits`). Never from
// auth.json or any OpenAI / ChatGPT endpoint.
//
// Limits: `rate_limits.primary` and `.secondary` are windows of
// `window_minutes` minutes. Which one is the 5-hour window and which the
// weekly one is read from `window_minutes`, never from the slot: newer Codex
// reports the weekly window as `primary` (and no 5-hour window at all on
// plans that don't have one). Other `limit_id`s are separate limits (e.g. one
// model's own limit, with a `limit_name`).

import type { BridgeReading, LimitWindow } from './bridge'
import type {
  CapacityChange,
  CapacityPoint,
  GaugeState,
  LimitHitWithTokens,
  WindowKind
} from './limits'
import type { HealthReport, PlanSpan, WindowSplit } from './health'
import type { PaceAdvice, PaceState } from './pace'

// ------------------------------------------------------------- readings

export interface CodexLimitWindow {
  /** 0–100 (`used_percent`). */
  pct: number
  /** Window length (`window_minutes`). */
  minutes: number
  /** Epoch ms (`resets_at`, epoch seconds in the log). */
  resetsAt?: number
}

/** One `rate_limits` reading from a rollout. */
export interface CodexLimitReading {
  /** Same identity as the event's usage record (copies in forks share it), see codexEventId. */
  id: string
  ts: number
  /** Session key in the app. */
  key: string
  /** Source id of the Codex home. */
  source: string
  sessionId?: string
  /** `limit_id` ("codex" when not given). */
  limitId: string
  /** `limit_name`, e.g. "GPT-5.3-Codex-Spark". */
  limitName?: string
  /** `plan_type` as Codex wrote it, e.g. "plus", "prolite". */
  planType?: string
  windows: CodexLimitWindow[]
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string }
  /** `rate_limit_reached_type`, when Codex says a limit was hit. */
  reached?: string
}

/** The main limit's id. */
export const MAIN_LIMIT_ID = 'codex'

export const FIVE_HOUR_MINUTES = 300
export const WEEK_MINUTES = 10_080

/** The app's window kind for a window length, only for the exact 5-hour and 7-day lengths. */
export function windowKindOf(minutes: number): WindowKind | undefined {
  if (minutes === FIVE_HOUR_MINUTES) return 'five_hour'
  if (minutes === WEEK_MINUTES) return 'seven_day'
  return undefined
}

/** "5-hour window", "Weekly", or the length it really has ("2-hour window", "30-day window"). */
export function windowLabel(minutes: number): string {
  if (minutes === FIVE_HOUR_MINUTES) return '5-hour window'
  if (minutes === WEEK_MINUTES) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`
  return `${minutes}-minute window`
}

/** A limit's name for the UI: its `limit_name`, else its id. */
export function limitLabel(r: Pick<CodexLimitReading, 'limitId' | 'limitName'>): string {
  if (r.limitId === MAIN_LIMIT_ID) return 'Codex'
  return r.limitName ?? r.limitId
}

/**
 * Readings of one limit as status line readings, so the gauges, pace,
 * implied capacity and limit health work for Codex exactly as for Claude.
 * Only the exact 5-hour and 7-day windows map; other lengths stay Codex-only.
 */
export function asBridgeReadings(
  readings: CodexLimitReading[],
  limitId = MAIN_LIMIT_ID
): BridgeReading[] {
  const out: BridgeReading[] = []
  for (const r of readings) {
    if (r.limitId !== limitId) continue
    const b: BridgeReading = { ts: r.ts, source: r.source }
    if (r.sessionId) b.sessionId = r.sessionId
    for (const w of r.windows) {
      const kind = windowKindOf(w.minutes)
      if (!kind) continue
      const lw: LimitWindow = { pct: w.pct, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) }
      if (kind === 'five_hour') b.fiveHour = lw
      else b.sevenDay = lw
    }
    if (b.fiveHour || b.sevenDay) out.push(b)
  }
  return out
}

// ----------------------------------------------------------------- plans

export type CodexPlan =
  'free' | 'go' | 'plus' | 'pro100' | 'pro200' | 'pro500' | 'business' | 'enterprise' | 'edu'

export const CODEX_PLANS: CodexPlan[] = [
  'plus',
  'pro100',
  'pro200',
  'pro500',
  'business',
  'enterprise',
  'edu',
  'go',
  'free'
]

export const CODEX_PLAN_LABEL: Record<CodexPlan, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro100: 'Pro $100',
  pro200: 'Pro $200',
  pro500: 'Pro $500',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu'
}

/**
 * Limit size relative to Plus. OpenAI publishes no multipliers: Business and
 * Enterprise/Edu without flexible pricing get about Plus-level limits per
 * seat; the Pro values are guesses. All editable in Settings.
 */
export const DEFAULT_CODEX_MULT: Record<CodexPlan, number> = {
  free: 1,
  go: 1,
  plus: 1,
  pro100: 5,
  pro200: 10,
  pro500: 25,
  business: 1,
  enterprise: 1,
  edu: 1
}

/**
 * The plan behind a `plan_type` code. "prolite" is taken to be the $100 Pro
 * tier (Pro has no 5-hour limit, which matches the logs) and "pro" the $200
 * one: an inference, so the raw code is always shown next to the label.
 */
export function planOfCode(code: string | undefined): CodexPlan | undefined {
  switch ((code ?? '').toLowerCase()) {
    case 'plus':
      return 'plus'
    case 'prolite':
    case 'pro_lite':
      return 'pro100'
    case 'pro':
      return 'pro200'
    case 'team':
    case 'business':
      return 'business'
    case 'enterprise':
      return 'enterprise'
    case 'edu':
    case 'education':
      return 'edu'
    case 'go':
      return 'go'
    case 'free':
      return 'free'
    default:
      return undefined
  }
}

/** "Pro $100 (prolite)": the label with the raw code it was inferred from. */
export function codeLabel(code: string): string {
  const p = planOfCode(code)
  return p ? `${CODEX_PLAN_LABEL[p]} (${code})` : `Unknown plan (${code})`
}

export type CodexPlanSetting = 'auto' | CodexPlan

export function isCodexPlan(v: unknown): v is CodexPlan {
  return typeof v === 'string' && (CODEX_PLANS as string[]).includes(v)
}

export function sanitizeCodexPlan(v: unknown): CodexPlanSetting | undefined {
  return v === 'auto' || isCodexPlan(v) ? v : undefined
}

export function sanitizeCodexMults(v: unknown): Partial<Record<CodexPlan, number>> | undefined {
  if (!v || typeof v !== 'object') return undefined
  const out: Partial<Record<CodexPlan, number>> = {}
  for (const p of CODEX_PLANS) {
    const x = (v as Record<string, unknown>)[p]
    if (typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 1000) out[p] = x
  }
  return out
}

export function codexMult(plan: CodexPlan, mults?: Partial<Record<CodexPlan, number>>): number {
  return mults?.[plan] ?? DEFAULT_CODEX_MULT[plan]
}

/** A plan change seen in the logs: the first reading with a new `plan_type`. */
export interface DetectedPlanChange {
  ts: number
  code: string
}

/** When `plan_type` changed, from readings sorted by time (readings without one are skipped). */
export function detectPlanChanges(readings: CodexLimitReading[]): DetectedPlanChange[] {
  const out: DetectedPlanChange[] = []
  for (const r of readings) {
    if (!r.planType) continue
    if (out[out.length - 1]?.code !== r.planType) out.push({ ts: r.ts, code: r.planType })
  }
  return out
}

function ymdOf(ts: number): string {
  const x = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Plans over time for Codex's limit health. "auto": the plan types the logs
 * show, from the day each first appeared (the first one also before it).
 * A chosen plan: that plan everywhere.
 */
export function codexPlanSpans(
  setting: CodexPlanSetting,
  changes: DetectedPlanChange[],
  mults?: Partial<Record<CodexPlan, number>>
): PlanSpan[] {
  if (setting !== 'auto') {
    return [
      {
        from: '1970-01-01',
        plan: 'custom',
        label: CODEX_PLAN_LABEL[setting],
        mult: codexMult(setting, mults),
        start: 0
      }
    ]
  }
  if (!changes.length)
    return [
      {
        from: '1970-01-01',
        plan: 'custom',
        label: 'Plus',
        mult: codexMult('plus', mults),
        start: 0
      }
    ]
  const spans: PlanSpan[] = []
  for (const c of changes) {
    const plan = planOfCode(c.code)
    const span: PlanSpan = {
      // The first plan also applies before it was seen (start 0); its date is when it was.
      from: ymdOf(c.ts),
      plan: 'custom',
      label: codeLabel(c.code),
      mult: plan ? codexMult(plan, mults) : 1,
      start: spans.length ? dayStart(c.ts) : 0
    }
    // Two changes on one day: the later one wins.
    if (spans.length && spans[spans.length - 1].start === span.start) spans[spans.length - 1] = span
    else spans.push(span)
  }
  return spans
}

// ----------------------------------------------------------------- state

export interface CodexWindowGauge {
  minutes: number
  label: string
  gauge: GaugeState
}

/** A limit other than the main one (another `limit_id`, e.g. one model's own limit). */
export interface CodexLimitBucket {
  limitId: string
  label: string
  windows: CodexWindowGauge[]
  lastAt: number
  /** Read in the last 30 days: shown as a small gauge (else listed under "Other limits"). */
  recent: boolean
}

/** Extra limits with a reading this recent get their own small gauge. */
export const RECENT_LIMIT_MS = 30 * 86_400_000

export interface CodexPlanInfo {
  setting: CodexPlanSetting
  /** The plan in force now (chosen, or detected). */
  plan?: CodexPlan
  /** "Pro $100 (prolite)", "Plus", … */
  label: string
  mult: number
  /** The newest `plan_type` in the logs, and when it was seen. */
  detectedCode?: string
  detectedAt?: number
  /** When the detected plan started (the first reading with it). */
  detectedSince?: number
  changes: DetectedPlanChange[]
}

export interface CodexLimitsState {
  provider: 'codex'
  now: number
  plan: CodexPlanInfo
  /** Any rate limit reading at all. */
  hasData: boolean
  /** The main limit's 5-hour and weekly windows, by `window_minutes`. */
  fiveHour?: GaugeState
  sevenDay?: GaugeState
  /** Codex reported a 5-hour window in the last 30 days (plans without one, e.g. Pro, don't). */
  fiveHourRecent: boolean
  /** The main limit's windows of other lengths. */
  otherWindows: CodexWindowGauge[]
  extraLimits: CodexLimitBucket[]
  lastLimitAt?: number
  stale: boolean
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string; at: number }
  health5h?: HealthReport
  health7d?: HealthReport
  pace5h?: PaceState
  pace7d?: PaceState
  advice?: PaceAdvice
  split5h?: WindowSplit
  split7d?: WindowSplit
  capacity5h: CapacityPoint[]
  capacity7d: CapacityPoint[]
  change5h?: CapacityChange
  change7d?: CapacityChange
  /** Readings where Codex said a limit was reached. */
  limitHits: LimitHitWithTokens[]
  alertsEnabled: boolean
  alertThresholds: number[]
  readings: number
  /** Every model in Codex's usage (for "new model detected"). */
  models: string[]
}

/** Codex's own refresh hint (its limits come with each reply). */
export const CODEX_REFRESH_HINT = 'Send one message in Codex to refresh.'
export const CODEX_LIVE_NOTE =
  'Codex writes your plan limits into its session logs with each reply, so they show here without any setup.'

/** Why a Codex window has no current reading, or undefined if it has one. */
export function codexWhyNoReading(
  l: Pick<CodexLimitsState, 'hasData' | 'fiveHour' | 'sevenDay' | 'fiveHourRecent'>,
  kind: WindowKind,
  asOf: (ts: number) => string
): string | undefined {
  const g = kind === 'five_hour' ? l.fiveHour : l.sevenDay
  if (g && !g.expired) return undefined
  if (!l.hasData)
    return `No Codex session has recorded plan limits yet (they appear with a ChatGPT sign-in). ${CODEX_REFRESH_HINT}`
  if (!g)
    return kind === 'five_hour'
      ? "Codex hasn't reported a 5-hour window. Some plans (e.g. Pro) have none."
      : "Codex hasn't reported a weekly window yet."
  return `No reading since ${asOf(g.updatedAt)}, before this window started. ${CODEX_REFRESH_HINT}`
}
