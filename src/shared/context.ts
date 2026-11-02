// Context size of a session, and what resuming it would cost.
//
// The size is what Claude Code sends with the session's next message: the
// last main-thread reply's input + cache read + cache creation tokens (a
// subagent's turns are its own context). After a compaction with no reply
// since, the size is estimated from the compaction summary. A newer status
// line reading (context_window) wins over the file.
//
// Resuming sends that whole context again. Cold, it is written to the prompt
// cache (cache-write price); while the cache from the last reply may still be
// alive it is read from it (cache-read price). The dollar figure (API list
// price) becomes a share of the 5-hour window through the limit-health
// baseline ($ per 1%), or this window's own % per weighted token of
// subscription use. Neither known: tokens only.

import type { RawEvent } from './jsonl'
import { weightedTokens, type CapacityWeights } from './usage/limits'
import { estimateCost, findPrice, type ModelPrice } from './usage/pricing'
import type { UsageRecord } from './usage/types'

// ------------------------------------------------------------------- types

export type CacheTtl = '5m' | '1h'

/** A session's context size, read from its file (and the status line). */
export interface SessionContext {
  /** Tokens in context at the end of the session. */
  tokens: number
  /**
   * `usage`: the last reply's usage; `compaction`: estimated after a
   * compaction with no reply since; `status-line`: Claude Code's status line.
   */
  from: 'usage' | 'compaction' | 'status-line'
  /** When that size was seen (ISO). */
  at?: string
  /** Model of the last reply. */
  model?: string
  /** The model's context window, when the status line reported it. */
  windowSize?: number
  /** How often the conversation was compacted. */
  compactions: number
  /** Context size right before the latest compaction (Claude Code's `preTokens`). */
  preCompactTokens?: number
  /** The session's fixed setup (system prompt, tools, first prompt): its first reply's input. */
  baseTokens?: number
  /** Which prompt cache the session wrote to (from its own usage lines). */
  cacheTtl?: CacheTtl
  /** Time of the last main-thread reply (ISO): its cache may still be warm. */
  lastReplyAt?: string
}

// ----------------------------------------------------------------- reading

/** Setup tokens assumed when a session has no first reply to measure (system prompt + tools). */
export const DEFAULT_BASE_TOKENS = 20_000
/** Rough characters per token for English text and code. */
export const CHARS_PER_TOKEN = 4

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function validTs(v: unknown): string | undefined {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      const o = obj(b)
      return o?.type === 'text' && typeof o.text === 'string' ? o.text : ''
    })
    .join('\n')
}

/** Context tokens of one reply's usage: input + cache read + cache creation. */
export function usageContextTokens(usage: unknown): { tokens: number; ttl?: CacheTtl } {
  const u = obj(usage)
  if (!u) return { tokens: 0 }
  const cc = obj(u.cache_creation)
  const cw5 = num(cc?.ephemeral_5m_input_tokens)
  const cw1h = num(cc?.ephemeral_1h_input_tokens)
  const write = cc && cw5 + cw1h > 0 ? cw5 + cw1h : num(u.cache_creation_input_tokens)
  const tokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + write
  const ttl: CacheTtl | undefined = cw1h > 0 ? '1h' : cw5 > 0 ? '5m' : undefined
  return { tokens, ttl }
}

/**
 * The context size from a session's events. Undefined when no reply carries
 * usage (very old files, or nothing answered yet) and nothing was compacted.
 */
