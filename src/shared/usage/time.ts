// Calendar helpers in a given IANA time zone (local by default), so day, week
// and month buckets follow the user's clock, including DST changes.

import type { Period, WeekStart } from './types'

const fmtCache = new Map<string, Intl.DateTimeFormat>()

function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    fmtCache.set(timeZone, f)
  }
  return f
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export interface LocalParts {
  y: number
  m: number
  d: number
  h: number
  min: number
  s: number
}

export function localParts(ts: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {}
  for (const p of fmt(timeZone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function dayKey(ts: number, timeZone: string): string {
  const p = localParts(ts, timeZone)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

export function monthKey(ts: number, timeZone: string): string {
  const p = localParts(ts, timeZone)
  return `${p.y}-${pad(p.m)}`
}

/** Calendar arithmetic on a "YYYY-MM-DD" key (time-zone free). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function weekday(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Key of the first day of the week containing `ts`. */
export function weekKey(ts: number, timeZone: string, weekStart: WeekStart): string {
  const day = dayKey(ts, timeZone)
  const wd = weekday(day)
  const offset = weekStart === 'monday' ? (wd + 6) % 7 : wd
  return addDays(day, -offset)
}

export function bucketKey(
  ts: number,
  period: Period,
  timeZone: string,
  weekStart: WeekStart
): string {
  if (period === 'hour') {
    const p = localParts(ts, timeZone)
    return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}`
  }
  if (period === 'day') return dayKey(ts, timeZone)
  if (period === 'week') return weekKey(ts, timeZone, weekStart)
  return monthKey(ts, timeZone)
}

/** Offset of `timeZone` from UTC at instant `ts`, in ms. */
function tzOffset(ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s)
  return asUtc - Math.floor(ts / 1000) * 1000
}

/** Epoch ms of local midnight at the start of day `key` in `timeZone`. */
export function startOfDayKey(key: string, timeZone: string): number {
  const [y, m, d] = key.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  // Two passes handle DST transitions around midnight.
  let t = guess - tzOffset(guess, timeZone)
  t = guess - tzOffset(t, timeZone)
  return t
}

/** Start (inclusive) of the bucket `key` and of the next bucket. */
export function bucketRange(
  key: string,
  period: Period,
  timeZone: string
): { start: number; end: number } {
  if (period === 'hour') {
    const [day, h] = key.split('T')
    const start = startOfDayKey(day, timeZone) + Number(h) * 3_600_000
    return { start, end: start + 3_600_000 }
  }
  if (period === 'day') {
    return { start: startOfDayKey(key, timeZone), end: startOfDayKey(addDays(key, 1), timeZone) }
  }
  if (period === 'week') {
    return { start: startOfDayKey(key, timeZone), end: startOfDayKey(addDays(key, 7), timeZone) }
  }
  const [y, m] = key.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`
  return {
    start: startOfDayKey(`${key}-01`, timeZone),
    end: startOfDayKey(`${next}-01`, timeZone)
  }
}

export function nextBucket(key: string, period: Period): string {
  if (period === 'hour') {
    const [day, h] = key.split('T')
    const n = Number(h) + 1
    return n >= 24 ? `${addDays(day, 1)}T00` : `${day}T${pad(n)}`
  }
  if (period === 'day') return addDays(key, 1)
  if (period === 'week') return addDays(key, 7)
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`
}

export function prevBucket(key: string, period: Period): string {
  if (period === 'hour') {
    const [day, h] = key.split('T')
    const n = Number(h) - 1
    return n < 0 ? `${addDays(day, -1)}T23` : `${day}T${pad(n)}`
  }
  if (period === 'day') return addDays(key, -1)
  if (period === 'week') return addDays(key, -7)
  const [y, m] = key.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`
}

/** Every bucket key from `fromKey` to `toKey`, inclusive. */
export function bucketKeys(fromKey: string, toKey: string, period: Period, max = 2000): string[] {
  const out: string[] = []
  let k = fromKey
  while (k <= toKey && out.length < max) {
    out.push(k)
    k = nextBucket(k, period)
  }
  return out
}
