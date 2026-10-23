import { describe, expect, it } from 'vitest'
import {
  buildTrends,
  compareTrends,
  compareVersions,
  emptyAcc,
  addTurnToAcc,
  metricValue
} from '@shared/usage/trends'
import type { TurnSample, UsageRecord } from '@shared/usage/types'
import type { CapacityPoint } from '@shared/usage/limits'

let n = 0
const rec = (
  iso: string,
  model: string,
  version: string,
  output = 100,
  cacheRead = 900
): UsageRecord => ({
  id: `r${n++}`,
  ts: Date.parse(iso),
  key: 'k',
  project: 'p',
  env: 'windows',
  model,
  version,
  input: 0,
  output,
  cacheWrite: 100,
  cacheRead
})
const turn = (
  iso: string,
  model: string,
  version: string,
  patch: Partial<TurnSample> = {}
): TurnSample => ({
  id: `t${n++}`,
  ts: Date.parse(iso),
  key: 'k',
  model,
  version,
  latencyMs: 4000,
  responses: 3,
  outputTokens: 300,
  inputTokens: 0,
  cacheReadTokens: 2700,
  toolCalls: 2,
  toolResults: 2,
  toolErrors: 0,
  apiErrors: 0,
  thinkingBlocks: 1,
  thinkingChars: 200,
  interrupted: false,
  correction: false,
  ...patch
})

