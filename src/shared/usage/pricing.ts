// API prices per model, in USD per million tokens. Used for cost estimates
// only. Fully editable in Settings.

export interface ModelPrice {
  /** Model id or id prefix, e.g. "claude-sonnet-4-5" matches "claude-sonnet-4-5-20250929". */
  model: string
  label: string
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

/** Date the defaults below were copied from Anthropic's published pricing page. */
export const PRICES_FILLED_IN = '2026-10-22'
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'

const p = (
  model: string,
  label: string,
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number
): ModelPrice => ({ model, label, input, output, cacheWrite5m, cacheWrite1h, cacheRead })

export const DEFAULT_PRICES: ModelPrice[] = [
  p('claude-fable-5-1', 'Claude Fable 5.1', 10, 12.5, 20, 0.25, 50),
  p('claude-mythos-5-1', 'Claude Mythos 5.1', 10, 12.5, 20, 0.25, 50),
  p('claude-fable-5', 'Claude Fable 5', 10, 12.5, 20, 1, 50),
  p('claude-mythos-5', 'Claude Mythos 5', 10, 12.5, 20, 1, 50),
  p('claude-opus-5-5', 'Claude Opus 5.5', 4, 5, 8, 0.2, 20),
  p('claude-opus-5', 'Claude Opus 5', 5, 6.25, 10, 0.5, 25),
  p('claude-opus-4-8', 'Claude Opus 4.8', 5, 6.25, 10, 0.5, 25),
  p('claude-opus-4-7', 'Claude Opus 4.7', 5, 6.25, 10, 0.5, 25),
  p('claude-opus-4-6', 'Claude Opus 4.6', 5, 6.25, 10, 0.5, 25),
  p('claude-opus-4-5', 'Claude Opus 4.5', 5, 6.25, 10, 0.5, 25),
  p('claude-opus-4-1', 'Claude Opus 4.1', 15, 18.75, 30, 1.5, 75),
  p('claude-opus-4', 'Claude Opus 4', 15, 18.75, 30, 1.5, 75),
  p('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 2.5, 4, 0.1, 10),
  p('claude-sonnet-5', 'Claude Sonnet 5', 2, 2.5, 4, 0.2, 10),
  p('claude-sonnet-4-6', 'Claude Sonnet 4.6', 3, 3.75, 6, 0.3, 15),
  p('claude-sonnet-4-5', 'Claude Sonnet 4.5', 3, 3.75, 6, 0.3, 15),
  p('claude-sonnet-4', 'Claude Sonnet 4', 3, 3.75, 6, 0.3, 15),
  p('claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.125, 0.2, 0.01, 0.5),
  p('claude-haiku-4-5', 'Claude Haiku 4.5', 1, 1.25, 2, 0.1, 5),
  p('claude-3-5-haiku', 'Claude Haiku 3.5', 0.8, 1, 1.6, 0.08, 4)
]

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
  const price = findPrice(r.model, table)
  if (!price) return 0
  const cw1h = Math.min(r.cw1h ?? 0, r.cacheWrite)
  const cw5 = r.cacheWrite - cw1h
  return (
    (r.input * price.input +
      r.output * price.output +
      cw5 * price.cacheWrite5m +
      cw1h * price.cacheWrite1h +
      r.cacheRead * price.cacheRead) /
    1_000_000
  )
}

/** Short, friendly model name: "claude-sonnet-4-5-20250929" → "Sonnet 4.5". */
export function modelLabel(model: string): string {
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
  for (const row of v.slice(0, 200)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const model = typeof r.model === 'string' ? r.model.trim().slice(0, 100) : ''
    if (!model) continue
    out.push({
      model,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 100) : model,
      input: n(r.input),
      output: n(r.output),
      cacheWrite5m: n(r.cacheWrite5m),
      cacheWrite1h: n(r.cacheWrite1h),
      cacheRead: n(r.cacheRead)
    })
  }
  return out
}
