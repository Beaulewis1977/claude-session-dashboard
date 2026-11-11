// The indexed report calculation (binary-searched ranges, cached costs and
// keys, one pass for every breakdown) gives exactly what the original raw
// calculation gave: every number, every row, every float to the last digit.
// tests/usage-reference.ts is the calculation as it was before.

import { describe, expect, it } from 'vitest'
import { buildReport } from '@shared/usage/aggregate'
import { DEFAULT_CODEX_PRICES, DEFAULT_PRICES } from '@shared/usage/pricing'
import { median as speedMedianOf } from '@shared/usage/speed'
import { dayKey, localPartsExact, monthKey, weekKey } from '@shared/usage/time'
import type { Dimension, Period, UsageQuery, UsageRecord, WeekStart } from '@shared/usage/types'
import { buildReport as referenceReport } from './usage-reference'

/** A small deterministic generator (the same data every run). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const NOW = Date.UTC(2026, 10, 10, 15, 30)
const DAY = 86_400_000
const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-opus-5-5-fast']
const CODEX = ['gpt-6.1-sol', 'gpt-5.5', 'gpt-6-astra', 'gpt-5.5-fast']

/** Records over ~14 months (some on DST days, some sharing a millisecond), sorted by time. */
function records(seed: number, n: number): UsageRecord[] {
  const r = rng(seed)
  const out: UsageRecord[] = []
  for (let i = 0; i < n; i++) {
    const codex = r() < 0.6
    const models = codex ? CODEX : CLAUDE
    // Bursts: a quarter share a time with the record before.
    const ts =
      i && r() < 0.25
        ? out[i - 1].ts
        : Math.floor(NOW - r() * 430 * DAY + (r() < 0.02 ? 2 * DAY : 0))
    const output = Math.floor(r() * 4000)
    out.push({
      id: `r${seed}-${i}`,
      ts,
      key: `${codex ? 'codex' : 'windows'}:s${Math.floor(r() * 40)}`,
      project: ['acme-web', 'api', '', 'docs'][Math.floor(r() * 4)],
      env: r() < 0.7 ? 'windows' : 'wsl',
      model: models[Math.floor(r() * models.length)],
      input: Math.floor(r() * 20000),
      output,
      cacheWrite: Math.floor(r() * 9000),
      cacheRead: Math.floor(r() * 200000),
      ...(r() < 0.3 ? { cw1h: Math.floor(r() * 500) } : {}),
      ...(r() < 0.5 ? { version: ['2.1.300', '2.1.322', '0.166.0'][Math.floor(r() * 3)] } : {}),
      ...(r() < 0.6 ? { genMs: 300 + r() * 60_000 } : {}),
      ...(r() < 0.1
        ? { extra: { 'server_tool_use.web_search_requests': Math.floor(r() * 3) } }
        : {}),
      ...(r() < 0.05 ? { loggedCost: r() * 2 } : {}),
      ...(codex ? { provider: 'codex' as const, reasoning: Math.floor(output * r()) } : {})
    })
  }
  // The usage service's lists are sorted by time (ties keep their order).
  return out.sort((a, b) => a.ts - b.ts)
}

const ZONES = ['UTC', 'America/Chicago', 'Europe/Berlin', 'Asia/Kathmandu', 'Australia/Lord_Howe']
const PERIODS: Period[] = ['hour', 'day', 'week', 'month']
const DIMS: Dimension[] = [
  'model',
  'session',
  'project',
  'env',
  'version',
  'billing',
  'source',
  'provider'
]

function startOfDay(ts: number, tz: string): number {
  // The first instant whose day key is this one (found by search, any zone).
  const key = dayKey(ts, tz)
  let lo = ts - 2 * DAY
  let hi = ts
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (dayKey(mid, tz) < key) lo = mid
    else hi = mid
  }
  return hi
}

function queries(tz: string): UsageQuery[] {
  const day = (n: number) => startOfDay(NOW - n * DAY, tz)
  const qs: UsageQuery[] = []
  for (const period of PERIODS) {
    qs.push({ period })
    qs.push({ period, from: day(29) })
    qs.push({ period, from: day(6), to: day(1) })
  }
  qs.push({ period: 'hour', from: day(0) })
  qs.push({ period: 'day', from: day(89), models: ['claude-opus-5-5', 'gpt-5.5'] })
  qs.push({ period: 'week', from: day(364), sessionKey: 'codex:s3' })
  qs.push({ period: 'day', from: NOW + DAY })
  for (const groupBy of DIMS) qs.push({ period: 'day', from: day(13), groupBy })
  return qs
}