export function analyzeContext(events: RawEvent[]): SessionContext | undefined {
  let last: { tokens: number; at?: string; model?: string } | undefined
  let base: number | undefined
  let ttl: CacheTtl | undefined
  let compactions = 0
  let preCompact: number | undefined
  let compactAt: string | undefined
  // A compaction with no reply after it yet, and the size of its summary.
  let compactedSinceReply = false
  let summaryChars = 0
  let lastTs: string | undefined

  for (const e of events) {
    const ts = validTs(e.timestamp)
    if (ts) lastTs = ts
    if (e.isSidechain === true) continue
    const type = text(e.type)
    if (type === 'system' && e.subtype === 'compact_boundary') {
      compactions++
      const pre = num(obj(e.compactMetadata)?.preTokens)
      preCompact = pre || preCompact
      compactedSinceReply = true
      summaryChars = 0
      compactAt = ts ?? lastTs
      continue
    }
    const msg = obj(e.message)
    if (type === 'user' && e.isCompactSummary === true) {
      // Older versions wrote only the summary, without a boundary entry.
      if (!compactedSinceReply) {
        compactions++
        compactAt = ts ?? lastTs
      }
      compactedSinceReply = true
      summaryChars = blocksText(msg?.content ?? e.content).length
      continue
    }
    if (type !== 'assistant' || !msg) continue
    const model = text(msg.model)
    if (model === '<synthetic>') continue
    const u = usageContextTokens(msg.usage)
    if (u.ttl) ttl = u.ttl
    if (!u.tokens) continue
    // Streamed parts of one reply repeat its usage: the last one wins.
    last = { tokens: u.tokens, at: ts, model: model ?? last?.model }
    if (base === undefined) base = u.tokens
    compactedSinceReply = false
  }

  if (!last && !compactions) return undefined
  const common = {
    compactions,
    ...(preCompact ? { preCompactTokens: preCompact } : {}),
    ...(base !== undefined ? { baseTokens: base } : {}),
    ...(ttl ? { cacheTtl: ttl } : {}),
    ...(last?.model ? { model: last.model } : {})
  }
  if (compactedSinceReply || !last) {
    // The new context is the setup plus the summary; nothing of it is cached yet.
    return {
      tokens: (base ?? DEFAULT_BASE_TOKENS) + Math.ceil(summaryChars / CHARS_PER_TOKEN),
      from: 'compaction',
      at: compactAt,
      ...common
    }
  }
  return { tokens: last.tokens, from: 'usage', at: last.at, lastReplyAt: last.at, ...common }
}

/** A status line reading of a session's context window. */
export interface StatusContext {
  /** `used_percentage` (0–100). */
  pct: number
  /** `context_window_size`. */
  size?: number
  /** Epoch ms. */
  ts: number
}

/**
 * Add the status line's reading: its window size always (the real one, e.g.
 * 1M), its token count when it is newer than the file's.
 */
export function withStatusLine(
  ctx: SessionContext | undefined,
  st: StatusContext | undefined
): SessionContext | undefined {
  if (!st) return ctx
  const size = st.size && st.size > 0 ? st.size : undefined
  const tokens = size ? Math.round((Math.max(0, st.pct) / 100) * size) : undefined
  const fileAt = ctx?.at ? Date.parse(ctx.at) : -Infinity
  if (!ctx) {
    if (!tokens) return undefined
    return {
      tokens,
      from: 'status-line',
      at: new Date(st.ts).toISOString(),
      windowSize: size,
      compactions: 0
    }
  }
  const out: SessionContext = { ...ctx, ...(size ? { windowSize: size } : {}) }
  if (tokens && st.ts > fileAt) {
    out.tokens = tokens
    out.from = 'status-line'
    out.at = new Date(st.ts).toISOString()
  }
  return out
}

// ------------------------------------------------------------ size and band

export const STANDARD_WINDOW = 200_000
export const LONG_WINDOW = 1_000_000

/** The model's context window: the status line's, else 1M for `[1m]` models or a context past 200k. */
export function contextWindowSize(ctx: SessionContext, launchModel?: string): number {
  if (ctx.windowSize) return ctx.windowSize
  const m = `${launchModel ?? ''} ${ctx.model ?? ''}`.toLowerCase()
  if (m.includes('[1m]') || ctx.tokens > STANDARD_WINDOW) return LONG_WINDOW
  return STANDARD_WINDOW
}

export type SizeBand = 'S' | 'M' | 'L' | 'XL'

export const BAND_LIMITS: { band: SizeBand; below: number }[] = [
  { band: 'S', below: 40_000 },
  { band: 'M', below: 100_000 },
  { band: 'L', below: 150_000 }
]

export function sizeBand(tokens: number): SizeBand {
  for (const b of BAND_LIMITS) if (tokens < b.below) return b.band
  return 'XL'
}

// ----------------------------------------------------------------- settings

export interface ContextWarningSettings {
  /** Warn in the Resume dialog before reloading a large session. */
  enabled: boolean
  /** Warn from this many tokens. */
  thresholdTokens: number
}

export const DEFAULT_CONTEXT_WARNING: ContextWarningSettings = {
  enabled: true,
  thresholdTokens: 150_000
}

export const MIN_THRESHOLD = 10_000
export const MAX_THRESHOLD = 2_000_000

export function sanitizeContextWarning(v: unknown): ContextWarningSettings {
  const o = obj(v) ?? {}
  const t = o.thresholdTokens
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_CONTEXT_WARNING.enabled,
    thresholdTokens:
      typeof t === 'number' && Number.isFinite(t)
        ? Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(t)))
        : DEFAULT_CONTEXT_WARNING.thresholdTokens
  }
}

