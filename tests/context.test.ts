import { describe, expect, it } from 'vitest'
import {
  analyzeContext,
  contextWindowSize,
  DEFAULT_BASE_TOKENS,
  DEFAULT_CONTEXT_WARNING,
  estimateResume,
  NO_BASELINE,
  pctPerWeightedToken,
  priceModelId,
  sanitizeContextWarning,
  shouldWarn,
  sizeBand,
  firstMessage,
  modelKey,
  nativeWindow,
  withStatusLine,
  type SessionContext
} from '@shared/context'
import type { RawEvent } from '@shared/jsonl'
import { DEFAULT_WEIGHTS } from '@shared/usage/limits'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'

const T0 = Date.parse('2026-11-01T10:00:00.000Z')
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString()

function reply(
  min: number,
  usage: Record<string, unknown>,
  extra: Partial<RawEvent> = {},
  model = 'claude-opus-4-5'
): RawEvent {
  return {
    type: 'assistant',
    timestamp: at(min),
    uuid: `a-${min}`,
    message: { id: `msg-${min}`, role: 'assistant', model, content: [], usage },
    ...extra
  }
}
const user = (min: number, text = 'hi'): RawEvent => ({
  type: 'user',
  timestamp: at(min),
  message: { role: 'user', content: text }
})
const use1h = (input: number, read: number, write: number) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
  output_tokens: 500
})

