// Our token totals must match ccusage's logic on the same files. The
// reference model of ccusage's loader is in ccusage-reference.ts; the app's
// pipeline is analyzeUsage per file plus one UsageDeduper across files, the
// same as UsageService.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseJsonl } from '@shared/jsonl'
import { analyzeUsage } from '@shared/usage/parse'
import { UsageDeduper } from '@shared/usage/dedupe'
import { fiveHourBlocks } from '@shared/usage/aggregate'
import { DEFAULT_PRICES, estimateCost, recordCost } from '@shared/usage/pricing'
import type { UsageRecord } from '@shared/usage/types'
import {
  dailyTotals,
  dedupe,
  fileSessionId,
  readUsageFile,
  type DayTotals
} from './ccusage-reference'
import { FIXTURES } from './helpers'

const EDGE = join(FIXTURES, 'ccusage-parity', '.claude', 'projects', '-home-beau-projects-edge')
const A = 'a7c1e0d2-5b3f-4c11-9e2a-000000000001'
const B = 'a7c1e0d2-5b3f-4c11-9e2a-000000000002'

function jsonlFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...jsonlFiles(p))
    else if (name.endsWith('.jsonl')) out.push(p)
  }
  return out.sort()
}

/** The app's pipeline over a set of files. */
function ours(files: string[]): UsageRecord[] {
  const all = new UsageDeduper()
  for (const f of files) {
    const sessionId = fileSessionId(f)
    const { events } = parseJsonl(readFileSync(f, 'utf8'))
    const a = analyzeUsage(events, {
      key: `src:${sessionId}`,
      project: 'p',
      env: 'windows',
      sessionId,
      file: basename(f)
    })
    for (const r of a.records) all.add(r)
  }
  return [...all.values()]
}

function reference(files: string[]) {
  return dedupe(files.flatMap((f) => readUsageFile(f, readFileSync(f, 'utf8'))))
}

