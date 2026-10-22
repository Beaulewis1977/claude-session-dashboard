// Live limit gauges, burn-rate projections and the implied-capacity
// ("did my limits get smaller?") estimate.

import type { BridgeReading, LimitWindow } from './bridge'
import type { EnvKind } from '../types'
import type { LimitHit, UsageBlock, UsageRecord } from './types'

export type Plan = 'pro' | 'max5' | 'max20' | 'api' | 'team'

export const PLAN_LABEL: Record<Plan, string> = {
  pro: 'Pro',
  max5: 'Max 5x',
  max20: 'Max 20x',
  api: 'API',
  team: 'Team / Enterprise'
}

export interface CapacityWeights {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** Output and cache writes cost more capacity than input and cache reads (API price ratios). */
export const DEFAULT_WEIGHTS: CapacityWeights = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1
}

export const FIVE_HOURS = 5 * 3_600_000
export const SEVEN_DAYS = 7 * 86_400_000

const PLANS: Plan[] = ['pro', 'max5', 'max20', 'api', 'team']

export function sanitizePlan(v: unknown): Plan | undefined {
  return PLANS.includes(v as Plan) ? (v as Plan) : undefined
}

export function sanitizeThresholds(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = [...new Set(v.filter((x): x is number => typeof x === 'number' && x > 0 && x <= 100))]
    .map((x) => Math.round(x))
    .sort((a, b) => a - b)
    .slice(0, 5)
  return out
}

export function sanitizeWeights(v: unknown): CapacityWeights | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const n = (x: unknown, d: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1000 ? x : d
  return {
    input: n(o.input, DEFAULT_WEIGHTS.input),
    output: n(o.output, DEFAULT_WEIGHTS.output),
    cacheWrite: n(o.cacheWrite, DEFAULT_WEIGHTS.cacheWrite),
    cacheRead: n(o.cacheRead, DEFAULT_WEIGHTS.cacheRead)
  }
}

export function weightedTokens(
  r: Pick<UsageRecord, 'input' | 'output' | 'cacheWrite' | 'cacheRead'>,
  w: CapacityWeights
): number {
  return (
    r.input * w.input +
    r.output * w.output +
    r.cacheWrite * w.cacheWrite +
    r.cacheRead * w.cacheRead
  )
}

export type WindowKind = 'five_hour' | 'seven_day'

export interface Projection {
  /** Usage grows by this many percentage points per hour. */
  pctPerHour: number
  /** When the window would reach 100% at this pace (epoch ms). */
  hitsLimitAt?: number
  /** The window resets before the limit would be reached. */
  safe: boolean
}

export interface GaugeState {
  kind: WindowKind
  pct: number
  resetsAt?: number
  /** Start of the window (resetsAt minus its length). */
  windowStart?: number
  /** Time of the reading. */
  updatedAt: number
  /** The window has already reset since the reading. */
  expired: boolean
  /** Tokens used in the window so far, from the session logs. */
  tokens: number
  weighted: number
  projection?: Projection
  sessionId?: string
  source: string
}

const windowLength = (k: WindowKind): number => (k === 'five_hour' ? FIVE_HOURS : SEVEN_DAYS)
const pick = (r: BridgeReading, k: WindowKind): LimitWindow | undefined =>
  k === 'five_hour' ? r.fiveHour : r.sevenDay

/**
 * Pace from the readings in the same window: a least-squares fit of % over
 * time, or (with one reading) the average pace since the window started.
 */
export function projectWindow(
  readings: BridgeReading[],
  kind: WindowKind,
  now: number
): Projection | undefined {
  const latest = latestReading(readings, kind)
  if (!latest) return undefined
  const w = pick(latest, kind)!
  if (!w.resetsAt) return undefined
  const sameWindow = readings
    .filter((r) => {
      const x = pick(r, kind)
      return x?.resetsAt && Math.abs(x.resetsAt - w.resetsAt!) < 120_000
    })
    .sort((a, b) => a.ts - b.ts)
  const start = w.resetsAt - windowLength(kind)
  // Recent pace matters most: use up to the last 90 minutes (5h) or 2 days (week).
  const horizon = kind === 'five_hour' ? 90 * 60_000 : 2 * 86_400_000
  const recent = sameWindow.filter((r) => r.ts >= latest.ts - horizon)
  let slope: number // pct per ms
  if (recent.length >= 2 && recent[recent.length - 1].ts - recent[0].ts > 5 * 60_000) {
    const xs = recent.map((r) => r.ts)
    const ys = recent.map((r) => pick(r, kind)!.pct)
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let num = 0
    let den = 0
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my)
      den += (xs[i] - mx) ** 2
    }
    slope = den ? num / den : 0
  } else {
    const elapsed = latest.ts - start
    slope = elapsed > 60_000 ? w.pct / elapsed : 0
  }
  const pctPerHour = Math.max(0, slope * 3_600_000)
  if (slope <= 0 || w.pct >= 100) {
    return { pctPerHour, safe: w.pct < 100, hitsLimitAt: w.pct >= 100 ? latest.ts : undefined }
  }
  const at = Math.max(now, latest.ts) + (100 - w.pct) / slope
  return { pctPerHour, hitsLimitAt: at, safe: at >= w.resetsAt }
}