describe('analyzeContext', () => {
  it('uses the last main-thread reply: input + cache read + cache creation', () => {
    const c = analyzeContext([
      user(0),
      reply(1, use1h(10, 0, 18_000)),
      user(2),
      reply(3, use1h(5, 18_000, 2_000)),
      // A subagent's turn is its own context.
      reply(4, use1h(3, 0, 90_000), { isSidechain: true })
    ])!
    expect(c.tokens).toBe(20_005)
    expect(c.from).toBe('usage')
    expect(c.baseTokens).toBe(18_010)
    expect(c.cache1hShare).toBe(1)
    expect(c.lastReplyAt).toBe(at(3))
    expect(c.compactions).toBe(0)
    expect(c.model).toBe('claude-opus-4-5')
  })

  it('takes the last streamed part of a reply and skips synthetic and empty ones', () => {
    const c = analyzeContext([
      user(0),
      reply(1, use1h(1, 1000, 100)),
      reply(1, use1h(1, 1000, 200)),
      reply(2, { input_tokens: 0, output_tokens: 0 }, {}, '<synthetic>'),
      reply(3, { output_tokens: 10 })
    ])!
    expect(c.tokens).toBe(1201)
  })

  it('reads the 5-minute cache, and old usage without the breakdown', () => {
    const five = analyzeContext([
      reply(1, {
        input_tokens: 1,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 }
      })
    ])!
    expect(five.cache1hShare).toBe(0)
    const old = analyzeContext([reply(1, { input_tokens: 100, cache_creation_input_tokens: 50 })])!
    expect(old.tokens).toBe(150)
    // Older usage without the breakdown: the 5-minute cache.
    expect(old.cache1hShare).toBe(0)
  })

  it('mixed cache lifetimes: what the cache holds now, by lifetime', () => {
    const mixed = (read: number, cw5: number, cw1h: number) => ({
      input_tokens: 1,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: cw5 + cw1h,
      cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1h }
    })
    const c = analyzeContext([
      reply(1, mixed(0, 0, 20_000)),
      // Streamed parts of one reply count once.
      reply(2, mixed(20_000, 50_000, 0)),
      reply(2, mixed(20_000, 50_000, 0)),
      reply(3, mixed(70_000, 50_000, 0))
    ])!
    expect(c.cache1hShare).toBeCloseTo(20_000 / 120_000)

    // The 5-minute part ran out and was written again: it isn't counted twice.
    const rewritten = analyzeContext([
      reply(1, mixed(0, 0, 20_000)),
      reply(2, mixed(20_000, 100_000, 0)),
      reply(20, mixed(20_000, 110_000, 0))
    ])!
    expect(rewritten.cache1hShare).toBeCloseTo(20_000 / 130_000)

    // A compaction starts over.
    const after = analyzeContext([
      reply(1, mixed(0, 90_000, 0)),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 1 } },
      reply(5, mixed(0, 0, 30_000))
    ])!
    expect(after.cache1hShare).toBe(1)
  })

  it("another model's cache doesn't carry over", () => {
    const c = analyzeContext([
      reply(1, use1h(1, 0, 50_000), {}, 'claude-opus-4-5'),
      reply(
        2,
        {
          input_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 30_000,
          cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 0 }
        },
        {},
        'claude-sonnet-4-5'
      )
    ])!
    expect(c.cache1hShare).toBe(0)
    expect(c.model).toBe('claude-sonnet-4-5')
  })

  it('a reused message id after a compaction is a new reply (never a negative share)', () => {
    const placeholder = (min: number, rid: string, usage: Record<string, unknown>): RawEvent => ({
      type: 'assistant',
      timestamp: at(min),
      requestId: rid,
      message: { id: 'msg_placeholder', model: 'claude-opus-4-5', content: [], usage }
    })
    const c = analyzeContext([
      placeholder(1, 'req-1', use1h(1, 0, 100_000)),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 100_001 } },
      placeholder(5, 'req-2', {
        input_tokens: 1,
        cache_creation_input_tokens: 20_000,
        cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 }
      })
    ])!
    expect(c.cache1hShare).toBe(0)
    expect(c.tokens).toBe(20_001)
    // The same id with different requests (a gateway): separate replies too.
    const twice = analyzeContext([
      placeholder(1, 'req-1', use1h(1, 0, 10_000)),
      placeholder(2, 'req-2', use1h(1, 10_000, 5_000))
    ])!
    expect(twice.cache1hShare).toBe(1)
    expect(twice.tokens).toBe(15_001)
  })

  it('missing usage: unknown', () => {
    expect(analyzeContext([user(0), reply(1, {})])).toBeUndefined()
    expect(
      analyzeContext([user(0), { type: 'assistant', message: { content: 'x' } }])
    ).toBeUndefined()
    expect(analyzeContext([])).toBeUndefined()
  })

  it('after a compaction with no reply since: the setup plus the summary', () => {
    const summary = 'x'.repeat(8_000)
    const c = analyzeContext([
      user(0),
      reply(1, use1h(10, 0, 15_000)),
      reply(30, use1h(10, 150_000, 50_000)),
      {
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: at(31),
        compactMetadata: { trigger: 'auto', preTokens: 200_010 }
      },
      { type: 'user', isCompactSummary: true, timestamp: at(31), message: { content: summary } }
    ])!
    expect(c.from).toBe('compaction')
    expect(c.tokens).toBe(15_010 + 2_000)
    expect(c.compactions).toBe(1)
    expect(c.preCompactTokens).toBe(200_010)
    // Nothing of the new context is cached.
    expect(c.lastReplyAt).toBeUndefined()
  })

  it('after a compaction and a reply: the post-compaction usage', () => {
    const c = analyzeContext([
      reply(1, use1h(10, 0, 15_000)),
      reply(30, use1h(10, 150_000, 50_000)),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 200_010 } },
      { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
      user(32),
      reply(33, use1h(10, 0, 30_000)),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 190_000 } },
      { type: 'user', isCompactSummary: true, message: { content: 'again' } },
      reply(40, use1h(10, 30_000, 2_000))
    ])!
    expect(c.from).toBe('usage')
    expect(c.tokens).toBe(32_010)
    expect(c.compactions).toBe(2)
    expect(c.preCompactTokens).toBe(190_000)
  })

  it('older files: a compact summary without a boundary counts once', () => {
    const c = analyzeContext([
      reply(1, use1h(10, 0, 15_000)),
      { type: 'user', isCompactSummary: true, message: { content: 'y'.repeat(400) } }
    ])!
    expect(c.compactions).toBe(1)
    expect(c.tokens).toBe(15_010 + 100)
  })

  it('a compaction without any reply uses the default setup size', () => {
    const c = analyzeContext([
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 1 } }
    ])!
    expect(c.tokens).toBe(DEFAULT_BASE_TOKENS)
  })
})

