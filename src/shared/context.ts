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
  /** The model that window belongs to (the status line's). */
  windowModel?: string
  /** How often the conversation was compacted. */
  compactions: number
  /** Context size right before the latest compaction (Claude Code's `preTokens`). */
  preCompactTokens?: number
  /** The session's fixed setup (system prompt, tools, first prompt): its first reply's input. */
  baseTokens?: number
  /**
   * Share (0–1) of the cache writes since the last compaction that went to
   * the 1-hour cache; the rest went to the 5-minute one. Undefined when the
   * usage lines don't say (then everything counts as 5-minute).
   */
  cache1hShare?: number
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
export function usageContextTokens(usage: unknown): {
  tokens: number
  cw5: number
  cw1h: number
} {
  const u = obj(usage)
  if (!u) return { tokens: 0, cw5: 0, cw1h: 0 }
  const cc = obj(u.cache_creation)
  const cw5 = num(cc?.ephemeral_5m_input_tokens)
  const cw1h = num(cc?.ephemeral_1h_input_tokens)
  const write = cc && cw5 + cw1h > 0 ? cw5 + cw1h : num(u.cache_creation_input_tokens)
  const tokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + write
  return { tokens, cw5, cw1h }
}

/**
 * The context size from a session's events. Undefined when no reply carries
 * usage (very old files, or nothing answered yet) and nothing was compacted.
 */
export function analyzeContext(events: RawEvent[]): SessionContext | undefined {
  let last: { tokens: number; at?: string; model?: string } | undefined
  let base: number | undefined
  // Cache writes since the last compaction, by lifetime.
  let cw5 = 0
  let cw1h = 0
  let compactions = 0
  let preCompact: number | undefined
  let compactAt: string | undefined
  // A compaction with no reply after it yet, and the size of its summary.
  let compactedSinceReply = false
  let summaryChars = 0
  let lastTs: string | undefined
  let lastId: string | undefined
  let lastWrites = { cw5: 0, cw1h: 0 }

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
      cw5 = cw1h = 0
      continue
    }
    const msg = obj(e.message)
    if (type === 'user' && e.isCompactSummary === true) {
      // Older versions wrote only the summary, without a boundary entry.
      if (!compactedSinceReply) {
        compactions++
        compactAt = ts ?? lastTs
        cw5 = cw1h = 0
      }
      compactedSinceReply = true
      summaryChars = blocksText(msg?.content ?? e.content).length
      continue
    }
    if (type !== 'assistant' || !msg) continue
    const model = text(msg.model)
    if (model === '<synthetic>') continue
    const u = usageContextTokens(msg.usage)
    if (!u.tokens) continue
    // Streamed parts of one reply repeat its usage: count its writes once.
    const mid = text(msg.id)
    if (mid && mid === lastId) {
      cw5 += u.cw5 - lastWrites.cw5
      cw1h += u.cw1h - lastWrites.cw1h
    } else {
      cw5 += u.cw5
      cw1h += u.cw1h
    }
    lastId = mid
    lastWrites = { cw5: u.cw5, cw1h: u.cw1h }
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
    ...(cw5 + cw1h > 0 ? { cache1hShare: cw1h / (cw5 + cw1h) } : {}),
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
  /** The model the reading was for. */
  model?: string
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
      ...(st.model ? { windowModel: st.model } : {}),
      compactions: 0
    }
  }
  const out: SessionContext = {
    ...ctx,
    ...(size ? { windowSize: size, ...(st.model ? { windowModel: st.model } : {}) } : {})
  }
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