export function latestReading(
  readings: BridgeReading[],
  kind: WindowKind
): BridgeReading | undefined {
  let best: BridgeReading | undefined
  for (const r of readings) if (pick(r, kind) && (!best || r.ts > best.ts)) best = r
  return best
}

export function gauge(
  readings: BridgeReading[],
  records: UsageRecord[],
  kind: WindowKind,
  now: number,
  weights: CapacityWeights,
  isSubscription: (key: string) => boolean = () => true
): GaugeState | undefined {
  const latest = latestReading(readings, kind)
  if (!latest) return undefined
  const w = pick(latest, kind)!
  const windowStart = w.resetsAt ? w.resetsAt - windowLength(kind) : undefined
  const expired = !!w.resetsAt && now >= w.resetsAt
  let tokens = 0
  let weighted = 0
  if (windowStart !== undefined && !expired) {
    for (const r of records) {
      if (r.ts < windowStart || r.ts > now || !isSubscription(r.key)) continue
      tokens += r.input + r.output + r.cacheWrite + r.cacheRead
      weighted += weightedTokens(r, weights)
    }
  }
  return {
    kind,
    pct: expired ? 0 : w.pct,
    resetsAt: w.resetsAt,
    windowStart,
    updatedAt: latest.ts,
    expired,
    tokens,
    weighted,
    projection: expired ? undefined : projectWindow(readings, kind, now),
    sessionId: latest.sessionId,
    source: latest.source
  }
}

// ---------------------------------------------------------- implied capacity

export interface CapacityPoint {
  /** Reading time. */
  ts: number
  kind: WindowKind
  pct: number
  weighted: number
  /** weighted ÷ (pct / 100): the window's estimated full size. */
  capacity: number
  /** Most-used model family in the window, e.g. "opus". */
  mix: string
}

function family(model: string): string {
  const m = /claude-(?:\d-\d-)?([a-z]+)/i.exec(model)
  return m ? m[1].toLowerCase() : model
}

/**
 * For each window, take its last reading (the highest %, so the least
 * rounding noise) and estimate the full capacity from the tokens used in it.
 * Readings under `minPct` are skipped because small percentages are too coarse.
 */
