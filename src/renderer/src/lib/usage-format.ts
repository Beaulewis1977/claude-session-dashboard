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
