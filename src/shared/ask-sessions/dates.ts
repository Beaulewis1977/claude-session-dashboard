// Dates in a question ("last week", "in October", "since Oct 3", "between
// Oct 1 and Oct 15", "yesterday", "the past 30 days"), as a range of local
// days in my time zone. Weeks start on the day Settings says.

import { addDays, dayKey, startOfDayKey, weekday, weekKey } from '../usage/time'
import type { WeekStart } from '../usage/types'

export interface DateRange {
  /** Local day keys: first day, and the day after the last (exclusive). */
  fromKey: string
  toKey: string
  from: number
  to: number
  /** How it reads ("last week (Nov 2 – Nov 8, 2026)"). */
  label: string
  /** Where in the (lower-cased) question it was found. */
  at: [number, number]
  /** It came with a preposition ("in October", "since …"), not a bare word ("the October release"). */
  explicit: boolean
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]
const MONTH_NC =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const MONTH_RE = `(${MONTH_NC})`
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WD_NC =
  '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)'
const WD_RE = `(${WD_NC})`
const NUM_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  thirty: 30,
  ninety: 90
}

const pad = (n: number): string => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

function monthIndex(s: string): number {
  const t = s.toLowerCase().slice(0, 3)
  return MONTHS.findIndex((m) => m.startsWith(t))
}

function weekdayIndex(s: string): number {
  const t = s.toLowerCase().slice(0, 3)
  return WEEKDAYS.findIndex((w) => w.startsWith(t))
}

function monthStart(y: number, m: number): string {
  return key(y, m, 1)
}

function nextMonth(y: number, m: number): string {
  return m === 12 ? key(y + 1, 1, 1) : key(y, m + 1, 1)
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Nov 2, 2026". */
export function dayLabel(k: string): string {
  const [y, m, d] = k.split('-').map(Number)
  return `${SHORT_MONTH[m - 1]} ${d}, ${y}`
}

/** "Nov 2 – Nov 8, 2026" for a range of day keys (`toKey` exclusive). */
export function rangeLabel(fromKey: string, toKey: string): string {
  const last = addDays(toKey, -1)
  if (last === fromKey) return dayLabel(fromKey)
  const [fy] = fromKey.split('-').map(Number)
  const [ly] = last.split('-').map(Number)
  const f = dayLabel(fromKey)
  return fy === ly ? `${f.slice(0, f.lastIndexOf(','))} – ${dayLabel(last)}` : `${f} – ${dayLabel(last)}`
}

interface Ctx {
  today: string
  y: number
  m: number
  d: number
  weekStart: WeekStart
}

/** One date ("oct 3", "2026-10-03", "10/3", "october", "tuesday", "today"): its day key. */
function parseDay(s: string, c: Ctx, end = false): string | undefined {
  const t = s.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ')
  let m: RegExpExecArray | null
  if (t === 'today' || t === 'now') return end ? addDays(c.today, 1) : c.today
  if (t === 'yesterday') return end ? c.today : addDays(c.today, -1)
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
    const k = key(+m[1], +m[2], +m[3])
    return end ? addDays(k, 1) : k
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : c.y
    const k = key(y, +m[1], +m[2])
    const kk = !m[3] && k > c.today ? key(y - 1, +m[1], +m[2]) : k
    return end ? addDays(kk, 1) : kk
  }
  if ((m = new RegExp(`^${MONTH_RE}\\s+(\\d{1,2})(?:\\s+(\\d{4}))?$`).exec(t))) {
    const mi = monthIndex(m[1]) + 1
    let y = m[3] ? +m[3] : c.y
    if (!m[3] && key(y, mi, +m[2]) > c.today) y--
    const k = key(y, mi, Math.min(+m[2], daysIn(y, mi)))
    return end ? addDays(k, 1) : k
  }
  if ((m = new RegExp(`^(\\d{1,2})\\s+${MONTH_RE}(?:\\s+(\\d{4}))?$`).exec(t))) {
    const mi = monthIndex(m[2]) + 1
    let y = m[3] ? +m[3] : c.y
    if (!m[3] && key(y, mi, +m[1]) > c.today) y--
    const k = key(y, mi, Math.min(+m[1], daysIn(y, mi)))
    return end ? addDays(k, 1) : k
  }
  if ((m = new RegExp(`^${MONTH_RE}(?:\\s+(\\d{4}))?$`).exec(t))) {
    const mi = monthIndex(m[1]) + 1
    let y = m[2] ? +m[2] : c.y
    if (!m[2] && mi > c.m) y--
    return end ? nextMonth(y, mi) : monthStart(y, mi)
  }
  if ((m = new RegExp(`^(?:last\\s+)?${WD_RE}$`).exec(t))) {
    const want = weekdayIndex(m[1])
    let k = c.today
    if (/^last\s/.test(t)) k = addDays(k, -1)
    for (let i = 0; i < 7 && weekday(k) !== want; i++) k = addDays(k, -1)
    return end ? addDays(k, 1) : k
  }
  return undefined
}

// Non-capturing inside: a pattern's groups are only its own.
const DAY_RE = `(?:today|yesterday|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|${MONTH_NC}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NC}(?:,?\\s+\\d{4})?|${MONTH_NC}(?:\\s+\\d{4})?|(?:last\\s+)?${WD_NC})`

/**
 * The first date range in `q` (lower case is fine), relative to `now` in
 * `timeZone`. Undefined when it has none.
 */