function ourDaily(records: UsageRecord[]): Record<string, DayTotals> {
  const out: Record<string, DayTotals> = {}
  for (const r of records) {
    const day = new Date(r.ts).toISOString().slice(0, 10)
    const t = (out[day] ??= { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    t.input += r.input
    t.output += r.output
    t.cacheCreate += r.cacheWrite
    t.cacheRead += r.cacheRead
  }
  return out
}

// ccusage also lists synthetic messages (always 0 tokens, no model); we skip them.
interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
  cacheCreate?: number
}
const tokens = (r: Tokens): number =>
  r.input + r.output + r.cacheRead + (r.cacheWrite ?? r.cacheCreate ?? 0)
const counted = <T extends Tokens>(rows: T[]): T[] => rows.filter((r) => tokens(r) > 0)

function byModel(rows: { model?: string; output: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.model ?? '(none)'] = (out[r.model ?? '(none)'] ?? 0) + r.output
  return out
}

describe('totals match ccusage', () => {
  it('on every fixture session file', () => {
    const files = jsonlFiles(FIXTURES)
    expect(files.length).toBeGreaterThan(100)
    const mine = ours(files)
    const ref = reference(files)
    expect(counted(mine).length).toBe(counted(ref).length)
    expect(ourDaily(mine)).toEqual(dailyTotals(ref))
    expect(byModel(mine)).toEqual(byModel(counted(ref)))
  })

  it('on the edge cases ccusage handles specially', () => {
    const files = jsonlFiles(EDGE)
    expect(files.map((f) => relative(EDGE, f))).toHaveLength(3)
    const mine = ours(files)
    const ref = reference(files)
    expect(ourDaily(mine)).toEqual(dailyTotals(ref))
    expect(byModel(mine)).toEqual(byModel(counted(ref)))
    expect(counted(mine)).toHaveLength(counted(ref).length)
  })
})

describe('fixes from comparing with ccusage', () => {
  const recs = ours(jsonlFiles(EDGE))
  const find = (mid: string) => recs.filter((r) => r.mid === mid)

  it('keeps the copy with more tokens instead of a field-wise maximum', () => {
    // Lines: {in 10, out 300} and {in 500, out 10}. Before: 500 in + 300 out.
    expect(find('msg_01Edge2')).toEqual([expect.objectContaining({ input: 500, output: 10 })])
  })

  it('does not merge different responses that share a gateway placeholder id', () => {
    // Before: both lines collapsed into one record under "gw-response".
    expect(find('gw-response').map((r) => r.output)).toEqual([80, 90])
  })

  it('scopes requestless ids to the session', () => {
    // One response in session A (two lines), copied into session B: ccusage counts it per session.
    expect(find('msg_01Edge4').map((r) => r.sid)).toEqual([A, B])
  })

  it('counts a /btw sidechain replay with a new request id once, keeping the main copy', () => {
    // Before: the replay (req_btw_replay) was a second response.
    const r = find('msg_01Edge1')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ rid: 'req_01Edge1', output: 240 })
    expect(r[0].sc).toBeUndefined()
  })

  it('takes cache writes from the 5m/1h split when it is reported', () => {
    // Flat total 9000, split 1000 + 2000. Before: 9000.
    expect(find('msg_01Edge6')[0]).toMatchObject({ cacheWrite: 3000, cw1h: 2000 })
  })

  it('skips lines ccusage rejects', () => {
    // Non-semver version, empty request id, missing input_tokens, empty model.
    for (const id of ['msg_01Edge7a', 'msg_01Edge7b', 'msg_01Edge7c', 'msg_01Edge7d'])
      expect(find(id)).toEqual([])
  })

  it('counts advisor sub-calls under their own model', () => {
    expect(find('msg_01Edge8:advisor:0')).toEqual([
      expect.objectContaining({ model: 'claude-fable-5-1', input: 1200, output: 300 })
    ])
    expect(find('msg_01Edge8')[0]).toMatchObject({ model: 'claude-opus-5-5', output: 120 })
  })

  it('marks fast mode and prices it with the fast multiplier', () => {
    const r = find('msg_01Edge9')[0]
    expect(r.model).toBe('claude-opus-5-5-fast')
    const normal = estimateCost({ ...r, model: 'claude-opus-5-5' }, DEFAULT_PRICES)
    expect(estimateCost(r, DEFAULT_PRICES)).toBeCloseTo(normal * 2, 10)
  })

  it('uses the cost old Claude Code versions logged', () => {
    const r = find('msg_01Edge10')[0]
    expect(r.loggedCost).toBe(0.0033)
    expect(recordCost(r, DEFAULT_PRICES)).toBe(0.0033)
  })

  it('never dedupes lines without a message id', () => {
    expect(recs.filter((r) => !r.mid && r.output === 7)).toHaveLength(2)
  })

  it('counts subagent transcripts', () => {
    expect(find('msg_01EdgeS1')).toEqual([
      expect.objectContaining({ model: 'claude-haiku-5-5', output: 800, sc: true })
    ])
  })
})

describe('5-hour blocks match ccusage', () => {
  const rec = (iso: string): UsageRecord => ({
    id: iso,
    ts: Date.parse(iso),
    key: 'k',
    project: 'p',
    env: 'windows',
    model: 'claude-opus-5-5',
    input: 1,
    output: 1,
    cacheWrite: 0,
    cacheRead: 0
  })

  it('keeps a response exactly 5 hours after the block start in that block', () => {
    // Block starts 10:00 (floored to the hour). Before: 15:00 opened a new block.
    const blocks = fiveHourBlocks(
      [rec('2026-10-22T10:20:00Z'), rec('2026-10-22T15:00:00Z'), rec('2026-10-22T15:00:01Z')],
      Date.parse('2026-10-23T00:00:00Z'),
      DEFAULT_PRICES
    )
    expect(blocks.map((b) => [new Date(b.start).toISOString(), b.input])).toEqual([
      ['2026-10-22T10:00:00.000Z', 2],
      ['2026-10-22T15:00:00.000Z', 1]
    ])
  })
})
