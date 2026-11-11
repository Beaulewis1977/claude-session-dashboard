// API prices per model, in USD per million tokens. Used for cost estimates
// only. Pre-filled from a bundled snapshot of LiteLLM's price data (MIT, see
// THIRD_PARTY_NOTICES; refresh with scripts/make-price-snapshot.mjs). Prices
// are never fetched at runtime, and the table is fully editable in Settings.

import snapshot from './litellm-prices.json'
import openaiSnapshot from './openai-prices.json'

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

/**
 * Prices taken from the providers' own pricing pages, for models (and fast
 * modes) the bundled snapshots don't have yet. Never from third-party sites.
 */
export const OFFICIAL_PRICES_CHECKED = '2026-11-10'
export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
export const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing'

/** Anthropic's pricing page: rows the LiteLLM snapshot doesn't have. */
const OFFICIAL_CLAUDE_ROWS: SnapshotRow[] = [
  // Fast mode: $16 input / $80 output, 2x (caching multipliers apply on top).
  {
    model: 'claude-fable-5-2',
    input: 8,
    output: 40,
    cacheWrite5m: 10,
    cacheWrite1h: 16,
    cacheRead: 0.2,
    fast: 2
  },
  {
    model: 'claude-mythos-5-2',
    input: 8,
    output: 40,
    cacheWrite5m: 10,
    cacheWrite1h: 16,
    cacheRead: 0.2,
    fast: 2
  }
]

/**
 * OpenAI's pricing page: Fast mode (formerly Priority processing, which
 * Codex's /fast uses) as a multiple of Standard, the same for every token type.
 */
const OFFICIAL_CODEX_FAST: Record<string, number> = {
  'gpt-6.1-sol': 2,
  'gpt-6.1-terra': 2,
  'gpt-6-astra': 2,
  'gpt-6-sol': 2,
  'gpt-5.6-sol': 2,
  'gpt-5.6-terra': 2,
  'gpt-5.5': 2.5,
  'gpt-5.3-codex': 2
}

const snapshotIds = new Set((snapshot.models as SnapshotRow[]).map((r) => r.model))

export const DEFAULT_PRICES: ModelPrice[] = [
  ...OFFICIAL_CLAUDE_ROWS.filter((r) => !snapshotIds.has(r.model)),
  ...(snapshot.models as SnapshotRow[])
].map((r) => {
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

/** Date and source of the bundled OpenAI snapshot (Codex's price table). */
export const CODEX_PRICES_FILLED_IN: string = openaiSnapshot.date
export const CODEX_PRICES_COMMIT: string = openaiSnapshot.commit

/** "gpt-5.3-codex" → "GPT-5.3 Codex", "gpt-6.1-sol" → "GPT-6.1 Sol". */
export function openAiModelLabel(model: string): string | undefined {
  const m = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z0-9]+)*)$/i.exec(model)
  if (!m) return undefined
  const rest = m[2]
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return `GPT-${m[1]}${rest ? ` ${rest}` : ''}`
}

/** Codex's own price table: OpenAI's API prices (a separate table from Claude Code's). */
export const DEFAULT_CODEX_PRICES: ModelPrice[] = (openaiSnapshot.models as SnapshotRow[]).map(
  (r) => {
    const p: ModelPrice = {
      model: r.model,
      label: openAiModelLabel(r.model) ?? r.model,
      input: r.input,
      output: r.output,
      cacheWrite5m: r.cacheWrite5m,
      cacheWrite1h: r.cacheWrite1h,
      cacheRead: r.cacheRead
    }
    if (r.longContext) p.longContext = { ...r.longContext }
    const fast = OFFICIAL_CODEX_FAST[r.model]
    if (fast) p.fast = fast
    return p
  }
)

