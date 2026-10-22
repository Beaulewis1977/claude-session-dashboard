// Reading the status line payload that Claude Code passes to the bridge
// script (see https://code.claude.com/docs/en/statusline). Every field is
// optional: `rate_limits` only exists for Pro/Max subscribers after the first
// response, and its shape may change between versions.

export interface LimitWindow {
  /** 0–100 (can exceed 100 behind a spend-limit gateway). */
  pct: number
  /** Epoch ms. */
  resetsAt?: number
}

export interface BridgeReading {
  /** When the payload was captured (file time), epoch ms. */
  ts: number
  /** Source id of the Claude home it came from, e.g. "windows" or "wsl-Ubuntu-beau". */
  source: string
  sessionId?: string
  model?: string
  modelName?: string
  version?: string
  cwd?: string
  fiveHour?: LimitWindow
  sevenDay?: LimitWindow
  /** Session cost as estimated by Claude Code (`cost.total_cost_usd`). */
  costUsd?: number
  contextPct?: number
  contextSize?: number
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function finite(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * `resets_at` is documented as Unix epoch seconds. Accept milliseconds and
 * ISO strings too, in case a version changes it.
 */
export function parseResetsAt(v: unknown): number | undefined {
  if (typeof v === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  const n = finite(v)
  if (n === undefined || n <= 0) return undefined
  // Below 1e11 it can only be seconds (1e11 s is the year 5138).
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

function limitWindow(v: unknown): LimitWindow | undefined {
  const o = obj(v)
  if (!o) return undefined
  const pct = finite(o.used_percentage ?? o.usedPercentage ?? o.utilization)
  if (pct === undefined || pct < 0) return undefined
  return { pct: Math.min(pct, 1000), resetsAt: parseResetsAt(o.resets_at ?? o.resetsAt) }
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Parse one payload. Returns undefined when it isn't a JSON object at all. */
export function parseBridgePayload(
  raw: string | unknown,
  meta: { ts: number; source: string }
): BridgeReading | undefined {
  let json: unknown = raw
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch {
      return undefined
    }
  }
  const o = obj(json)
  if (!o) return undefined
  const r: BridgeReading = { ts: meta.ts, source: meta.source }
  const sid = text(o.session_id)
  if (sid && SESSION_ID_RE.test(sid)) r.sessionId = sid
  const model = obj(o.model)
  r.model = text(model?.id) ?? text(o.model)
  r.modelName = text(model?.display_name)
  r.version = text(o.version)
  r.cwd = text(obj(o.workspace)?.current_dir) ?? text(o.cwd)
  const rl = obj(o.rate_limits)
  if (rl) {
    r.fiveHour = limitWindow(rl.five_hour)
    r.sevenDay = limitWindow(rl.seven_day)
  }
  const cost = finite(obj(o.cost)?.total_cost_usd)
  if (cost !== undefined && cost >= 0) r.costUsd = cost
  const cw = obj(o.context_window)
  const ctx = finite(cw?.used_percentage)
  if (ctx !== undefined) r.contextPct = ctx
  const size = finite(cw?.context_window_size)
  if (size !== undefined) r.contextSize = size
  for (const k of Object.keys(r) as (keyof BridgeReading)[]) if (r[k] === undefined) delete r[k]
  return r
}

export type BillingGuess = 'subscription' | 'api' | 'unknown'

/**
 * For sessions launched outside the app: `rate_limits` means a Claude
 * subscription; a cost without `rate_limits` most likely means API billing.
 */
export function inferBilling(readings: BridgeReading[]): BillingGuess {
  if (readings.some((r) => r.fiveHour || r.sevenDay)) return 'subscription'
  if (readings.some((r) => r.costUsd !== undefined && r.costUsd > 0)) return 'api'
  return 'unknown'
}

/** Two readings carry the same limit information (used to avoid duplicate history lines). */
export function sameLimits(a: BridgeReading | undefined, b: BridgeReading): boolean {
  if (!a) return false
  const w = (x?: LimitWindow, y?: LimitWindow): boolean =>
    (!x && !y) || (!!x && !!y && x.pct === y.pct && x.resetsAt === y.resetsAt)
  return (
    a.source === b.source &&
    a.sessionId === b.sessionId &&
    w(a.fiveHour, b.fiveHour) &&
    w(a.sevenDay, b.sevenDay) &&
    a.costUsd === b.costUsd &&
    a.contextPct === b.contextPct
  )
}
