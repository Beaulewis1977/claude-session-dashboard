import { describe, expect, it } from 'vitest'
import {
  compareHealth,
  compareRange,
  computeBaseline,
  familyPricer,
  DEFAULT_HEALTH,
  healthReport,
  planAt,
  planSpans,
  sanitizePlanHistory,
  scoreWindows,
  splitWindow,
  verdictOf,
  ymdStart,
  type HealthSettings,
  type WindowReading
} from '@shared/usage/health'
import { DEFAULT_PACE, paceAdvice, paceOf } from '@shared/usage/pace'
import { costParts, estimateCost, type ModelPrice } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'

const H = 3_600_000
const DAY = 24 * H

// Simple round prices so the arithmetic is easy to follow ($ per million tokens).
const PRICES: ModelPrice[] = [
  {
    model: 'claude-opus-5-5',
    label: 'Opus',
    input: 4,
    output: 20,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2
  }
]

let n = 0
function rec(ts: number, output: number, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `r${n++}`,
    ts,
    key: 'windows:s1',
    project: 'p',
    env: 'windows',
    model: 'claude-opus-5-5',
    input: 0,
    output,
    cacheWrite: 0,
    cacheRead: 0,
    ...extra
  }
}

/** A day at 10:00 local, `d` days after Sep 1. */
const day = (d: number): number => ymdStart('2026-09-01') + d * DAY + 10 * H

/**
 * One 5-hour window per day: 100k output tokens ($2 at $20/MTok) and one
 * bridge reading at the end showing `pct`.
 */
function windows(pcts: number[]): { readings: WindowReading[]; records: UsageRecord[] } {
  const readings: WindowReading[] = []
  const records: UsageRecord[] = []
  pcts.forEach((pct, d) => {
    const start = day(d)
    records.push(rec(start + H, 50_000), rec(start + 2 * H, 50_000))
    readings.push({ ts: start + 3 * H, pct, resetsAt: start + 5 * H, from: 'bridge' })
  })
  return { readings, records: records.sort((a, b) => a.ts - b.ts) }
}

const base: HealthSettings = {
  ...DEFAULT_HEALTH,
  baselineFrom: '2026-09-01',
  baselineTo: '2026-09-04'
}
const opts = (s: Partial<HealthSettings> = {}) => ({
  kind: 'five_hour' as const,
  prices: PRICES,
  now: day(60),
  settings: { ...base, ...s },
  planHistory: [],
  currentPlan: 'pro' as const
})

describe('cost parts', () => {
  it('splits the API-equivalent cost by token type, 5m and 1h cache writes priced apart', () => {
    const r = {
      model: 'claude-opus-5-5',
      input: 1e6,
      output: 1e6,
      cacheRead: 1e6,
      cacheWrite: 2e6,
      cw1h: 1e6
    }
    const p = costParts(r, PRICES)
    expect(p.input).toBeCloseTo(4)
    expect(p.output).toBeCloseTo(20)
    expect(p.cacheRead).toBeCloseTo(0.2)
    expect(p.cacheWrite).toBeCloseTo(13)
    expect(estimateCost(r, PRICES)).toBeCloseTo(37.2)
  })
})