/** OpenAI rows ("gpt-5.6") match only their own id or a dated copy of it, never a sized variant ("gpt-5.6-luna"). */
const OPENAI_ROW = /^(?:gpt-|codex-|o\d)/
const DATE_SUFFIX = /^-(?:\d{4}-\d{2}-\d{2}|\d{8})$/
/** A newer minor version ("claude-fable-5" + "-2") is another model, never priced by the older row. */
const MINOR_VERSION = /^-\d{1,2}(?:$|[-@[])/

/**
 * findPrice's answers per table (tables are replaced, never edited in place,
 * when the prices change; a table whose length changed is looked up again).
 */
const priceMemo = new WeakMap<
  ModelPrice[],
  { length: number; byModel: Map<string, ModelPrice | undefined> }
>()

/** Find the price entry for a model id: exact match first, then the longest prefix. */
export function findPrice(model: string, table: ModelPrice[]): ModelPrice | undefined {
  let memo = priceMemo.get(table)
  if (!memo || memo.length !== table.length) {
    memo = { length: table.length, byModel: new Map() }
    priceMemo.set(table, memo)
  }
  if (memo.byModel.has(model)) return memo.byModel.get(model)
  const row = findPriceIn(model, table)
  memo.byModel.set(model, row)
  return row
}

function findPriceIn(model: string, table: ModelPrice[]): ModelPrice | undefined {
  const id = model.toLowerCase()
  let best: ModelPrice | undefined
  for (const row of table) {
    const m = row.model.toLowerCase()
    if (id === m) return row
    if (id.startsWith(m + '-') || id.startsWith(m + '@') || id.startsWith(m + '[')) {
      if (OPENAI_ROW.test(m) && !DATE_SUFFIX.test(id.slice(m.length))) continue
      if (MINOR_VERSION.test(id.slice(m.length))) continue
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

export interface CostParts {
  input: number
  output: number
  cacheRead: number
  /** 5-minute and 1-hour cache writes together. */
  cacheWrite: number
}

/** Estimated cost in USD per token type (all 0 when the model isn't in the table). */
export function costParts(r: CostInput, table: ModelPrice[]): CostParts {
  const fast = r.model.endsWith('-fast')
  const price = findPrice(fast ? r.model.slice(0, -5) : r.model, table)
  if (!price) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  // Long context: the whole request is billed at the higher tier.
  const lc = price.longContext
  const tier: PriceTier = lc && r.input + r.cacheWrite + r.cacheRead > lc.above ? lc : price
  const cw1h = Math.min(r.cw1h ?? 0, r.cacheWrite)
  const cw5 = r.cacheWrite - cw1h
  const m = (fast ? (price.fast ?? 1) : 1) / 1_000_000
  return {
    input: r.input * tier.input * m,
    output: r.output * tier.output * m,
    cacheRead: r.cacheRead * tier.cacheRead * m,
    cacheWrite: (cw5 * tier.cacheWrite5m + cw1h * tier.cacheWrite1h) * m
  }
}

/** Estimated cost in USD, or 0 when the model isn't in the table. */
export function estimateCost(r: CostInput, table: ModelPrice[]): number {
  // costParts' four amounts added in the same order (the same number to the
  // last bit), without making an object per record.
  const fast = r.model.endsWith('-fast')
  const price = findPrice(fast ? fastBase(r.model) : r.model, table)
  if (!price) return 0
  const lc = price.longContext
  const tier: PriceTier = lc && r.input + r.cacheWrite + r.cacheRead > lc.above ? lc : price
  const cw1h = Math.min(r.cw1h ?? 0, r.cacheWrite)
  const cw5 = r.cacheWrite - cw1h
  const m = (fast ? (price.fast ?? 1) : 1) / 1_000_000
  return (
    r.input * tier.input * m +
    r.output * tier.output * m +
    r.cacheRead * tier.cacheRead * m +
    (cw5 * tier.cacheWrite5m + cw1h * tier.cacheWrite1h) * m
  )
}

/** A fast-mode model id without its "-fast" (kept: one string per model, not per record). */
const fastBases = new Map<string, string>()
function fastBase(model: string): string {
  let b = fastBases.get(model)
  if (b === undefined) {
    b = model.slice(0, -5)
    if (fastBases.size >= 1000) fastBases.clear()
    fastBases.set(model, b)
  }
  return b
}

/** A record's cost: what Claude Code logged (old versions), else the estimate. */
export function recordCost(r: CostInput & { loggedCost?: number }, table: ModelPrice[]): number {
  return r.loggedCost ?? estimateCost(r, table)
}

/** Short, friendly model name: "claude-sonnet-4-5-20250929" → "Sonnet 4.5". */
export function modelLabel(model: string): string {
  if (model.endsWith('-fast')) return `${modelLabel(model.slice(0, -5))} · fast`
  const gpt = openAiModelLabel(model)
  if (gpt) return gpt
  const m = /^claude-(?:(\d)-(\d)-)?([a-z]+)(?:-(\d{1,2})(?!\d))?(?:-(\d)(?!\d))?/i.exec(model)
  if (!m) return model
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

/** Models seen in usage that have no row in the price table ("new model detected"). */
export function unpricedModels(models: Iterable<string>, table: ModelPrice[]): string[] {
  const out = new Set<string>()
  for (const m of models) {
    if (!m || m === 'unknown' || m.startsWith('<')) continue
    if (!findPrice(m.replace(/-fast$/, ''), table)) out.add(m)
  }
  return [...out].sort()
}

/** A fast-mode model id: Claude Code's `usage.speed: "fast"`, Codex's priority tier. */
export function isFastModel(model: string): boolean {
  return model.endsWith('-fast')
}

/**
 * Tables saved before the snapshot had no fast-mode or long-context prices:
 * add them from the defaults for the same model id, and add the officially
 * priced models (OFFICIAL_CLAUDE_ROWS) the table has no row for yet. Edited
 * values are kept.
 */
export function addSnapshotExtras(table: ModelPrice[]): ModelPrice[] {
  const have = new Set(table.map((p) => p.model.toLowerCase()))
  const official = new Set(OFFICIAL_CLAUDE_ROWS.map((r) => r.model))
  const added = DEFAULT_PRICES.filter(
    (d) => official.has(d.model) && !have.has(d.model.toLowerCase())
  ).map((d) => ({ ...d }))
  return [...added, ...fillExtras(table, DEFAULT_PRICES)]
}

/** Fast-mode multipliers and long-context prices from the defaults, where a saved row has none. */
export function fillExtras(table: ModelPrice[], defaults: ModelPrice[]): ModelPrice[] {
  return table.map((row) => {
    const d = defaults.find((p) => p.model === row.model)
    if (!d) return row
    const out = { ...row }
    if (out.fast === undefined && d.fast) out.fast = d.fast
    if (!out.longContext && d.longContext) out.longContext = { ...d.longContext }
    return out
  })
}