export function impliedCapacity(
  readings: BridgeReading[],
  records: UsageRecord[],
  kind: WindowKind,
  weights: CapacityWeights,
  opts: { minPct?: number; isSubscription?: (key: string) => boolean } = {}
): CapacityPoint[] {
  const minPct = opts.minPct ?? (kind === 'five_hour' ? 10 : 8)
  const isSub = opts.isSubscription ?? (() => true)
  const lastPerWindow = new Map<number, BridgeReading>()
  for (const r of readings) {
    const w = pick(r, kind)
    if (!w?.resetsAt || w.pct < minPct || w.pct > 100) continue
    const k = Math.round(w.resetsAt / 60_000)
    const prev = lastPerWindow.get(k)
    if (!prev || r.ts > prev.ts) lastPerWindow.set(k, r)
  }
  const sorted = [...records].sort((a, b) => a.ts - b.ts)
  const points: CapacityPoint[] = []
  for (const r of [...lastPerWindow.values()].sort((a, b) => a.ts - b.ts)) {
    const w = pick(r, kind)!
    const start = w.resetsAt! - windowLength(kind)
    let weighted = 0
    const mix = new Map<string, number>()
    for (const rec of sorted) {
      if (rec.ts < start) continue
      if (rec.ts > r.ts) break
      if (!isSub(rec.key)) continue
      const wt = weightedTokens(rec, weights)
      weighted += wt
      const f = family(rec.model)
      mix.set(f, (mix.get(f) ?? 0) + wt)
    }
    if (weighted <= 0) continue
    const top = [...mix.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
    points.push({
      ts: r.ts,
      kind,
      pct: w.pct,
      weighted,
      capacity: weighted / (w.pct / 100),
      mix: top
    })
  }
  return points
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface CapacityChange {
  kind: WindowKind
  /** Median capacity in the recent period and the comparison period. */
  recent: number
  before: number
  /** Negative = smaller now. */
  changePct: number
  samples: { recent: number; before: number }
  flagged: boolean
}

/**
 * Compare the last `recentDays` with the `beforeDays` before them. Flags a
 * change of at least `threshold` % with enough samples on both sides.
 */
export function detectCapacityChange(
  points: CapacityPoint[],
  now: number,
  opts: { recentDays?: number; beforeDays?: number; threshold?: number; minSamples?: number } = {}
): CapacityChange | undefined {
  const recentDays = opts.recentDays ?? 14
  const beforeDays = opts.beforeDays ?? 30
  const threshold = opts.threshold ?? 15
  const minSamples = opts.minSamples ?? 4
  if (!points.length) return undefined
  const kind = points[0].kind
  const cut = now - recentDays * 86_400_000
  const recent = points.filter((p) => p.ts >= cut && p.ts <= now).map((p) => p.capacity)
  const before = points
    .filter((p) => p.ts < cut && p.ts >= cut - beforeDays * 86_400_000)
    .map((p) => p.capacity)
  if (!recent.length || !before.length) return undefined
  const r = median(recent)
  const b = median(before)
  const changePct = ((r - b) / b) * 100
  return {
    kind,
    recent: r,
    before: b,
    changePct,
    samples: { recent: recent.length, before: before.length },
    flagged:
      Math.abs(changePct) >= threshold && recent.length >= minSamples && before.length >= minSamples
  }
}

/** Points where the limit-alert thresholds were first crossed in a window. */
export function crossedThresholds(
  prevPct: number | undefined,
  pct: number,
  thresholds: number[]
): number[] {
  return thresholds.filter((t) => pct >= t && (prevPct === undefined || prevPct < t))
}

// ------------------------------------------------------- state for the UI

export interface DiffLine {
  type: 'same' | 'add' | 'remove'
  text: string
}

/** One Claude home (Windows, or a WSL distro user) where the bridge can be enabled. */
export interface BridgeEnv {
  sourceId: string
  label: string
  env: EnvKind
  user?: string
  settingsPath: string
  bridgeDir: string
  installed: boolean
  installedAt?: string
  /** The status line command that the bridge passes the payload on to. */
  chained?: string
  lastReceivedAt?: number
  /** The bridge can't be managed right now (e.g. the distro isn't readable). */
  unavailable?: string
  /** statusLine was changed by someone else after the app installed the bridge. */
  changedSinceInstall?: boolean
}

export interface BridgePlan {
  sourceId: string
  action: 'install' | 'uninstall'
  label: string
  settingsPath: string
  createsFile: boolean
  diff: DiffLine[]
  /** Previous status line command that will be chained (install) or restored (uninstall). */
  chained?: string
  backupDir: string
  /** Opaque check that settings.json hasn't changed between preview and apply. */
  token: string
  error?: string
  /** Nothing to do (already installed / not installed). */
  noop?: boolean
}

export interface BridgeApplyResult {
  ok: boolean
  error?: string
  backupPath?: string
}

export interface LimitHitWithTokens extends LimitHit {
  windowTokens: number
}

export interface LimitsState {
  plan: Plan
  now: number
  hasBridgeData: boolean
  fiveHour?: GaugeState
  sevenDay?: GaugeState
  lastReadingAt?: number
  /** The newest reading is old: Claude Code hasn't run for a while. */
  stale: boolean
  envs: BridgeEnv[]
  /** Log-only estimate when there is no bridge data: the current 5-hour block. */
  block?: UsageBlock
  capacity5h: CapacityPoint[]
  capacity7d: CapacityPoint[]
  change5h?: CapacityChange
  change7d?: CapacityChange
  limitHits: LimitHitWithTokens[]
  alertsEnabled: boolean
  alertThresholds: number[]
  weights: CapacityWeights
}
