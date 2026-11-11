import { formatTokens } from '@shared/format'
import type { MetricDef } from '@shared/usage/trends'
import type { Period, SeriesPoint } from '@shared/usage/types'

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' })
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' })
const longDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric'
})

export function bucketLabel(p: Pick<SeriesPoint, 'start'>, period: Period, long = false): string {
  if (period === 'hour')
    return long
      ? `${longDate.format(p.start)}, ${hourFmt.format(p.start)}`
      : hourFmt.format(p.start)
  if (period === 'month') return monthFmt.format(p.start)
  if (period === 'week') return `${long ? 'Week of ' : ''}${shortDate.format(p.start)}`
  return long ? longDate.format(p.start) : shortDate.format(p.start)
}

export function formatMetric(
  m: Pick<MetricDef<string>, 'unit'>,
  v: number | undefined,
  precise = false
): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  if (v === 0) return m.unit === 'percent' ? '0%' : m.unit === 'seconds' ? '0s' : '0'
  switch (m.unit) {
    case 'tokens':
      return v >= 10_000 ? formatTokens(v) : Math.round(v).toLocaleString('en-US')
    case 'seconds':
      return `${v.toFixed(v < 10 || precise ? 1 : 0)}s`
    case 'percent':
      return `${v.toFixed(v < 10 || precise ? 1 : 0)}%`
    case 'count':
      return v.toFixed(2)
    case 'chars':
      return Math.round(v).toLocaleString('en-US')
    case 'tps':
      return formatTps(v)
  }
}

/** "89 tok/s" (one decimal below 10). */
export function formatTps(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  return `${v.toFixed(v < 10 ? 1 : 0)} tok/s`
}

/** "1.6s" or "850 ms": a time to first token. */
export function formatTtft(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'n/a'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

/** "2:47 PM" later today, else "Thu 9:00 AM": when a window resets or a limit is hit. */
export function when(ts: number, t: number): string {
  return ts - t < 20 * 3_600_000 && new Date(ts).getDate() === new Date(t).getDate()
    ? timeFmt.format(ts)
    : dayTimeFmt.format(ts)
}
