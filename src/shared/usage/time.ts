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

/** The calendar parts straight from Intl (slow: one formatToParts per call). */
export function localPartsExact(ts: number, timeZone: string): LocalParts {
  const out: Record<string, number> = {}
  for (const p of fmt(timeZone).formatToParts(new Date(ts))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second }
}

/**
 * Time-zone offsets are looked up once per 15-minute slot (every zone's
 * offset changes only on a quarter hour). A slot whose start and end have
 * different offsets (it holds a change) is never cached: its instants go to
 * Intl one by one. Results are the same as localPartsExact's.
 */
const SLOT_MS = 15 * 60_000
const SLOT_CACHE_MAX = 200_000
/** Per zone: slot → offset in ms, or NaN for a slot with a change in it. */
const slotCache = new Map<string, Map<number, number>>()
/** The last zone looked up (most calls ask for the same one). */
let lastZone = ''
let lastSlots: Map<number, number> | undefined

/** Offset at `ts` (whole seconds, as localPartsExact sees it), in ms. */
function exactOffset(ts: number, timeZone: string): number {
  const p = localPartsExact(ts, timeZone)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000
}

function slotOffset(ts: number, timeZone: string): number {
  let slots = timeZone === lastZone ? lastSlots : slotCache.get(timeZone)
  if (!slots) {
    slots = new Map()
    slotCache.set(timeZone, slots)
  }
  lastZone = timeZone
  lastSlots = slots
  const slot = Math.floor(ts / SLOT_MS)
  let off = slots.get(slot)
  if (off === undefined) {
    const start = slot * SLOT_MS
    const a = exactOffset(start, timeZone)
    const b = exactOffset(start + SLOT_MS - 1, timeZone)
    // A whole-second offset that holds for the whole slot, or NaN (look up each instant).
    off = a === b && a % 1000 === 0 ? a : NaN
    if (slots.size >= SLOT_CACHE_MAX) slots.clear()
    slots.set(slot, off)
  }
  return off
}

export function localParts(ts: number, timeZone: string): LocalParts {
  if (!Number.isFinite(ts)) return localPartsExact(ts, timeZone)
  const off = slotOffset(ts, timeZone)
  if (Number.isNaN(off)) return localPartsExact(ts, timeZone)
  // Intl works in whole seconds (it drops the milliseconds).
  const d = new Date(Math.floor(ts / 1000) * 1000 + off)
  const y = d.getUTCFullYear()
  // Years before 1 or after 9999 print differently in Intl: leave those to it.
  if (y < 1 || y > 9999) return localPartsExact(ts, timeZone)
  return {
    y,
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    s: d.getUTCSeconds()
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Per zone: slot → its day key (slots whose offset is a whole quarter hour never cross midnight). */
const daySlots = new Map<string, Map<number, string>>()

export function dayKey(ts: number, timeZone: string): string {
  if (Number.isFinite(ts)) {
    const off = slotOffset(ts, timeZone)
    if (!Number.isNaN(off) && off % SLOT_MS === 0) {
      let days = daySlots.get(timeZone)
      if (!days) daySlots.set(timeZone, (days = new Map()))
      const slot = Math.floor(ts / SLOT_MS)
      let k = days.get(slot)
      if (k === undefined) {
        const p = localParts(ts, timeZone)
        k = `${p.y}-${pad(p.m)}-${pad(p.d)}`
        if (days.size >= SLOT_CACHE_MAX) days.clear()
        days.set(slot, k)
      }
      return k
    }
  }
  const p = localParts(ts, timeZone)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

export function monthKey(ts: number, timeZone: string): string {
  // The day key without its day ("2026-10-22" → "2026-10").
  const day = dayKey(ts, timeZone)
  return day.slice(0, day.lastIndexOf('-'))
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
  return weekOfDay(dayKey(ts, timeZone), weekStart)
}

/** Day key → its week's key, per week start (pure calendar math, so kept). */
const weekOf = { monday: new Map<string, string>(), sunday: new Map<string, string>() }

function weekOfDay(day: string, weekStart: WeekStart): string {
  const memo = weekStart === 'monday' ? weekOf.monday : weekOf.sunday
  let k = memo.get(day)
  if (k === undefined) {
    const wd = weekday(day)
    const offset = weekStart === 'monday' ? (wd + 6) % 7 : wd
    k = addDays(day, -offset)
    if (memo.size >= 100_000) memo.clear()
    memo.set(day, k)
  }
  return k
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
