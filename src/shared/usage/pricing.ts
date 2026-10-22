// API prices per model, in USD per million tokens. Used for cost estimates
// only. Pre-filled from a bundled snapshot of LiteLLM's price data (MIT, see
// THIRD_PARTY_NOTICES; refresh with scripts/make-price-snapshot.mjs). Prices
// are never fetched at runtime, and the table is fully editable in Settings.

import snapshot from './litellm-prices.json'

export interface PriceTier {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface ModelPrice extends PriceTier {
  /** Model id or id prefix, e.g. "claude-sonnet-4-5" matches "claude-sonnet-4-5-20250929". */
  model: string
  label: string
  /** Price multiplier for fast mode (`usage.speed: "fast"`). */
  fast?: number
  /** Requests with more input tokens than `above` are billed at these prices. */
  longContext?: PriceTier & { above: number }
}

/** Date of the bundled LiteLLM snapshot. */
export const PRICES_FILLED_IN: string = snapshot.date
export const PRICES_SOURCE: string = snapshot.source
export const PRICES_COMMIT: string = snapshot.commit

interface SnapshotRow extends PriceTier {
  model: string
  fast?: number
  longContext?: PriceTier & { above: number }
}

export const DEFAULT_PRICES: ModelPrice[] = (snapshot.models as SnapshotRow[]).map((r) => {
  const p: ModelPrice = {
    model: r.model,
    label: `Claude ${modelLabel(r.model)}${r.model.endsWith('-preview') ? ' Preview' : ''}`,
    input: r.input,
    output: r.output,
    cacheWrite5m: r.cacheWrite5m,
    cacheWrite1h: r.cacheWrite1h,
    cacheRead: r.cacheRead
  }
  if (r.fast) p.fast = r.fast
  if (r.longContext) p.longContext = { ...r.longContext }
  return p
})

/** Find the price entry for a model id: exact match first, then the longest prefix. */
export function findPrice(model: string, table: ModelPrice[]): ModelPrice | undefined {
  const id = model.toLowerCase()
  let best: ModelPrice | undefined
  for (const row of table) {
    const m = row.model.toLowerCase()
    if (id === m) return row
    if (id.startsWith(m + '-') || id.startsWith(m + '@') || id.startsWith(m + '[')) {
      if (!best || m.length > best.model.length) best = row
    }
  }
  return best
}

export interface CostInput {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cw1h?: number
}

/** Estimated cost in USD, or 0 when the model isn't in the table. */
export function estimateCost(r: CostInput, table: ModelPrice[]): number {
  const fast = r.model.endsWith('-fast')
  const price = findPrice(fast ? r.model.slice(0, -5) : r.model, table)
  if (!price) return 0
  // Long context: the whole request is billed at the higher tier.
  const lc = price.longContext
  const tier: PriceTier = lc && r.input + r.cacheWrite + r.cacheRead > lc.above ? lc : price
  const cw1h = Math.min(r.cw1h ?? 0, r.cacheWrite)
  const cw5 = r.cacheWrite - cw1h
  const usd =
    (r.input * tier.input +
      r.output * tier.output +
      cw5 * tier.cacheWrite5m +
      cw1h * tier.cacheWrite1h +
      r.cacheRead * tier.cacheRead) /
    1_000_000
  return fast ? usd * (price.fast ?? 1) : usd
}

/** A record's cost: what Claude Code logged (old versions), else the estimate. */
export function recordCost(r: CostInput & { loggedCost?: number }, table: ModelPrice[]): number {
  return r.loggedCost ?? estimateCost(r, table)
}

/** Short, friendly model name: "claude-sonnet-4-5-20250929" → "Sonnet 4.5". */
export function modelLabel(model: string): string {
  const m = /^claude-(?:(\d)-(\d)-)?([a-z]+)(?:-(\d{1,2})(?!\d))?(?:-(\d)(?!\d))?/i.exec(model)
  if (!m) return model
  if (model.endsWith('-fast')) return `${modelLabel(model.slice(0, -5))} (fast)`
  if (m[1]) return `${cap(m[3])} ${m[1]}.${m[2]}`
  const major = m[4]
  const minor = m[5]
  if (!major) return cap(m[3])
  return `${cap(m[3])} ${major}${minor ? `.${minor}` : ''}`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Validate a price table coming from the renderer or a settings file. */
export function sanitizePrices(v: unknown): ModelPrice[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ModelPrice[] = []
  const n = (x: unknown): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(x, 100_000) : 0
  const tier = (r: Record<string, unknown>): PriceTier => ({
    input: n(r.input),
    output: n(r.output),
    cacheWrite5m: n(r.cacheWrite5m),
    cacheWrite1h: n(r.cacheWrite1h),
    cacheRead: n(r.cacheRead)
  })
  for (const row of v.slice(0, 200)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const model = typeof r.model === 'string' ? r.model.trim().slice(0, 100) : ''
    if (!model) continue
    const price: ModelPrice = {
      model,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 100) : model,
      ...tier(r)
    }
    if (typeof r.fast === 'number' && Number.isFinite(r.fast) && r.fast > 0)
      price.fast = Math.min(r.fast, 100)
    const lc = r.longContext as Record<string, unknown> | undefined
    if (lc && typeof lc === 'object' && typeof lc.above === 'number' && lc.above > 0)
      price.longContext = { above: Math.round(lc.above), ...tier(lc) }
    out.push(price)
  }
  return out
}

/**
 * Tables saved before the snapshot had no fast-mode or long-context prices:
 * add them from the snapshot for the same model id. Edited values are kept.
 */
export function addSnapshotExtras(table: ModelPrice[]): ModelPrice[] {
  return table.map((row) => {
    const d = DEFAULT_PRICES.find((p) => p.model === row.model)
    if (!d) return row
    const out = { ...row }
    if (out.fast === undefined && d.fast) out.fast = d.fast
    if (!out.longContext && d.longContext) out.longContext = { ...d.longContext }
    return out
  })
}