export function findDateRange(
  q: string,
  now: number,
  timeZone: string,
  weekStart: WeekStart
): DateRange | undefined {
  const text = q.toLowerCase()
  const today = dayKey(now, timeZone)
  const [y, m, d] = today.split('-').map(Number)
  const c: Ctx = { today, y, m, d, weekStart }
  const make = (
    fromKey: string,
    toKey: string,
    label: string,
    at: [number, number],
    explicit = true
  ): DateRange | undefined =>
    toKey > fromKey
      ? {
          fromKey,
          toKey,
          from: startOfDayKey(fromKey, timeZone),
          to: startOfDayKey(toKey, timeZone),
          label: `${label} (${rangeLabel(fromKey, toKey)})`,
          at,
          explicit
        }
      : undefined
  const tests: [RegExp, (mm: RegExpExecArray) => DateRange | undefined][] = [
    [
      new RegExp(`\\b(?:between|from)\\s+(${DAY_RE})\\s+(?:and|to|until|through|-|–)\\s+(${DAY_RE})\\b`),
      (mm) => {
        const a = parseDay(mm[1], c)
        const b = parseDay(mm[2], c, true)
        return a && b ? make(a, b, 'between', span(mm)) : undefined
      }
    ],
    [
      new RegExp(`\\b(since|after|before|until|till)\\s+(${DAY_RE})\\b`),
      (mm) => {
        const word = mm[1]
        const day = mm[2]
        if (word === 'since') {
          const a = parseDay(day, c)
          return a ? make(a, addDays(today, 1), `since ${day}`, span(mm)) : undefined
        }
        if (word === 'after') {
          const a = parseDay(day, c, true)
          return a ? make(a, addDays(today, 1), `after ${day}`, span(mm)) : undefined
        }
        const b = parseDay(day, c)
        return b ? make('2000-01-01', b, `before ${day}`, span(mm)) : undefined
      }
    ],
    [
      /\b(?:in\s+|over\s+|during\s+|for\s+)?(?:the\s+)?(?:last|past|previous)\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|thirty|ninety)\s+(day|week|month|year)s?\b/,
      (mm) => {
        const n = /^\d+$/.test(mm[1]) ? +mm[1] : (NUM_WORDS[mm[1]] ?? 1)
        const unit = mm[2]
        const end = addDays(today, 1)
        const days = unit === 'day' ? n : unit === 'week' ? 7 * n : unit === 'month' ? 30 * n : 365 * n
        return make(addDays(end, -days), end, `the last ${n} ${unit}${n === 1 ? '' : 's'}`, span(mm))
      }
    ],
    [
      /\b(today|yesterday|this week|last week|previous week|this month|last month|previous month|this year|last year)\b/,
      (mm) => {
        const w = mm[1]
        if (w === 'today') return make(today, addDays(today, 1), 'today', span(mm))
        if (w === 'yesterday') return make(addDays(today, -1), today, 'yesterday', span(mm))
        const ws = weekKey(now, timeZone, weekStart)
        if (w === 'this week') return make(ws, addDays(today, 1), 'this week', span(mm))
        if (w === 'last week' || w === 'previous week')
          return make(addDays(ws, -7), ws, 'last week', span(mm))
        if (w === 'this month') return make(monthStart(y, m), addDays(today, 1), 'this month', span(mm))
        if (w === 'last month' || w === 'previous month') {
          const py = m === 1 ? y - 1 : y
          const pm = m === 1 ? 12 : m - 1
          return make(monthStart(py, pm), monthStart(y, m), 'last month', span(mm))
        }
        if (w === 'this year') return make(key(y, 1, 1), addDays(today, 1), 'this year', span(mm))
        return make(key(y - 1, 1, 1), key(y, 1, 1), 'last year', span(mm))
      }
    ],
    [
      new RegExp(`\\b(on|last)\\s+${WD_RE}\\b`),
      (mm) => {
        const k = parseDay(mm[1] === 'last' ? `last ${mm[2]}` : mm[2], c)
        return k ? make(k, addDays(k, 1), `${mm[1]} ${mm[2]}`, span(mm)) : undefined
      }
    ],
    [
      new RegExp(`\\bon\\s+(${DAY_RE})\\b`),
      (mm) => {
        const k = parseDay(mm[1], c)
        return k ? make(k, addDays(k, 1), `on ${mm[1]}`, span(mm)) : undefined
      }
    ],
    [
      new RegExp(`\\b(in|during|for|throughout|last)?\\s*${MONTH_RE}(?:\\s+(\\d{4}))?\\b`),
      (mm) => {
        const mi = monthIndex(mm[2]) + 1
        if (mi <= 0) return undefined
        // "may" alone is a verb more often than a month.
        if (mm[2] === 'may' && !mm[1] && !mm[3]) return undefined
        let yy = mm[3] ? +mm[3] : y
        if (!mm[3] && (mi > m || (mm[1] === 'last' && mi === m))) yy--
        return make(
          monthStart(yy, mi),
          nextMonth(yy, mi),
          `${MONTHS[mi - 1][0].toUpperCase()}${MONTHS[mi - 1].slice(1)} ${yy}`,
          span(mm),
          !!mm[1]
        )
      }
    ],
    [
      /\b(in|during)\s+(20[0-9]{2})\b/,
      (mm) => make(key(+mm[2], 1, 1), key(+mm[2] + 1, 1, 1), mm[2], span(mm))
    ]
  ]
  // The first kind (in this order) that reads as a date wins.
  for (const [re, fn] of tests) {
    const mm = re.exec(text)
    const r = mm ? fn(mm) : undefined
    if (r) return r
  }
  return undefined
}

function span(mm: RegExpExecArray): [number, number] {
  const start = mm.index + (mm[0].length - mm[0].trimStart().length)
  return [start, mm.index + mm[0].length]
}