describe('trend metrics', () => {
  it('computes each metric from turns', () => {
    const a = emptyAcc()
    addTurnToAcc(
      a,
      turn('2026-10-01T10:00:00Z', 'm', '1', { latencyMs: 2000, toolErrors: 1, apiErrors: 1 })
    )
    addTurnToAcc(a, turn('2026-10-01T11:00:00Z', 'm', '1', { latencyMs: 6000, correction: true }))
    addTurnToAcc(a, turn('2026-10-01T12:00:00Z', 'm', '1', { latencyMs: 3_600_000 })) // idle gap, ignored
    expect(metricValue(a, 'latency')).toBe(4)
    expect(metricValue(a, 'toolErrorRate')).toBeCloseTo((1 / 6) * 100)
    expect(metricValue(a, 'apiErrorShare')).toBeCloseTo(100 / 3)
    expect(metricValue(a, 'correctionRate')).toBeCloseTo(100 / 3)
    expect(metricValue(a, 'responsesPerTurn')).toBe(3)
    expect(metricValue(a, 'thinkingPerResponse')).toBeCloseTo(1 / 3)
    expect(metricValue(a, 'thinkingLength')).toBe(200)
    expect(metricValue(emptyAcc(), 'latency')).toBeUndefined()
  })

  it('builds weekly series per model with markers for new models and capacity changes', () => {
    const records = [
      ...[0, 1, 2, 3].map((i) => rec(`2026-09-2${i}T10:00:00Z`, 'claude-opus-5', '2.1.250', 200)),
      ...[0, 1, 2, 3].map((i) =>
        rec(`2026-10-0${i + 5}T10:00:00Z`, 'claude-opus-5-5', '2.1.290', 100)
      )
    ]
    const turns = [
      turn('2026-09-21T10:00:00Z', 'claude-opus-5', '2.1.250'),
      turn('2026-09-22T10:00:00Z', 'claude-opus-5', '2.1.250')
    ]
    const capacity: CapacityPoint[] = [
      {
        ts: Date.parse('2026-09-22T10:00:00Z'),
        kind: 'five_hour',
        pct: 50,
        weighted: 1,
        capacity: 1000,
        mix: 'opus'
      },
      {
        ts: Date.parse('2026-10-06T10:00:00Z'),
        kind: 'five_hour',
        pct: 50,
        weighted: 1,
        capacity: 700,
        mix: 'opus'
      }
    ]
    const r = buildTrends({
      records,
      turns,
      readings: [
        {
          ts: Date.parse('2026-10-06T12:00:00Z'),
          source: 'w',
          sessionId: 's',
          contextPct: 40,
          model: 'claude-opus-5-5',
          version: '2.1.290'
        },
        {
          ts: Date.parse('2026-10-06T13:00:00Z'),
          source: 'w',
          sessionId: 's',
          contextPct: 60,
          model: 'claude-opus-5-5',
          version: '2.1.290'
        }
      ],
      capacity,
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'model'
    })
    expect(r.weeks.map((w) => w.week)).toEqual(['2026-09-14', '2026-09-21', '2026-10-05'])
    const out = (g: string) =>
      r.series.find((s) => s.metric === 'outputPerResponse' && s.group === g)!.points
    expect(out('claude-opus-5').map((p) => p.value)).toEqual([undefined, 200, undefined])
    expect(out('claude-opus-5-5')[2].value).toBe(100)
    const ctx = r.series.find((s) => s.metric === 'contextUsage' && s.group === 'claude-opus-5-5')!
      .points[2]
    expect(ctx.value).toBe(60) // the session's last reading that week
    expect(r.markers.map((m) => [m.kind, m.week, m.label])).toEqual([
      ['model', '2026-10-05', 'Opus 5.5'],
      ['version', '2026-10-05', 'v2.1.290'],
      ['capacity', '2026-10-05', '$/1% −30%']
    ])
    expect(r.groups.map((g) => g.label)).toEqual(['Opus 5', 'Opus 5.5'])
  })

  it('groups by Claude Code version', () => {
    const r = buildTrends({
      records: [
        rec('2026-10-01T10:00:00Z', 'm', '2.1.9'),
        rec('2026-10-01T10:00:00Z', 'm', '2.1.10'),
        rec('2026-10-02T10:00:00Z', 'm', '2.1.10')
      ],
      turns: [],
      readings: [],
      timeZone: 'UTC',
      weekStart: 'monday',
      groupBy: 'version'
    })
    expect(r.groups.map((g) => g.key)).toEqual(['2.1.10', '2.1.9'])
    expect(r.versions).toEqual(['2.1.9', '2.1.10'])
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0)
  })

  it('compares two date ranges or two versions with % change', () => {
    const records = [
      ...[1, 2, 3].map((d) => rec(`2026-09-0${d}T10:00:00Z`, 'm', '2.1.200', 200)),
      ...[1, 2, 3].map((d) => rec(`2026-10-0${d}T10:00:00Z`, 'm', '2.1.300', 150))
    ]
    const turns = [
      turn('2026-09-01T10:00:00Z', 'm', '2.1.200', { latencyMs: 4000 }),
      turn('2026-09-02T10:00:00Z', 'm', '2.1.200', { latencyMs: 4000 }),
      turn('2026-10-01T10:00:00Z', 'm', '2.1.300', { latencyMs: 6000 }),
      turn('2026-10-02T10:00:00Z', 'm', '2.1.300', { latencyMs: 6000 })
    ]
    const byDate = compareTrends(
      { records, turns, readings: [] },
      { from: Date.parse('2026-09-01'), to: Date.parse('2026-09-10') },
      { from: Date.parse('2026-10-01'), to: Date.parse('2026-10-10') }
    )
    const row = (id: string) => byDate.rows.find((r) => r.metric === id)!
    expect(row('outputPerResponse')).toMatchObject({ a: 200, b: 150, changePct: -25 })
    expect(row('latency')).toMatchObject({ a: 4, b: 6, changePct: 50 })
    expect(byDate.samples).toEqual({
      a: { responses: 3, requests: 2 },
      b: { responses: 3, requests: 2 }
    })
    const byVersion = compareTrends(
      { records, turns, readings: [] },
      { version: '2.1.200' },
      { version: '2.1.300' }
    )
    expect(byVersion.rows.find((r) => r.metric === 'outputPerResponse')?.changePct).toBe(-25)
  })
})
