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
   * Share (0–1) of what the prompt cache held after the last reply that is in
   * the 1-hour cache; the rest is in the 5-minute one. Undefined when nothing
   * is known to be cached (then everything counts as 5-minute).
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
  read: number
  cw5: number
  cw1h: number
} {
  const u = obj(usage)
  if (!u) return { tokens: 0, read: 0, cw5: 0, cw1h: 0 }
  const cc = obj(u.cache_creation)
  let cw5 = num(cc?.ephemeral_5m_input_tokens)
  const cw1h = num(cc?.ephemeral_1h_input_tokens)
  // Without the breakdown (older versions), writes went to the 5-minute cache.
  if (!(cc && cw5 + cw1h > 0)) cw5 = num(u.cache_creation_input_tokens)
  const read = num(u.cache_read_input_tokens)
  return { tokens: num(u.input_tokens) + read + cw5 + cw1h, read, cw5, cw1h }
}

/**
 * What the prompt cache holds after each reply, by lifetime. 1-hour entries
 * come first in the prompt, then 5-minute ones. A reply reads a prefix of
 * what was cached (the rest ran out or changed) and writes new entries after
 * it, so the cache is the part it read plus what it wrote. Caches belong to
 * one model: another model starts empty.
 */
class CacheTrack {
  h1 = 0
  m5 = 0
  model?: string
  apply(model: string | undefined, u: { read: number; cw5: number; cw1h: number }): void {
    if (model && this.model && model !== this.model) this.reset()
    if (model) this.model = model
    const kept1 = Math.min(this.h1, u.read)
    const kept5 = Math.min(this.m5, Math.max(0, u.read - kept1))
    this.h1 = kept1 + u.cw1h
    this.m5 = kept5 + u.cw5
  }
  reset(): void {
    this.h1 = this.m5 = 0
  }
  /** Share of the cached tokens in the 1-hour cache, undefined when nothing is cached. */
  get share1h(): number | undefined {
    const total = this.h1 + this.m5
    return total > 0 ? this.h1 / total : undefined
  }
}

/**
 * The context size from a session's events. Undefined when no reply carries
 * usage (very old files, or nothing answered yet) and nothing was compacted.
 */