describe('withStatusLine', () => {
  const file: SessionContext = {
    tokens: 100_000,
    from: 'usage',
    at: at(10),
    lastReplyAt: at(10),
    compactions: 0
  }
  it('a newer reading wins; its window size is kept either way', () => {
    const newer = withStatusLine(file, { pct: 30, size: 1_000_000, ts: T0 + 11 * 60_000 })!
    expect(newer.tokens).toBe(300_000)
    expect(newer.from).toBe('status-line')
    expect(newer.windowSize).toBe(1_000_000)
    const older = withStatusLine(file, { pct: 10, size: 200_000, ts: T0 + 5 * 60_000 })!
    expect(older.tokens).toBe(100_000)
    expect(older.from).toBe('usage')
    expect(older.windowSize).toBe(200_000)
  })
  it('without a size only nothing changes; without a file, the reading alone', () => {
    expect(withStatusLine(file, { pct: 50, ts: T0 + 20 * 60_000 })!.tokens).toBe(100_000)
    expect(withStatusLine(undefined, { pct: 50, size: 200_000, ts: T0 })!.tokens).toBe(100_000)
    expect(withStatusLine(undefined, { pct: 50, ts: T0 })).toBeUndefined()
    expect(withStatusLine(file, undefined)).toBe(file)
  })
})