/** Warn before this launch? Only for Resume, above the threshold, unless turned off. */
export function shouldWarn(i: {
  kind: 'resume' | 'fork' | 'branch' | 'continue' | 'new'
  tokens?: number
  settings: ContextWarningSettings
  /** "Don't warn for this session". */
  sessionOff?: boolean
}): boolean {
  return (
    i.kind === 'resume' &&
    i.settings.enabled &&
    !i.sessionOff &&
    i.tokens !== undefined &&
    i.tokens >= i.settings.thresholdTokens
  )
}

// ----------------------------------------------------------------- estimate

const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

/**
 * The prompt cache from the last reply may still be alive: the session's own
 * cache lifetime (5 minutes when its usage doesn't say) has not run out, the
 * size was read from that reply, and the launch uses the same model.
 */
export function warmUntil(
  ctx: SessionContext,
  now: number,
  samePriceModel = true
): number | undefined {
  if (!ctx.lastReplyAt || ctx.from === 'compaction' || !samePriceModel) return undefined
  const until = Date.parse(ctx.lastReplyAt) + TTL_MS[ctx.cacheTtl ?? '5m']
  return until > now ? until : undefined
}

const ALIASES: Record<string, string> = { opusplan: 'opus', best: 'opus' }

/** The model id to price a launch with: its model choice, else the session's own model, else Opus. */
export function priceModelId(
  choice: string | undefined,
  sessionModel: string | undefined,
  prices: ModelPrice[]
): string {
  const c = (choice ?? '').toLowerCase().replace(/\[1m\]$/, '')
  const family = ALIASES[c] ?? c
  if (c && c !== 'default') {
    if (/^(?:opus|sonnet|haiku|fable|mythos)$/.test(family))
      return (
        prices.find((p) => p.model.toLowerCase().includes(`-${family}`))?.model ??
        `claude-${family}`
      )
    return c
  }
  if (sessionModel) return sessionModel
  return prices.find((p) => p.model.toLowerCase().includes('-opus'))?.model ?? 'claude-opus'
}

/** The part of an estimate that turns tokens into money and a share of the 5-hour window. */
export interface CostEstimate {
  tokens: number
  /** API-equivalent dollars (what the limit-health baseline is measured in). */
  costUsd: number
  /** Approximate % of the 5-hour window (subscription launches with enough history). */
  pct5h?: number
}

export interface PctBasis {
  /** Limit-health baseline: $ per 1% of the 5-hour window at the current plan. */
  dollarsPerPct?: number
  /** This window's % per weighted token of subscription use (when there's no baseline). */
  pctPerWeighted?: number
  weights: CapacityWeights
}

/**
 * This window's % per weighted token: the live reading divided by the
 * subscription use in the window up to it (API-billed use doesn't move the
 * limit, so it's left out, as in the limit gauge). Undefined without a
 * reading or use to compare with.
 */
export function pctPerWeightedToken(i: {
  reading?: { pct: number; at: number; windowStart?: number }
  records: UsageRecord[]
  weights: CapacityWeights
  isSubscription?: (key: string) => boolean
}): number | undefined {
  const r = i.reading
  if (!r || !(r.pct > 0)) return undefined
  const sub = i.isSubscription ?? (() => true)
  let before = 0
  for (const x of i.records)
    if (x.ts <= r.at && (r.windowStart === undefined || x.ts >= r.windowStart) && sub(x.key))
      before += weightedTokens(x, i.weights)
  return before > 0 ? r.pct / before : undefined
}

function cost(
  t: { input?: number; cacheWrite?: number; cacheRead?: number; cw1h?: number },
  model: string,
  prices: ModelPrice[],
  basis: PctBasis | undefined
): CostEstimate {
  const rec = {
    model,
    input: t.input ?? 0,
    output: 0,
    cacheWrite: t.cacheWrite ?? 0,
    cacheRead: t.cacheRead ?? 0,
    cw1h: t.cw1h
  }
  const costUsd = estimateCost(rec, prices)
  const tokens = rec.input + rec.cacheWrite + rec.cacheRead
  const out: CostEstimate = { tokens, costUsd }
  if (!basis) return out
  if (basis.dollarsPerPct && basis.dollarsPerPct > 0 && costUsd > 0)
    out.pct5h = costUsd / basis.dollarsPerPct
  else if (basis.pctPerWeighted && basis.pctPerWeighted > 0)
    out.pct5h = weightedTokens(rec, basis.weights) * basis.pctPerWeighted
  return out
}

