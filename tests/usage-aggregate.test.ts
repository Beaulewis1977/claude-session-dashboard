import { describe, expect, it } from 'vitest'
import {
  breakdown,
  buildReport,
  fiveHourBlocks,
  periodCards,
  timeSeries,
  toCsv
} from '@shared/usage/aggregate'
import { DEFAULT_PRICES } from '@shared/usage/pricing'
import {
  bucketKey,
  bucketRange,
  dayKey,
  monthKey,
  startOfDayKey,
  weekKey
} from '@shared/usage/time'
import type { UsageRecord } from '@shared/usage/types'

let n = 0
function rec(iso: string, patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `r${n++}`,
    ts: Date.parse(iso),
    key: 'windows:s1',
    project: 'acme-web',
    env: 'windows',
    model: 'claude-opus-5-5',
    input: 10,
    output: 100,
    cacheWrite: 0,
    cacheRead: 890,
    ...patch
  }
}

const ctx = (now: string, timeZone = 'UTC') => ({
  timeZone,
  weekStart: 'monday' as const,
  prices: DEFAULT_PRICES,
  now: Date.parse(now)
})

describe('calendar buckets', () => {
  it('assigns days in the local time zone', () => {
    const t = Date.parse('2026-10-25T23:30:00Z')
    expect(dayKey(t, 'UTC')).toBe('2026-10-25')
    expect(dayKey(t, 'America/New_York')).toBe('2026-10-25')
    expect(dayKey(t, 'Europe/Berlin')).toBe('2026-10-26')
    expect(dayKey(t, 'Asia/Tokyo')).toBe('2026-10-26')
  })

  it('starts weeks on Monday (or Sunday) in the local time zone', () => {
    // Sunday 25 Oct 23:30 UTC is already Monday 26 Oct in Berlin.
    const t = Date.parse('2026-10-25T23:30:00Z')
    expect(weekKey(t, 'UTC', 'monday')).toBe('2026-10-19')
    expect(weekKey(t, 'Europe/Berlin', 'monday')).toBe('2026-10-26')
    expect(weekKey(t, 'UTC', 'sunday')).toBe('2026-10-25')
    expect(weekKey(Date.parse('2026-10-19T00:00:00Z'), 'UTC', 'monday')).toBe('2026-10-19')
  })

  it('crosses month and year boundaries by local time', () => {
    const t = Date.parse('2026-10-31T23:30:00Z')
    expect(monthKey(t, 'UTC')).toBe('2026-10')
    expect(monthKey(t, 'Asia/Tokyo')).toBe('2026-11')
    expect(monthKey(Date.parse('2026-12-31T23:00:00Z'), 'Pacific/Auckland')).toBe('2027-01')
    expect(weekKey(Date.parse('2027-01-01T12:00:00Z'), 'UTC', 'monday')).toBe('2026-12-28')
  })

  it('finds local midnight, including on DST change days', () => {
    expect(new Date(startOfDayKey('2026-11-01', 'America/New_York')).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z'
    )
    expect(new Date(startOfDayKey('2026-11-02', 'America/New_York')).toISOString()).toBe(
      '2026-11-02T05:00:00.000Z'
    )
    const r = bucketRange('2026-11-01', 'day', 'America/New_York')
    expect(r.end - r.start).toBe(25 * 3_600_000)
    const m = bucketRange('2026-10', 'month', 'Europe/Berlin')
    expect(new Date(m.start).toISOString()).toBe('2026-09-30T22:00:00.000Z')
    expect(new Date(m.end).toISOString()).toBe('2026-10-31T23:00:00.000Z')
  })

  it('builds bucket keys per period', () => {
    const t = Date.parse('2026-10-22T12:00:00Z')
    expect(bucketKey(t, 'day', 'UTC', 'monday')).toBe('2026-10-22')
    expect(bucketKey(t, 'week', 'UTC', 'monday')).toBe('2026-10-19')
    expect(bucketKey(t, 'month', 'UTC', 'monday')).toBe('2026-10')
  })
})

