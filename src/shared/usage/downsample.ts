// Fewer points for a chart: a long range by day (e.g. all time) has more
// buckets than a chart has pixels to show them. Above `max` points,
// neighbouring buckets are added together, so every total stays the same.

import type { SeriesPoint } from './types'

/** Points a usage chart draws at most. */
export const MAX_CHART_POINTS = 400

/** A chart point; `merged` buckets were added into it, the last starting at `lastStart`. */
export interface ChartPoint extends SeriesPoint {
  merged?: number
  lastStart?: number
}

const NUMBERS = [
  'input',
  'output',
  'cacheWrite',
  'cacheRead',
  'total',
  'cost',
  'responses'
] as const

function addInto(to: Record<string, number>, from: Record<string, number> | undefined): void {
  if (!from) return
  for (const k in from) to[k] = (to[k] ?? 0) + from[k]
}

/** `points` as they are when there are at most `max`; else runs of k buckets added together. */
export function downsampleSeries(
  points: SeriesPoint[],
  max: number = MAX_CHART_POINTS
): ChartPoint[] {
  if (points.length <= max || max < 1) return points
  const k = Math.ceil(points.length / max)
  const out: ChartPoint[] = []
  for (let i = 0; i < points.length; i += k) {
    const run = points.slice(i, i + k)
    const first = run[0]
    const p: ChartPoint = {
      bucket: first.bucket,
      start: first.start,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      total: 0,
      cost: 0,
      responses: 0,
      byModel: {},
      merged: run.length,
      lastStart: run[run.length - 1].start
    }
    for (const x of run) {
      for (const n of NUMBERS) p[n] += x[n]
      if (x.reasoning) p.reasoning = (p.reasoning ?? 0) + x.reasoning
      addInto(p.byModel, x.byModel)
      if (x.byProvider) addInto((p.byProvider ??= {}), x.byProvider)
    }
    out.push(p)
  }
  return out
}