/** Characters around the summary in a handoff file (heading, facts, the closing line). */
export const HANDOFF_FIXED_CHARS = 900

export interface ResumeEstimate {
  tokens: number
  from: SessionContext['from']
  windowSize: number
  /** % of the model's context window. */
  windowPct: number
  band: SizeBand
  compactions: number
  preCompactTokens?: number
  /** Model id the money is worked out with. */
  model: string
  billing: 'subscription' | 'api'
  cacheTtl: CacheTtl
  /** The cache may still be warm until then (epoch ms): the first message reads, not writes. */
  warmUntil?: number
  /** The first message after resuming (warm: a cache read). */
  resume: CostEstimate
  /** Cold, for comparison, when the cache may be warm. */
  cold?: CostEstimate
  /** Each later message reads the whole context from the cache. */
  perMessage: CostEstimate
  /** Continue fresh: the setup plus the handoff (undefined: no summary yet). */
  fresh?: CostEstimate
  /** How the % was worked out; undefined: it couldn't be (tokens only). */
  basis?: 'baseline' | 'window'
  /** Why there's no % (or no price). */
  unknown?: string
}

export const NO_BASELINE =
  'Not enough limit history yet to turn tokens into a share of your 5-hour window.'

export function estimateResume(i: {
  ctx: SessionContext
  /** The launch's model choice (alias or id; undefined/"default": Claude Code's). */
  modelChoice?: string
  billing: 'subscription' | 'api'
  prices: ModelPrice[]
  weights: CapacityWeights
  dollarsPerPct?: number
  pctPerWeighted?: number
  /** Characters of the summary that Continue fresh would hand over (undefined: no summary). */
  handoffChars?: number
  now: number
}): ResumeEstimate {
  const { ctx, prices } = i
  const model = priceModelId(i.modelChoice, ctx.model, prices)
  const sessionModel = ctx.model ? priceModelId(undefined, ctx.model, prices) : undefined
  const ttl: CacheTtl = ctx.cacheTtl ?? '5m'
  const sub = i.billing === 'subscription'
  const basis: PctBasis | undefined = sub
    ? { dollarsPerPct: i.dollarsPerPct, pctPerWeighted: i.pctPerWeighted, weights: i.weights }
    : undefined
  const write = (n: number): Parameters<typeof cost>[0] => ({
    cacheWrite: n,
    cw1h: ttl === '1h' ? n : 0
  })
  const N = ctx.tokens
  const warm = warmUntil(ctx, i.now, !sessionModel || sessionModel === model)
  const coldCost = cost(write(N), model, prices, basis)
  const resume = warm ? cost({ cacheRead: N }, model, prices, basis) : coldCost
  const fresh =
    i.handoffChars !== undefined
      ? cost(
          write(
            (ctx.baseTokens ?? DEFAULT_BASE_TOKENS) +
              Math.ceil((i.handoffChars + HANDOFF_FIXED_CHARS) / CHARS_PER_TOKEN)
          ),
          model,
          prices,
          basis
        )
      : undefined
  const priced = !!findPrice(model.replace(/-fast$/, ''), prices)
  const windowSize = contextWindowSize(ctx, i.modelChoice)
  const basisUsed: ResumeEstimate['basis'] =
    sub && resume.pct5h !== undefined
      ? i.dollarsPerPct && i.dollarsPerPct > 0 && priced
        ? 'baseline'
        : 'window'
      : undefined
  const noPrice = `No price is known for ${model}, so its cost can't be estimated.`
  const unknown = sub
    ? resume.pct5h === undefined
      ? priced
        ? NO_BASELINE
        : noPrice
      : undefined
    : priced
      ? undefined
      : noPrice
  return {
    tokens: N,
    from: ctx.from,
    windowSize,
    windowPct: (N / windowSize) * 100,
    band: sizeBand(N),
    compactions: ctx.compactions,
    ...(ctx.preCompactTokens ? { preCompactTokens: ctx.preCompactTokens } : {}),
    model,
    billing: i.billing,
    cacheTtl: ttl,
    ...(warm ? { warmUntil: warm, cold: coldCost } : {}),
    resume,
    perMessage: cost({ cacheRead: N }, model, prices, basis),
    ...(fresh ? { fresh } : {}),
    ...(basisUsed ? { basis: basisUsed } : {}),
    ...(unknown ? { unknown } : {})
  }
}