describe('window scoring', () => {
  it('scores $ per 1% from the window start to the highest reading', () => {
    const { readings, records } = windows([20])
    const { windows: ws } = scoreWindows(readings, records, opts())
    expect(ws).toHaveLength(1)
    expect(ws[0].dollars).toBeCloseTo(2)
    expect(ws[0].perPct).toBeCloseTo(0.1)
    expect(ws[0].tokens.output).toBe(100_000)
    expect(ws[0].mix.output).toBeCloseTo(2)
    expect(ws[0].closed).toBe(true)
  })

  it('counts each response once and only the window it falls in', () => {
    const { readings, records } = windows([20, 20])
    // A record just before the window and one after the reading are left out.
    records.push(rec(day(0) - 1, 1_000_000), rec(day(0) + 4 * H, 1_000_000))
    records.sort((a, b) => a.ts - b.ts)
    const { windows: ws } = scoreWindows(readings, records, opts())
    expect(ws.map((w) => w.dollars)).toEqual([2, 2])
  })

  it('skips windows under the minimum %', () => {
    const { readings, records } = windows([5, 9.9, 10, 40])
    const res = scoreWindows(readings, records, opts())
    expect(res.windows.map((w) => w.pct)).toEqual([10, 40])
    expect(res.skippedLow).toBe(2)
  })

  it('takes the baseline as the median of the trusted dates, per 1x of plan', () => {
    // Sep 1–4: $/1% = 0.1, 0.2, 0.1, 0.05 → median 0.1
    const { readings, records } = windows([20, 10, 20, 40, 20])
    const res = scoreWindows(readings, records, opts())
    expect(res.baseline?.n).toBe(4)
    expect(res.baseline?.value).toBeCloseTo(0.1)
    expect(res.baseline?.mixShare.output).toBeCloseTo(1)
  })

  it('compares each window with baseline × its own plan multiplier', () => {
    const { readings, records } = windows([20, 20, 20, 20, 4, 4])
    // Pro until Sep 5, then Max 5x: the same $2 at 4% is exactly 5x the Pro baseline.
    const planHistory = sanitizePlanHistory([
      { from: '2026-08-01', plan: 'pro' },
      { from: '2026-09-05', plan: 'max5' }
    ])
    const res = scoreWindows(readings, records, { ...opts({ minPct: 1 }), planHistory })
    expect(res.baseline?.value).toBeCloseTo(0.1)
    const max = res.windows.filter((w) => w.mult === 5)
    expect(max).toHaveLength(2)
    expect(max[0].expected).toBeCloseTo(0.5)
    expect(max[0].ratio).toBeCloseTo(1)
    expect(max[0].plan).toBe('Max 5x')
  })

  it('uses the plan at the time of the reading, and leaves out a window that spans a change', () => {
    // Pro baseline Sep 1–4 ($2 at 20% = 0.1 $/1%), then Max 5x from Sep 6.
    const { readings, records } = windows([20, 20, 20, 20])
    const planHistory = sanitizePlanHistory([
      { from: '2026-08-01', plan: 'pro' },
      { from: '2026-09-06', plan: 'max5' }
    ])
    const sep6 = ymdStart('2026-09-06')
    // Used and read on Pro (Sep 5, 9–11 PM); the window resets after the upgrade.
    const before = {
      readings: [{ ts: sep6 - H, pct: 20, resetsAt: sep6 + 2 * H, from: 'bridge' as const }],
      records: [rec(sep6 - 2.5 * H, 50_000), rec(sep6 - 1.5 * H, 50_000)]
    }
    const a = scoreWindows([...readings, ...before.readings], [...records, ...before.records], {
      ...opts({ minPct: 1 }),
      planHistory
    })
    const w = a.windows.find((x) => x.resetsAt === sep6 + 2 * H)!
    expect(w.plan).toBe('Pro')
    expect(w.ratio).toBeCloseTo(1)
    expect(w.low).toBe(false)
    expect(w.excluded).toBeUndefined()

    // Started on Pro, read on Max 5x: no single plan, so it's left out.
    const across = {
      readings: [{ ts: sep6 + H, pct: 20, resetsAt: sep6 + 2 * H, from: 'bridge' as const }],
      records: [rec(sep6 - 2.5 * H, 50_000), rec(sep6 + 0.5 * H, 50_000)]
    }
    const b = scoreWindows([...readings, ...across.readings], [...records, ...across.records], {
      ...opts({ minPct: 1 }),
      planHistory
    })
    const x = b.windows.find((y) => y.resetsAt === sep6 + 2 * H)!
    expect(x.excluded).toBe('plan-change')
    expect(x.warning).toMatch(/plan changed/)
    // The baseline and the other windows are unaffected.
    expect(b.baseline?.value).toBeCloseTo(0.1)
    expect(b.windows.filter((y) => y.excluded)).toHaveLength(1)
  })

  it('stores a baseline taken on Max per 1x, so it applies to Pro too', () => {
    const { readings, records } = windows([4, 4, 4, 20])
    const res = scoreWindows(readings, records, {
      ...opts({ minPct: 1, baselineFrom: '2026-09-01', baselineTo: '2026-09-03' }),
      planHistory: sanitizePlanHistory([
        { from: '2026-09-01', plan: 'max5' },
        { from: '2026-09-04', plan: 'pro' }
      ])
    })
    expect(res.baseline?.value).toBeCloseTo(0.1) // 0.5 $/1% on 5x → 0.1 per 1x
    expect(res.windows[3].ratio).toBeCloseTo(1)
  })

  it('uses the current plan setting when no history is recorded (default Max 5x)', () => {
    const spans = planSpans([], 'max5')
    expect(planAt(spans, Date.now()).mult).toBe(5)
    expect(
      sanitizePlanHistory([{ from: '2026-01-01', plan: 'custom', mult: 1.25, label: 'Team' }])
    ).toEqual([{ from: '2026-01-01', plan: 'custom', mult: 1.25, label: 'Team' }])
    expect(
      sanitizePlanHistory([
        { from: 'bad', plan: 'pro' },
        { from: '2026-01-01', plan: 'custom' }
      ])
    ).toEqual([])
  })
})

