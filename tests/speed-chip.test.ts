// The session strip's speed chip: normal mode first, and a session that only
// ran in fast mode still shows its speed and time to first token.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { speedStats } from '@shared/usage/speed'
import type { SessionUsage, UsageRecord } from '@shared/usage/types'
import { SpeedChip } from '@/components/viewer/SessionUsage'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.hoisted(() => {
  const g = globalThis as { window?: unknown }
  g.window ??= {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  }
})

const T0 = Date.parse('2026-10-22T10:00:00Z')
function recs(n: number, over: Partial<UsageRecord>): UsageRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${over.model}${i}`,
    ts: T0 + i,
    key: 'windows:s1',
    project: 'p',
    env: 'windows' as const,
    model: 'claude-opus-5-5',
    input: 10,
    output: 500,
    cacheWrite: 0,
    cacheRead: 0,
    genMs: 5000,
    ...over
  }))
}
const usage = (records: UsageRecord[]): SessionUsage => ({
  key: 'windows:s1',
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  total: 0,
  cost: 0,
  responses: records.length,
  byModel: [],
  speed: speedStats(records)
})
const chip = (records: UsageRecord[]): string =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(SpeedChip, { u: usage(records) }))
  )

describe('session speed chip', () => {
  it('shows the normal-mode speed and estimated time to first token', () => {
    const html = chip(recs(6, { ttftMs: 1500 }))
    expect(html).toContain('100 tok/s')
    expect(html).toContain('TTFT 1.5s est.')
    expect(html).not.toContain('Fast')
  })

  it('a fast-only session shows its fast speed and time to first token, marked Fast', () => {
    const records = recs(6, { model: 'claude-opus-5-5-fast', genMs: 2000, ttftMs: 700 })
    const s = speedStats(records)
    expect(s).toMatchObject({ samples: 0, fast: true, fastTps: 250, fastTtftMs: 700 })
    expect(s.tps).toBeUndefined()
    const html = chip(records)
    expect(html).toContain('250 tok/s')
    expect(html).toContain('TTFT 700 ms est.')
    expect(html).toContain('Fast only')
  })

  it('shows the time to first token even without enough responses for a speed', () => {
    const html = chip(recs(5, { output: 20, ttftMs: 1200 }))
    expect(html).not.toContain('tok/s')
    expect(html).toContain('TTFT 1.2s est.')
  })

  it('a mixed session with too few normal responses shows its fast speed, not "Fast only"', () => {
    const html = chip([...recs(2, {}), ...recs(6, { model: 'claude-opus-5-5-fast', genMs: 2000 })])
    expect(html).toContain('250 tok/s (fast)')
    expect(html).not.toContain('Fast only')
    expect(html).toContain('Fast')
  })

  it('shows a fast speed next to the normal time to first token', () => {
    const html = chip([
      // Normal mode: too short for a speed, but each has a time to first token.
      ...recs(5, { output: 20, ttftMs: 1200 }),
      ...recs(6, { model: 'claude-opus-5-5-fast', genMs: 2000 })
    ])
    expect(html).toContain('250 tok/s (fast)')
    expect(html).toContain('TTFT 1.2s est.')
    expect(html).not.toContain('TTFT 1.2s est. (fast)')
  })

  it('shows nothing without any timing', () => {
    expect(chip(recs(3, { genMs: undefined }))).toBe('')
  })
})