describe('indexed usage reports equal the raw calculation', () => {
  for (const [name, list, prices, byProvider] of [
    ['Claude Code', records(1, 3000).filter((r) => !r.provider), DEFAULT_PRICES, false],
    ['Codex', records(2, 3000).filter((r) => r.provider), DEFAULT_CODEX_PRICES, false],
    ['both', records(3, 4000), [...DEFAULT_PRICES, ...DEFAULT_CODEX_PRICES], true]
  ] as const)
    for (const tz of ZONES)
      for (const weekStart of ['monday', 'sunday'] as WeekStart[])
        it(`${name}, ${tz}, weeks from ${weekStart}`, () => {
          const ctx = {
            timeZone: tz,
            weekStart,
            prices: prices as typeof DEFAULT_PRICES,
            now: NOW,
            byProvider,
            billingOf: (k: string) => (k.endsWith('1') ? 'API' : 'Max 20x'),
            sourceOf: (k: string) => (k.endsWith('2') ? 'VS Code' : 'Terminal'),
            sessionLabel: (k: string) => ({ label: `Session ${k}` })
          }
          for (const q of queries(tz)) {
            const got = buildReport(list as UsageRecord[], q, ctx)
            const want = referenceReport(list as UsageRecord[], q, ctx)
            // Exactly: JSON keeps every digit (and the key order).
            expect(JSON.stringify(got), JSON.stringify(q)).toBe(JSON.stringify(want))
          }
        })

  it('stays exact when the same list is asked again (cached index) and for a new list', () => {
    const list = records(4, 2000)
    const ctx = {
      timeZone: 'America/Chicago',
      weekStart: 'monday' as const,
      prices: DEFAULT_PRICES,
      now: NOW
    }
    const q: UsageQuery = { period: 'day', from: NOW - 30 * DAY }
    const a = JSON.stringify(buildReport(list, q, ctx))
    expect(JSON.stringify(buildReport(list, q, ctx))).toBe(a)
    expect(a).toBe(JSON.stringify(referenceReport(list, q, ctx)))
    // A list with a record more is a new list (lists are never changed in place).
    const more = [...list, { ...list[list.length - 1], id: 'extra', ts: NOW - 1000 }]
    expect(JSON.stringify(buildReport(more, q, ctx))).toBe(
      JSON.stringify(referenceReport(more, q, ctx))
    )
  })

  it('handles a list that is not in time order (no binary search)', () => {
    const list = records(5, 800).reverse()
    const ctx = { timeZone: 'UTC', weekStart: 'sunday' as const, prices: DEFAULT_PRICES, now: NOW }
    for (const q of queries('UTC'))
      expect(JSON.stringify(buildReport(list, q, ctx))).toBe(
        JSON.stringify(referenceReport(list, q, ctx))
      )
  })

  it('leaves only the raw records out when asked to (raw: false)', () => {
    const list = records(6, 1500)
    const ctx = {
      timeZone: 'Europe/Berlin',
      weekStart: 'monday' as const,
      prices: DEFAULT_PRICES,
      now: NOW
    }
    const q: UsageQuery = { period: 'day', from: NOW - 30 * DAY }
    const full = buildReport(list, q, ctx)
    const lean = buildReport(list, { ...q, raw: false }, ctx)
    expect(full.raw.length).toBeGreaterThan(0)
    expect(lean.raw).toEqual([])
    expect(JSON.stringify({ ...lean, raw: full.raw })).toBe(JSON.stringify(full))
  })

  it('handles an empty list', () => {
    const ctx = { timeZone: 'UTC', weekStart: 'monday' as const, prices: DEFAULT_PRICES, now: NOW }
    for (const q of queries('UTC'))
      expect(JSON.stringify(buildReport([], q, ctx))).toBe(
        JSON.stringify(referenceReport([], q, ctx))
      )
  })
})

describe('the cached calendar keys', () => {
  it('give the same day, week and month keys as Intl', () => {
    const r = rng(9)
    const pad = (n: number) => String(n).padStart(2, '0')
    for (const tz of [...ZONES, 'America/Santiago', 'Pacific/Chatham'])
      for (let i = 0; i < 4000; i++) {
        const ts = Math.floor(Date.UTC(2024, 0, 1) + r() * 4 * 365 * DAY)
        const p = localPartsExact(ts, tz)
        const day = `${p.y}-${pad(p.m)}-${pad(p.d)}`
        expect(dayKey(ts, tz)).toBe(day)
        expect(monthKey(ts, tz)).toBe(`${p.y}-${pad(p.m)}`)
        const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
        for (const ws of ['monday', 'sunday'] as WeekStart[]) {
          const back = ws === 'monday' ? (wd + 6) % 7 : wd
          const w = new Date(Date.UTC(p.y, p.m - 1, p.d - back))
          expect(weekKey(ts, tz, ws)).toBe(
            `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`
          )
        }
      }
  })
})

describe('median', () => {
  it('equals the comparator sort’s median, NaN included', () => {
    const r = rng(11)
    const old = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    for (let n = 1; n < 60; n++) {
      const xs = Array.from({ length: n }, () => (r() < 0.2 ? Math.floor(r() * 5) : r() * 1000))
      expect(speedMedianOf(xs)).toBe(old(xs))
    }
    const withNaN = [3, NaN, 1, 2]
    expect(speedMedianOf(withNaN)).toBe(old(withNaN))
  })
})