describe('aggregation', () => {
  const records = [
    rec('2026-10-18T22:00:00Z'), // Sunday
    rec('2026-10-19T08:00:00Z', { model: 'claude-sonnet-5-5' }), // Monday
    rec('2026-10-20T08:00:00Z', { output: 1000 }),
    rec('2026-10-20T09:00:00Z', { key: 'wsl-Ubuntu-beau:s2', env: 'wsl', project: 'orders-api' })
  ]

  it('fills a daily series with empty days and sums every token type', () => {
    const s = timeSeries(
      records,
      {
        period: 'day',
        from: Date.parse('2026-10-18T00:00:00Z'),
        to: Date.parse('2026-10-22T00:00:00Z')
      },
      ctx('2026-10-22T12:00:00Z'),
      new Map()
    )
    expect(s.map((p) => p.bucket)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'])
    expect(s[2]).toMatchObject({
      input: 20,
      output: 1100,
      cacheRead: 1780,
      total: 2900,
      responses: 2
    })
    expect(s[3].total).toBe(0)
    expect(s[1].byModel).toEqual({ 'claude-sonnet-5-5': 1000 })
  })

  it('groups by week starting Monday', () => {
    const s = timeSeries(records, { period: 'week' }, ctx('2026-10-22T12:00:00Z'), new Map())
    expect(s.map((p) => [p.bucket, p.responses])).toEqual([
      ['2026-10-12', 1],
      ['2026-10-19', 3]
    ])
  })

  it('breaks usage down by any dimension with shares', () => {
    const byModel = breakdown(records, 'model', ctx('2026-10-22T12:00:00Z'))
    expect(byModel.map((r) => [r.key, r.label])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-sonnet-5-5', 'Sonnet 5.5']
    ])
    expect(byModel[0].share + byModel[1].share).toBeCloseTo(1)
    expect(breakdown(records, 'env', ctx('2026-10-22T12:00:00Z')).map((r) => r.label)).toEqual([
      'Windows',
      'WSL'
    ])
    expect(breakdown(records, 'project', ctx('2026-10-22T12:00:00Z'))[0].key).toBe('acme-web')
  })

  it('compares each period card with the same elapsed part of the previous period', () => {
    const recs = [
      rec('2026-10-21T09:00:00Z', { output: 200 }), // yesterday, before "now" time of day
      rec('2026-10-21T20:00:00Z', { output: 5000 }), // yesterday, after it: not compared
      rec('2026-10-22T09:00:00Z', { output: 300 })
    ]
    const costs = new Map()
    const cards = periodCards(recs, ctx('2026-10-22T12:00:00Z'), costs)
    const today = cards.find((c) => c.id === 'today')!
    expect(today.total).toBe(1200)
    expect(today.prevTotal).toBe(1100)
    expect(today.deltaPct).toBeCloseTo((100 / 1100) * 100)
    expect(cards.find((c) => c.id === 'all')!.total).toBe(1100 + 5900 + 1200)
    expect(cards.find((c) => c.id === 'week')!.spark).toHaveLength(7)
  })

  it('builds a full report with the model filter applied', () => {
    const r = buildReport(
      records,
      { period: 'day', models: ['claude-sonnet-5-5'] },
      ctx('2026-10-22T12:00:00Z')
    )
    expect(r.totals.responses).toBe(1)
    expect(r.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(r.byModel).toHaveLength(1)
    expect(r.totals.cost).toBeGreaterThan(0)
  })

  it('exports CSV per day and model', () => {
    const csv = toCsv(records, { timeZone: 'UTC', prices: DEFAULT_PRICES })
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe(
      'date,model,responses,input,output,cache_write,cache_read,total,est_cost_usd'
    )
    expect(lines).toContain('2026-10-20,claude-opus-5-5,2,20,1100,0,1780,2900,0.0224')
    expect(
      toCsv(records, { timeZone: 'UTC', prices: DEFAULT_PRICES }, true).split('\r\n')[1]
    ).toMatch(/^2026-10-18T22:00:00.000Z,windows:s1,acme-web,windows,claude-opus-5-5/)
  })
})

describe('5-hour blocks', () => {
  it('starts a block at the hour of its first message and lasts 5 hours', () => {
    const recs = [
      rec('2026-10-22T10:15:00Z'),
      rec('2026-10-22T12:00:00Z'),
      rec('2026-10-22T14:59:00Z'),
      rec('2026-10-22T15:10:00Z'), // after 15:00 → new block starting 15:00
      rec('2026-10-23T03:00:00Z') // after a long gap
    ]
    const blocks = fiveHourBlocks(recs, Date.parse('2026-10-23T04:00:00Z'), DEFAULT_PRICES)
    expect(blocks.map((b) => [new Date(b.start).toISOString(), b.responses, b.active])).toEqual([
      ['2026-10-22T10:00:00.000Z', 3, false],
      ['2026-10-22T15:00:00.000Z', 1, false],
      ['2026-10-23T03:00:00.000Z', 1, true]
    ])
    expect(blocks[0].end - blocks[0].start).toBe(5 * 3_600_000)
    expect(blocks[0].total).toBe(3000)
    expect(blocks[0].cost).toBeGreaterThan(0)
  })

  it('handles unsorted input and an empty list', () => {
    expect(fiveHourBlocks([], Date.now(), DEFAULT_PRICES)).toEqual([])
    const b = fiveHourBlocks(
      [rec('2026-10-22T12:00:00Z'), rec('2026-10-22T10:30:00Z')],
      Date.parse('2026-10-22T12:30:00Z'),
      DEFAULT_PRICES
    )
    expect(b).toHaveLength(1)
    expect(new Date(b[0].start).toISOString()).toBe('2026-10-22T10:00:00.000Z')
  })
})