describe('size', () => {
  it('bands', () => {
    expect(sizeBand(39_999)).toBe('S')
    expect(sizeBand(40_000)).toBe('M')
    expect(sizeBand(100_000)).toBe('L')
    expect(sizeBand(150_000)).toBe('XL')
  })
  it('context window: status line, [1m], or past 200k', () => {
    const c: SessionContext = { tokens: 50_000, from: 'usage', compactions: 0 }
    expect(contextWindowSize(c)).toBe(200_000)
    expect(contextWindowSize(c, { choice: 'sonnet[1m]' })).toBe(1_000_000)
    expect(contextWindowSize({ ...c, tokens: 250_000 })).toBe(1_000_000)
    expect(contextWindowSize({ ...c, windowSize: 500_000 })).toBe(500_000)
  })

  it("models' own windows (Claude Code's model configuration)", () => {
    expect(nativeWindow('claude-opus-4-6')).toBe(200_000)
    expect(nativeWindow('claude-opus-4-5-20251101')).toBe(200_000)
    expect(nativeWindow('claude-opus-4-7')).toBe(1_000_000)
    expect(nativeWindow('claude-opus-5-5')).toBe(1_000_000)
    expect(nativeWindow('claude-sonnet-4-6')).toBe(200_000)
    expect(nativeWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(nativeWindow('claude-haiku-4-5')).toBe(200_000)
    expect(nativeWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(nativeWindow('claude-fable-5-1')).toBe(1_000_000)
    expect(nativeWindow('claude-3-5-sonnet')).toBe(200_000)
    expect(nativeWindow('claude-opus-4-6[1m]')).toBe(1_000_000)
    expect(nativeWindow(undefined)).toBe(200_000)
    expect(modelKey('Claude-Opus-4-5-20251101')).toBe('claude-opus-4-5')
  })

  it('the window of the model the launch uses', () => {
    // The session ran Opus 4.6 [1m]: its reading says 1M.
    const c: SessionContext = {
      tokens: 180_000,
      from: 'usage',
      compactions: 0,
      model: 'claude-opus-4-6',
      windowSize: 1_000_000,
      windowModel: 'claude-opus-4-6'
    }
    expect(contextWindowSize(c)).toBe(1_000_000)
    // An explicit standard Opus 4.6 launch runs at 200k; its [1m] variant at 1M.
    expect(contextWindowSize(c, { choice: 'claude-opus-4-6', modelId: 'claude-opus-4-6' })).toBe(
      200_000
    )
    expect(contextWindowSize(c, { choice: 'opus[1m]', modelId: 'claude-opus-4-6' })).toBe(1_000_000)
    // A native 1M model without any status line reading: 150k is 15%, not 75%.
    const native: SessionContext = {
      tokens: 150_000,
      from: 'usage',
      compactions: 0,
      model: 'claude-opus-5-5'
    }
    expect(contextWindowSize(native)).toBe(1_000_000)
    expect(contextWindowSize(native, { choice: 'haiku', modelId: 'claude-haiku-4-5' })).toBe(
      200_000
    )
  })
})

describe('warning threshold', () => {
  const settings = DEFAULT_CONTEXT_WARNING
  it('only Resume, at or above the threshold', () => {
    expect(shouldWarn({ kind: 'resume', tokens: 150_000, settings })).toBe(true)
    expect(shouldWarn({ kind: 'resume', tokens: 149_999, settings })).toBe(false)
    expect(shouldWarn({ kind: 'fork', tokens: 500_000, settings })).toBe(false)
    expect(shouldWarn({ kind: 'continue', tokens: 500_000, settings })).toBe(false)
  })
  it('off in Settings, off for the session, or an unknown size: no warning', () => {
    expect(
      shouldWarn({ kind: 'resume', tokens: 500_000, settings: { ...settings, enabled: false } })
    ).toBe(false)
    expect(shouldWarn({ kind: 'resume', tokens: 500_000, settings, sessionOff: true })).toBe(false)
    expect(shouldWarn({ kind: 'resume', tokens: undefined, settings })).toBe(false)
    expect(
      shouldWarn({
        kind: 'resume',
        tokens: 60_000,
        settings: { enabled: true, thresholdTokens: 50_000 }
      })
    ).toBe(true)
  })
  it('sanitizes the setting', () => {
    expect(sanitizeContextWarning(undefined)).toEqual(DEFAULT_CONTEXT_WARNING)
    expect(sanitizeContextWarning({ enabled: false, thresholdTokens: 5 })).toEqual({
      enabled: false,
      thresholdTokens: 10_000
    })
    expect(sanitizeContextWarning({ thresholdTokens: 'x' }).thresholdTokens).toBe(150_000)
    expect(sanitizeContextWarning({ thresholdTokens: 1e12 }).thresholdTokens).toBe(2_000_000)
  })
})

describe('estimateResume', () => {
  const ctx: SessionContext = {
    tokens: 100_000,
    from: 'usage',
    at: at(0),
    lastReplyAt: at(0),
    model: 'claude-opus-4-5',
    cache1hShare: 1,
    baseTokens: 20_000,
    compactions: 0
  }
  const base = {
    ctx,
    billing: 'subscription' as const,
    sameScope: true,
    prices: DEFAULT_PRICES,
    weights: DEFAULT_WEIGHTS
  }
  // Opus 4.5: 1h cache write $10/M, 5m write $6.25/M, read $0.50/M.
  const cold = T0 + 2 * 3_600_000

  it('cold: the whole context is written to the cache, priced as % via the baseline', () => {
    const e = estimateResume({ ...base, dollarsPerPct: 0.5, now: cold })
    expect(e.warmUntil).toBeUndefined()
    expect(e.resume.costUsd).toBeCloseTo(1.0)
    expect(e.resume.pct5h).toBeCloseTo(2)
    expect(e.perMessage.costUsd).toBeCloseTo(0.05)
    expect(e.perMessage.pct5h).toBeCloseTo(0.1)
    expect(e.basis).toBe('baseline')
    expect(e.unknown).toBeUndefined()
    expect(e.band).toBe('L')
    expect(e.windowPct).toBeCloseTo(50)
  })

  it('a 5-minute cache writes at the 5-minute price', () => {
    const e = estimateResume({
      ...base,
      ctx: { ...ctx, cache1hShare: 0 },
      dollarsPerPct: 0.5,
      now: cold
    })
    expect(e.resume.costUsd).toBeCloseTo(0.625)
  })

  it('warm (within the 1-hour cache): the first message is a cache read', () => {
    const now = T0 + 30 * 60_000
    const e = estimateResume({ ...base, dollarsPerPct: 0.5, now })
    expect(e.warmUntil).toBe(T0 + 3_600_000)
    expect(e.resume.costUsd).toBeCloseTo(0.05)
    expect(e.cold?.costUsd).toBeCloseTo(1.0)
    expect(e.resume.pct5h!).toBeLessThan(e.cold!.pct5h!)
  })

  it('warm needs the cache still alive, the same model, and a real reply', () => {
    // 5-minute cache, 10 minutes later: cold.
    expect(firstMessage({ ...ctx, cache1hShare: 0 }, T0 + 10 * 60_000, true, 0).warmUntil).toBe(
      undefined
    )
    expect(firstMessage({ ...ctx, cache1hShare: 0 }, T0 + 4 * 60_000, true, 0)).toEqual({
      read: 100_000,
      write5m: 0,
      write1h: 0,
      warmUntil: T0 + 5 * 60_000
    })
    // Unknown lifetime counts as 5 minutes.
    const unknownTtl = estimateResume({
      ...base,
      ctx: { ...ctx, cache1hShare: undefined },
      now: T0 + 10 * 60_000
    })
    expect(unknownTtl.warmUntil).toBeUndefined()
    expect(firstMessage({ ...ctx, from: 'compaction' }, T0 + 60_000, true, 1).warmUntil).toBe(
      undefined
    )
    const other = estimateResume({ ...base, modelChoice: 'sonnet', now: T0 + 60_000 })
    expect(other.warmUntil).toBeUndefined()
  })

  it('mixed lifetimes: after 5 minutes only the 1-hour part is still cached', () => {
    // 100k written to the 5-minute cache, 20k to the 1-hour one.
    const mixed: SessionContext = { ...ctx, tokens: 120_000, cache1hShare: 20_000 / 120_000 }
    const early = estimateResume({ ...base, ctx: mixed, now: T0 + 2 * 60_000 })
    expect(early.cache).toBe('mixed')
    expect(early.warmUntil).toBe(T0 + 5 * 60_000)
    expect(early.resume.costUsd).toBeCloseTo(0.06)
    // 10 minutes: 20k read ($0.01) + 100k written again at the 5-minute rate ($0.625).
    const later = estimateResume({ ...base, ctx: mixed, now: T0 + 10 * 60_000 })
    expect(later.resume.costUsd).toBeCloseTo(0.635)
    expect(later.warmUntil).toBe(T0 + 60 * 60_000)
    // Past the hour: all of it written again.
    const cold2 = estimateResume({ ...base, ctx: mixed, now: T0 + 61 * 60_000 })
    expect(cold2.warmUntil).toBeUndefined()
    expect(cold2.resume.costUsd).toBeCloseTo(0.2 + 0.625)
  })

  it('another billing account: no shared cache, written at the 1-hour rate', () => {
    const e = estimateResume({
      ...base,
      ctx: { ...ctx, cache1hShare: 0 },
      billing: 'api',
      sameScope: false,
      now: T0 + 60_000
    })
    expect(e.warmUntil).toBeUndefined()
    expect(e.otherScope).toBe(true)
    expect(e.cache).toBe('1h')
    expect(e.resume.costUsd).toBeCloseTo(1.0)
  })

  it('Continue fresh: the setup plus the handoff, at the chosen model', () => {
    const e = estimateResume({
      ...base,
      modelChoice: 'claude-opus-4-5',
      dollarsPerPct: 0.5,
      handoffChars: 3_100,
      now: cold
    })
    // 20k + (3100 + 900) / 4 = 21k tokens, 1h write.
    expect(e.fresh?.tokens).toBe(21_000)
    expect(e.fresh?.costUsd).toBeCloseTo(0.21)
    expect(e.freshModel).toBe('claude-opus-4-5')
    expect(e.fresh!.pct5h!).toBeLessThan(e.resume.pct5h!)
    expect(estimateResume({ ...base, now: cold }).fresh).toBeUndefined()
  })

  it("Continue fresh with no model chosen: Claude Code's default can't be verified, tokens only", () => {
    const e = estimateResume({ ...base, handoffChars: 3_100, dollarsPerPct: 0.5, now: cold })
    expect(e.fresh).toMatchObject({ tokens: 21_000, unpriced: true })
    expect(e.fresh?.pct5h).toBeUndefined()
    expect(e.freshModel).toBeUndefined()
    // Resume itself is still priced.
    expect(e.resume.pct5h).toBeCloseTo(2)
    const chosen = estimateResume({
      ...base,
      modelChoice: 'sonnet',
      handoffChars: 3_100,
      now: cold
    })
    expect(chosen.freshModel).toBe(chosen.model)
    expect(chosen.model).toMatch(/sonnet/)
  })

  it("no baseline: this window's rate from subscription use only", () => {
    const rec = (key: string, cacheRead: number, ts = T0): UsageRecord =>
      ({
        id: key,
        ts,
        key,
        project: 'p',
        env: 'windows',
        model: 'claude-opus-4-5',
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead
      }) as UsageRecord
    const records = [
      rec('w:sub', 1_000_000),
      rec('w:api', 9_000_000),
      rec('w:later', 5_000_000, T0 + 10)
    ]
    const rate = pctPerWeightedToken({
      reading: { pct: 10, at: T0, windowStart: T0 - 1000 },
      records,
      weights: DEFAULT_WEIGHTS,
      isSubscription: (k) => k !== 'w:api'
    })!
    // 10% for 100k weighted tokens (1M cache reads × 0.1).
    expect(rate).toBeCloseTo(10 / 100_000)
    const e = estimateResume({ ...base, pctPerWeighted: rate, now: cold })
    // 100k cache write × 1.25 weight × rate.
    expect(e.resume.pct5h).toBeCloseTo(12.5)
    expect(e.basis).toBe('window')
  })

  it('not enough history: tokens only, with the reason', () => {
    const e = estimateResume({ ...base, now: cold })
    expect(e.resume.pct5h).toBeUndefined()
    expect(e.resume.tokens).toBe(100_000)
    expect(e.unknown).toBe(NO_BASELINE)
    expect(e.basis).toBeUndefined()
    expect(
      pctPerWeightedToken({ reading: undefined, records: [], weights: DEFAULT_WEIGHTS })
    ).toBeUndefined()
    expect(
      pctPerWeightedToken({ reading: { pct: 5, at: T0 }, records: [], weights: DEFAULT_WEIGHTS })
    ).toBeUndefined()
    // Without the window's start, older use would count as this window's: unknown.
    const old = {
      id: 'o',
      ts: T0 - 30 * 86_400_000,
      key: 'w:old',
      project: 'p',
      env: 'windows',
      model: 'claude-opus-4-5',
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 1_000_000
    } as UsageRecord
    expect(
      pctPerWeightedToken({ reading: { pct: 5, at: T0 }, records: [old], weights: DEFAULT_WEIGHTS })
    ).toBeUndefined()
  })

  it('API billing: dollars, no share of the 5-hour window', () => {
    const e = estimateResume({ ...base, billing: 'api', dollarsPerPct: 0.5, now: cold })
    expect(e.resume.pct5h).toBeUndefined()
    expect(e.resume.costUsd).toBeCloseTo(1.0)
    expect(e.unknown).toBeUndefined()
  })

  it('an unpriced model says so', () => {
    const e = estimateResume({ ...base, ctx: { ...ctx, model: 'mystery-model' }, now: cold })
    expect(e.unknown).toMatch(/No price/)
  })
})

describe('priceModelId', () => {
  it('aliases, ids, and the session model for the default', () => {
    expect(priceModelId('sonnet', undefined, DEFAULT_PRICES)).toMatch(/sonnet/)
    expect(priceModelId('opus[1m]', undefined, DEFAULT_PRICES)).toMatch(/opus/)
    expect(priceModelId('claude-haiku-4-5', undefined, DEFAULT_PRICES)).toBe('claude-haiku-4-5')
    expect(priceModelId(undefined, 'claude-sonnet-4-5', DEFAULT_PRICES)).toBe('claude-sonnet-4-5')
    expect(priceModelId('default', undefined, DEFAULT_PRICES)).toMatch(/opus/)
  })
})
