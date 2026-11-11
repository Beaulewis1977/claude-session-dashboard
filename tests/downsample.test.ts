import { describe, expect, it } from 'vitest'
import { downsampleSeries, MAX_CHART_POINTS } from '@shared/usage/downsample'
import type { SeriesPoint } from '@shared/usage/types'

const DAY = 86_400_000

function series(n: number, byProvider = false): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    bucket: `d${i}`,
    start: i * DAY,
    input: i,
    output: 2 * i,
    cacheWrite: 3,
    cacheRead: 10 * i,
    total: 13 * i + 3,
    cost: i * 0.5,
    responses: 1,
    ...(i % 3 ? { reasoning: 1 } : {}),
    byModel: { a: i, ...(i % 2 ? { b: 1 } : {}) },
    ...(byProvider ? { byProvider: { claude: i, codex: 2 } } : {})
  }))
}

const sum = (ps: SeriesPoint[], f: (p: SeriesPoint) => number) => ps.reduce((a, p) => a + f(p), 0)

describe('downsampleSeries', () => {
  it('leaves a series with few enough points as it is', () => {
    const s = series(MAX_CHART_POINTS)
    expect(downsampleSeries(s)).toBe(s)
  })

  it('adds neighbouring buckets together above the cap, every total unchanged', () => {
    const s = series(1000, true)
    const d = downsampleSeries(s)
    expect(d.length).toBeLessThanOrEqual(MAX_CHART_POINTS)
    expect(d.length).toBe(334) // runs of 3
    for (const f of [
      (p: SeriesPoint) => p.input,
      (p: SeriesPoint) => p.output,
      (p: SeriesPoint) => p.cacheWrite,
      (p: SeriesPoint) => p.cacheRead,
      (p: SeriesPoint) => p.total,
      (p: SeriesPoint) => p.responses,
      (p: SeriesPoint) => p.reasoning ?? 0,
      (p: SeriesPoint) => p.byModel.a ?? 0,
      (p: SeriesPoint) => p.byModel.b ?? 0,
      (p: SeriesPoint) => p.byProvider?.claude ?? 0,
      (p: SeriesPoint) => p.byProvider?.codex ?? 0
    ])
      expect(sum(d, f)).toBe(sum(s, f))
    expect(sum(d, (p) => p.cost)).toBeCloseTo(
      sum(s, (p) => p.cost),
      9
    )
    // Each point starts at its first bucket and says where its last one starts.
    expect(d[1]).toMatchObject({ bucket: 'd3', start: 3 * DAY, merged: 3, lastStart: 5 * DAY })
    // The last run can be shorter.
    expect(d[d.length - 1]).toMatchObject({ bucket: 'd999', merged: 1, lastStart: 999 * DAY })
  })

  it('keeps byProvider absent when the series has none', () => {
    expect(downsampleSeries(series(900)).every((p) => p.byProvider === undefined)).toBe(true)
  })
})