describe('family pricing', () => {
  const table: ModelPrice[] = [
    {
      model: 'claude-opus-5',
      label: 'Opus 5',
      input: 5,
      output: 25,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5
    },
    {
      model: 'claude-opus-5-5',
      label: 'Opus 5.5',
      input: 4,
      output: 20,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      cacheRead: 0.2
    },
    {
      model: 'claude-3-opus',
      label: 'Opus 3',
      input: 15,
      output: 75,
      cacheWrite5m: 18.75,
      cacheWrite1h: 30,
      cacheRead: 1.5
    }
  ]
  it('prices every model of a family at the newest member, so a cheaper model is not a cut', () => {
    expect(familyPricer(table)('claude-opus-5-20260101')).toBe('claude-opus-5-5')
    expect(familyPricer(table)('claude-opus-5-fast')).toBe('claude-opus-5-5-fast')
    const readings: WindowReading[] = [0, 1].map((d) => ({
      ts: day(d) + 3 * H,
      pct: 20,
      resetsAt: day(d) + 5 * H,
      from: 'bridge'
    }))
    const records = [rec(day(0) + H, 100_000, { model: 'claude-opus-5' }), rec(day(1) + H, 100_000)]
    const fam = scoreWindows(readings, records, { ...opts(), prices: table })
    expect(fam.windows[0].dollars).toBeCloseTo(fam.windows[1].dollars)
    const exact = scoreWindows(readings, records, {
      ...opts({ familyPricing: false }),
      prices: table
    })
    expect(exact.windows[0].dollars).toBeCloseTo(2.5)
  })
})

describe('verdict', () => {
  it('needs a baseline, then enough windows', () => {
    const { readings, records } = windows([20, 20])
    const none = healthReport(
      readings,
      records,
      opts({ baselineFrom: undefined, baselineTo: undefined })
    )
    expect(none.verdict.status).toBe('needs-baseline')
    const few = healthReport(readings, records, opts())
    expect(few.verdict.status).toBe('not-enough-data')
    expect(few.verdict.needed).toBe(1)
    expect(few.verdict.headline).toBe('Not enough data yet, 1 window needed')
  })

  it('flags a possible cut only after N low windows in a row', () => {
    // Baseline 0.1 $/1%. Flag line 0.1 / 1.5 = 0.067. 40% → 0.05 (low).
    const one = healthReport(
      ...(Object.values(windows([20, 20, 20, 20, 40, 20, 40])) as [WindowReading[], UsageRecord[]]),
      opts()
    )
    expect(one.verdict.status).toBe('normal')
    expect(one.verdict.lowStreak).toBe(1)
    const two = healthReport(
      ...(Object.values(windows([20, 20, 20, 20, 20, 40, 40])) as [WindowReading[], UsageRecord[]]),
      opts()
    )
    expect(two.verdict.status).toBe('possible-reduction')
    expect(two.verdict.avgRatio).toBeCloseTo(0.5)
    expect(two.verdict.flagged).toHaveLength(2)
    const streak3 = verdictOf(two.windows, two.baseline, { ...base, streak: 3 })
    expect(streak3.status).toBe('normal')
  })

  it('ignores a 25% dip with the default threshold (1.5) but flags it at 1.25', () => {
    const { readings, records } = windows([20, 20, 20, 20, 26.7, 26.7])
    expect(healthReport(readings, records, opts()).verdict.status).toBe('normal')
    expect(healthReport(readings, records, opts({ threshold: 1.25 })).verdict.status).toBe(
      'possible-reduction'
    )
  })

  it('leaves the open window out of the verdict', () => {
    const { readings, records } = windows([20, 20, 20, 20, 40, 40])
    const r = healthReport(readings, records, { ...opts(), now: day(5) + H })
    expect(r.windows[5].closed).toBe(false)
    expect(r.verdict.status).toBe('normal')
  })
})