export function analyzeContext(events: RawEvent[]): SessionContext | undefined {
  let last: { tokens: number; at?: string; model?: string } | undefined
  let base: number | undefined
  const cache = new CacheTrack()
  // Streamed parts of one reply (same message and request) repeat its usage:
  // it is applied once, with the last part's numbers.
  let pending:
    { key: string; model?: string; u: { read: number; cw5: number; cw1h: number } } | undefined
  const flush = (): void => {
    if (pending) cache.apply(pending.model, pending.u)
    pending = undefined
  }
  let compactions = 0
  let preCompact: number | undefined
  let compactAt: string | undefined
  // A compaction with no reply after it yet, and the size of its summary.
  let compactedSinceReply = false
  let summaryChars = 0
  let lastTs: string | undefined
  let n = 0

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
      // A new conversation: nothing of it is cached, and no reply is half-counted.
      pending = undefined
      cache.reset()
      continue
    }
    const msg = obj(e.message)
    if (type === 'user' && e.isCompactSummary === true) {
      // Older versions wrote only the summary, without a boundary entry.
      if (!compactedSinceReply) {
        compactions++
        compactAt = ts ?? lastTs
        pending = undefined
        cache.reset()
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
    const mid = text(msg.id)
    const rid = text(e.requestId)
    // Without ids every entry is its own reply.
    const key = mid ? `${mid}:${rid ?? ''}` : `#${n++}`
    if (pending?.key !== key) flush()
    pending = { key, model: model ?? last?.model, u }
    last = { tokens: u.tokens, at: ts, model: model ?? last?.model }
    if (base === undefined) base = u.tokens
    compactedSinceReply = false
  }
  flush()

  if (!last && !compactions) return undefined
  const share1h = cache.share1h
  const common = {
    compactions,
    ...(preCompact ? { preCompactTokens: preCompact } : {}),
    ...(base !== undefined ? { baseTokens: base } : {}),
    ...(share1h !== undefined ? { cache1hShare: share1h } : {}),
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

/**
 * A model's own context window (Claude Code's model configuration docs):
 * Fable 5 and later, Sonnet 5 and later, Haiku 5.5 and later and Opus 4.7 and
 * later run with 1M by default; other models (Opus 4.6, Sonnet 4.6 and older)
 * have 200k unless their `[1m]` variant is chosen.
 */
export function nativeWindow(modelId: string | undefined): number {
  if (!modelId) return STANDARD_WINDOW
  const id = modelKey(modelId)
  if (id.endsWith('[1m]')) return LONG_WINDOW
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/.exec(id)
  if (!m) return STANDARD_WINDOW
  const v = Number(m[2]) * 100 + Number(m[3] ?? 0)
  const at = { fable: 500, sonnet: 500, haiku: 505, opus: 407 } as Record<string, number>
  return m[1] in at && v >= at[m[1]] ? LONG_WINDOW : STANDARD_WINDOW
}

/** Where a context window size comes from. */
export type WindowFrom =
  /** An explicit `[1m]` choice. */
  | 'variant'
  /** Claude Code's status line, for the same model the session last used. */
  | 'status-line'
  /** The model's own window (Claude Code's model configuration). */
  | 'model'
  /** The context is already bigger than 200k, so it must be a 1M window. */
  | 'size'

export interface ContextWindow {
  size: number
  from: WindowFrom
  /** The model the size is for, when known. */
  model?: string
}

/**
 * The context window of the model a launch uses, per model:
 * - an explicit `[1m]` choice: 1M;
 * - another explicit model: that model's own window (a session's reading
 *   can't tell a `[1m]` variant from the standard one);
 * - no choice: the status line's reading when it was taken for the model the
 *   session last used (what Claude Code really runs, e.g. a plan without the
 *   1M variant), else that model's own window. A context already past 200k
 *   is always on a 1M window.
 */
export function contextWindow(
  ctx: SessionContext,
  launch: {
    /** The launch's model choice (undefined / "default": Claude Code's). */
    choice?: string
    /** The model id it resolves to. */
    modelId?: string
  } = {}
): ContextWindow {
  const choice = launch.choice?.toLowerCase()
  if (choice?.endsWith('[1m]')) return { size: LONG_WINDOW, from: 'variant', model: launch.modelId }
  const explicit = !!choice && choice !== 'default'
  const model = explicit ? launch.modelId : ctx.model
  let w: ContextWindow
  if (
    !explicit &&
    ctx.windowSize &&
    (!ctx.model || !ctx.windowModel || modelKey(ctx.windowModel) === modelKey(ctx.model))
  )
    w = { size: ctx.windowSize, from: 'status-line', model: ctx.windowModel ?? ctx.model }
  else w = { size: nativeWindow(model), from: 'model', model }
  if (ctx.tokens > w.size && w.size < LONG_WINDOW) return { size: LONG_WINDOW, from: 'size', model }
  return w
}

/** Just the size (see `contextWindow`). */
export function contextWindowSize(
  ctx: SessionContext,
  launch: { choice?: string; modelId?: string } = {}
): number {
  return contextWindow(ctx, launch).size
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
 * reading, its window's start, or use to compare with.
 */
export function pctPerWeightedToken(i: {
  reading?: { pct: number; at: number; windowStart?: number }
  records: UsageRecord[]
  weights: CapacityWeights
  isSubscription?: (key: string) => boolean
}): number | undefined {
  const r = i.reading
  // Without the window's start, older use can't be told apart from this window's.
  if (!r || !(r.pct > 0) || r.windowStart === undefined) return undefined
  const sub = i.isSubscription ?? (() => true)
  let before = 0
  for (const x of i.records)
    if (x.ts <= r.at && x.ts >= r.windowStart && sub(x.key)) before += weightedTokens(x, i.weights)
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
  /** Where the window size comes from, and the model it's for. */
  windowFrom: WindowFrom
  windowModel?: string
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
  // Continue fresh starts a new session. Without a chosen model it gets Claude
  // Code's default (environment, settings, plan, organization), which the app
  // can't verify, so it is shown in tokens only.
  const explicit = !!i.modelChoice && i.modelChoice.toLowerCase() !== 'default'
  const freshModel = explicit ? model : undefined
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
  const win = contextWindow(ctx, { choice: i.modelChoice, modelId: model })
  const windowSize = win.size
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
    windowFrom: win.from,
    ...(win.model ? { windowModel: win.model } : {}),
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