/** A model id to compare by: lower case, without a date suffix. */
export function modelKey(id: string): string {
  return id.toLowerCase().replace(/-\d{8}(?=$|\[)/, '')
}

const plainKey = (id: string): string => modelKey(id).replace(/\[1m\]$/, '')

/**
 * The context window of the model a launch uses:
 * - an explicit `[1m]` choice: 1M;
 * - the session's own status line reading, unless another model is chosen;
 * - what the status line reported for that model in any session (so models
 *   with a native 1M window are known once seen);
 * - else 1M when the context is already past 200k, otherwise 200k.
 */
export function contextWindowSize(
  ctx: SessionContext,
  launch: {
    /** The launch's model choice (undefined / "default": Claude Code's). */
    choice?: string
    /** The model id it resolves to. */
    modelId?: string
    /** Window sizes the status line reported, by `modelKey`. */
    learned?: Record<string, number>
  } = {}
): number {
  const choice = launch.choice?.toLowerCase()
  if (choice?.endsWith('[1m]')) return LONG_WINDOW
  const explicit = !!choice && choice !== 'default'
  const target = launch.modelId ?? ctx.model
  const readFor = ctx.windowModel ?? ctx.model
  if (
    ctx.windowSize &&
    (!explicit || !target || (!!readFor && plainKey(readFor) === plainKey(target)))
  )
    return ctx.windowSize
  const learned = target ? launch.learned?.[modelKey(target)] : undefined
  if (learned) return learned
  if ((!explicit && ctx.model?.toLowerCase().includes('[1m]')) || ctx.tokens > STANDARD_WINDOW)
    return LONG_WINDOW
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

const MIN5 = 5 * 60_000
const HOUR = 60 * 60_000

/** The first message after resuming: what it reads from the cache and what it writes again. */
export interface FirstMessage {
  read: number
  write5m: number
  write1h: number
  /** When the price next goes up (a part of the cache runs out), while some of it is warm. */
  warmUntil?: number
}

/**
 * Split the context by cache lifetime (1-hour entries come first in the
 * prompt, so they outlive the 5-minute ones) and work out what is still
 * cached at `now`. Warm only when the cache can be reused at all
 * (`reusable`: the same model and billing account) and the size was read
 * from the last reply.
 */
export function firstMessage(
  ctx: SessionContext,
  now: number,
  reusable: boolean,
  /** Share written to the 1-hour cache. */
  share1h: number
): FirstMessage {
  const N = ctx.tokens
  const n1 = Math.round(N * Math.min(1, Math.max(0, share1h)))
  const n5 = N - n1
  const cold: FirstMessage = { read: 0, write5m: n5, write1h: n1 }
  if (!reusable || !ctx.lastReplyAt || ctx.from === 'compaction') return cold
  const age = now - Date.parse(ctx.lastReplyAt)
  if (!(age >= 0)) return cold
  const alive5 = age < MIN5 && n5 > 0
  const alive1 = age < HOUR && n1 > 0
  if (!alive5 && !alive1) return cold
  return {
    read: (alive5 ? n5 : 0) + (alive1 ? n1 : 0),
    write5m: alive5 ? 0 : n5,
    write1h: alive1 ? 0 : n1,
    warmUntil: Date.parse(ctx.lastReplyAt) + (alive5 ? MIN5 : HOUR)
  }
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
  /** The model isn't known (e.g. Claude Code's default for a new session): tokens only. */
  unpriced?: boolean
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
  /** Which cache the writes are priced at. */
  cache: CacheTtl | 'mixed'
  /** The launch bills another account than the session did (or that isn't known): no shared cache. */
  otherScope?: boolean
  /**
   * The cache may still be (partly) warm until then (epoch ms): the first
   * message reads from it. The estimate goes up at that time.
   */
  warmUntil?: number
  /** The first message after resuming (warm: a cache read). */
  resume: CostEstimate
  /** Cold, for comparison, when the cache may be warm. */
  cold?: CostEstimate
  /** Each later message reads the whole context from the cache. */
  perMessage: CostEstimate
  /** Continue fresh: the setup plus the handoff (undefined: no summary yet). */
  fresh?: CostEstimate
  /** Model id Continue fresh is priced with (undefined: unknown, tokens only). */
  freshModel?: string
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
  /**
   * The launch bills the same account as the session did, so its prompt
   * cache can be reused and its cache lifetimes apply. False when it differs
   * or isn't known.
   */
  sameScope: boolean
  prices: ModelPrice[]
  weights: CapacityWeights
  dollarsPerPct?: number
  pctPerWeighted?: number
  /** Characters of the summary that Continue fresh would hand over (undefined: no summary). */
  handoffChars?: number
  /**
   * The model a new session uses when none is chosen: Claude Code's current
   * default (e.g. the latest status line reading's model).
   */
  defaultModel?: string
  /** Window sizes the status line reported, by `modelKey`. */
  windowSizes?: Record<string, number>
  now: number
}): ResumeEstimate {
  const { ctx, prices } = i
  const model = priceModelId(i.modelChoice, ctx.model, prices)
  const sessionModel = ctx.model ? priceModelId(undefined, ctx.model, prices) : undefined
  const sub = i.billing === 'subscription'
  const basis: PctBasis | undefined = sub
    ? { dollarsPerPct: i.dollarsPerPct, pctPerWeighted: i.pctPerWeighted, weights: i.weights }
    : undefined
  // Another account: its cache lifetime isn't known, so writes are priced at
  // the 1-hour rate (the higher one).
  const share1h = i.sameScope ? (ctx.cache1hShare ?? 0) : 1
  const N = ctx.tokens
  const sameModel = !sessionModel || modelKey(sessionModel) === modelKey(model)
  const first = firstMessage(ctx, i.now, i.sameScope && sameModel, share1h)
  const write = (n: number): Parameters<typeof cost>[0] => ({
    cacheWrite: n,
    cw1h: Math.round(n * share1h)
  })
  const coldCost = cost(write(N), model, prices, basis)
  const resume = first.warmUntil
    ? cost(
        { cacheRead: first.read, cacheWrite: first.write5m + first.write1h, cw1h: first.write1h },
        model,
        prices,
        basis
      )
    : coldCost
  // Continue fresh starts a new session: the chosen model, else Claude Code's
  // current default (not necessarily this session's model).
  const explicit = !!i.modelChoice && i.modelChoice.toLowerCase() !== 'default'
  const freshModel = explicit
    ? model
    : i.defaultModel
      ? priceModelId(undefined, i.defaultModel, prices)
      : undefined
  let fresh: CostEstimate | undefined
  if (i.handoffChars !== undefined) {
    const t =
      (ctx.baseTokens ?? DEFAULT_BASE_TOKENS) +
      Math.ceil((i.handoffChars + HANDOFF_FIXED_CHARS) / CHARS_PER_TOKEN)
    fresh = freshModel
      ? cost(write(t), freshModel, prices, basis)
      : { tokens: t, costUsd: 0, unpriced: true }
  }
  const priced = !!findPrice(model.replace(/-fast$/, ''), prices)
  const windowSize = contextWindowSize(ctx, {
    choice: i.modelChoice,
    modelId: explicit ? model : ctx.model,
    learned: i.windowSizes
  })
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
    cache: share1h >= 1 ? '1h' : share1h <= 0 ? '5m' : 'mixed',
    ...(i.sameScope ? {} : { otherScope: true }),
    ...(first.warmUntil ? { warmUntil: first.warmUntil, cold: coldCost } : {}),
    resume,
    perMessage: cost({ cacheRead: N }, model, prices, basis),
    ...(fresh ? { fresh } : {}),
    ...(fresh && freshModel ? { freshModel } : {}),
    ...(basisUsed ? { basis: basisUsed } : {}),
    ...(unknown ? { unknown } : {})
  }
}