describe('untracked usage', () => {
  it('counts a rise with no local tokens as usage elsewhere and leaves the window out', () => {
    const { readings, records } = windows([20, 20, 20, 20])
    // Sep 5: 20% from local work, then +30% while nothing ran here.
    const s = day(4)
    records.push(rec(s + H, 100_000))
    readings.push(
      { ts: s + 1.5 * H, pct: 20, resetsAt: s + 5 * H, from: 'bridge' },
      { ts: s + 4 * H, pct: 50, resetsAt: s + 5 * H, from: 'bridge' }
    )
    records.sort((a, b) => a.ts - b.ts)
    const r = healthReport(readings, records, opts())
    const w = r.windows[4]
    expect(w.untrackedClear).toBe(30)
    expect(w.untrackedPct).toBeCloseTo(30)
    expect(w.excluded).toBe('untracked')
    expect(w.warning).toMatch(/nothing ran on this computer/)
    // Without the exclusion it would have looked like a cut.
    const kept = healthReport(readings, records, opts({ excludeUntracked: false }))
    expect(kept.windows[4].excluded).toBeUndefined()
    expect(kept.windows[4].low).toBe(true)
  })

  it('estimates the part local tokens cannot explain at the baseline rate', () => {
    const { readings, records } = windows([20, 20, 20, 20, 40])
    const r = healthReport(readings, records, opts())
    // $2 explains 20% at 0.1 $/1%; the other 20 points are unexplained.
    expect(r.windows[4].untrackedPct).toBeCloseTo(20)
    expect(r.windows[4].untrackedEstimated).toBe(true)
    expect(r.windows[4].warning).toMatch(/isn't in the local logs/)
  })

  it('leaves out windows in ranges marked as "used Claude elsewhere"', () => {
    const { readings, records } = windows([20, 20, 20, 20, 40, 40])
    const r = healthReport(readings, records, {
      ...opts(),
      elsewhere: [{ id: 'x', from: day(5), to: day(5) + 2 * H }]
    })
    expect(r.windows[5].excluded).toBe('elsewhere')
    expect(r.verdict.status).toBe('normal')
  })

  it('splits a window by source with an elsewhere slice', () => {
    const { readings, records } = windows([20, 20, 20, 20, 40])
    records.push(rec(day(4) + 2.5 * H, 0, { key: 'wsl:s2', input: 0, output: 0 }))
    const r = healthReport(readings, records, opts())
    const sp = splitWindow(r.windows[4], records, PRICES, (k) =>
      k.startsWith('wsl') ? 'Terminal (WSL)' : 'VS Code'
    )
    expect(sp.elsewhere).toBeCloseTo(20)
    expect(sp.bySource[0]).toMatchObject({ label: 'VS Code' })
    expect(sp.bySource[0].pct).toBeCloseTo(20)
  })
})

describe('compare', () => {
  it('compares two date ranges plan-adjusted, with the % change', () => {
    const { readings, records } = windows([20, 20, 20, 20, 25, 25, 25])
    const r = healthReport(readings, records, opts())
    const c = compareHealth(
      r.windows,
      'five_hour',
      { from: '2026-09-01', to: '2026-09-04' },
      { from: '2026-09-05', to: '2026-09-07' }
    )
    expect(c.a.perPct).toBeCloseTo(0.1)
    expect(c.b.perPct).toBeCloseTo(0.08)
    expect(c.changePct).toBeCloseTo(-20)
    expect(c.b.n).toBe(3)
  })

  it('computes no baseline without windows in range', () => {
    expect(computeBaseline([], base, 'five_hour')).toBeUndefined()
  })
})

describe('pace', () => {
  const t0 = Date.parse('2026-10-22T10:00:00Z')
  it('targets cap × elapsed ÷ window length', () => {
    // 2.5 of 5 hours gone → target 45% with a 90% cap.
    const p = paceOf({ pct: 45, resetsAt: t0 + 2.5 * H }, 'five_hour', t0)!
    expect(p.target).toBeCloseTo(45)
    expect(p.status).toBe('on-pace')
    expect(p.roomPerHour).toBeCloseTo(18) // 45 points left over 2.5 h
    expect(paceOf({ pct: 60, resetsAt: t0 + 2.5 * H }, 'five_hour', t0)!.status).toBe('ahead')
    expect(paceOf({ pct: 30, resetsAt: t0 + 2.5 * H }, 'five_hour', t0)!.status).toBe('behind')
    expect(paceOf({ pct: 91, resetsAt: t0 + 2.5 * H }, 'five_hour', t0)!.status).toBe('at-cap')
    expect(paceOf({ pct: 91, resetsAt: t0 - 1 }, 'five_hour', t0)!.status).toBe('reset')
  })

  it('uses the tolerance and cap settings, and the weekly window decides first', () => {
    const week = paceOf({ pct: 50, resetsAt: t0 + 3.5 * DAY }, 'seven_day', t0, {
      cap: 80,
      tolerance: 5
    })!
    expect(week.target).toBeCloseTo(40)
    expect(week.status).toBe('ahead')
    const five = paceOf({ pct: 5, resetsAt: t0 + 4 * H }, 'five_hour', t0, DEFAULT_PACE)!
    expect(paceAdvice(five, week)?.text).toMatch(/weekly pace/)
  })
})

describe('compareRange', () => {
  it('treats an empty or invalid end date as the start day, never as 1970', () => {
    expect(compareRange({ from: '2026-09-01', to: '' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-01'
    })
    expect(compareRange({ from: '2026-09-01', to: 'nope' })?.to).toBe('2026-09-01')
    expect(compareRange({ from: '2026-09-01' })?.to).toBe('2026-09-01')
  })
  it('refuses a range without a valid start and swaps reversed ones', () => {
    expect(compareRange({ from: '', to: '2026-09-01' })).toBeUndefined()
    expect(compareRange({ from: '2026-13-45', to: '2026-09-01' })).toBeUndefined()
    expect(compareRange(null)).toBeUndefined()
    expect(compareRange({ from: '2026-09-30', to: '2026-09-01' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30'
    })
  })
})
