// Codex usage and limits (Phase C): token_count deltas, counting each
// response once across forks / resumes / subagents, .zst rollouts,
// rate_limits parsing (both windows, missing fields, stale), plan detection,
// limit health per provider, the provider views, the CSV provider column and
// resume estimates. The sample homes are in fixtures/codex (see
// scripts/make-codex-fixtures.mjs).

import { EventEmitter } from 'node:events'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXTURES_NOW } from '@shared/clock'
import {
  asBridgeReadings,
  codeLabel,
  codexPlanSpans,
  detectPlanChanges,
  planOfCode,
  windowKindOf,
  windowLabel,
  type CodexLimitReading
} from '@shared/usage/codex'
import { codexUsageSettings, withSnapshotModels } from '@shared/usage/codex-settings'
import { DEFAULT_HEALTH } from '@shared/usage/health'
import { DEFAULT_PACE } from '@shared/usage/pace'
import { DEFAULT_WEIGHTS } from '@shared/usage/limits'
import {
  DEFAULT_CODEX_PRICES,
  DEFAULT_PRICES,
  findPrice,
  modelLabel,
  unpricedModels
} from '@shared/usage/pricing'
import { toCsv } from '@shared/usage/aggregate'
import type { UsageRecord } from '@shared/usage/types'
import { createFixturesPlatform } from '../src/main/platform'
import { fixturesLayout, prepareFixtures, seedFixtureData } from '../src/main/fixtures'
import { appPaths, createMetadataStore, createSettingsStore } from '../src/main/services/store'
import { SessionService } from '../src/main/services/sessions'
import { ProviderRegistry } from '../src/main/providers/registry'
import { claudeProvider } from '../src/main/providers/claude'
import { createCodexProvider } from '../src/main/providers/codex'
import { analyzeCodexUsage, parseRateLimits } from '../src/main/providers/codex/usage'
import { readCodexUsageText } from '../src/main/providers/codex/read'
import { analyzeCodex } from '../src/main/providers/codex/parse'
import { UsageService, usagePaths } from '../src/main/services/usage'
import { CodexUsageStore, lineageRoots } from '../src/main/services/codex-usage'
import { CodexLimitsService, type CodexLimitsSettings } from '../src/main/services/codex-limits'
import { ContextCost, CODEX_CACHE_NOTE } from '../src/main/services/context-cost'
import { cleanQuery } from '../src/main/ipc-usage'

const FIXTURES = join(__dirname, '..', 'fixtures')
const ID = {
  cli: '019a1111-0000-7000-8000-000000000001',
  desktop: '019a2222-0000-7000-8000-000000000002',
  sub: '019a3333-0000-7000-8000-000000000003',
  fork: '019a4444-0000-7000-8000-000000000004',
  old: '019a5555-0000-7000-8000-000000000005',
  gap: '019a6666-0000-7000-8000-000000000006',
  wsl: '019a7777-0000-7000-8000-000000000007',
  now: '019a8888-0000-7000-8000-000000000008'
}
const CODEX = join(FIXTURES, 'codex', 'windows', 'Users', 'beau', '.codex')
const DESKTOP_FILE = join(
  CODEX,
  'sessions',
  '2026',
  '10',
  '18',
  `rollout-2026-10-18T14-02-11-${ID.desktop}.jsonl.zst`
)
const OLD_FILE = join(
  CODEX,
  'archived_sessions',
  `rollout-2026-09-30T10-00-00-${ID.old}.jsonl.zst`
)

// ------------------------------------------------------------- helpers

const ctx = { key: 'codex-windows:s1', project: 'p', env: 'windows' as const, sessionId: 's1' }

function counts(input: number, cached: number, output: number, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output
  }
}

function tc(ts: string, info: unknown, rateLimits: unknown = null): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info, rate_limits: rateLimits }
  })
}

const turn = (model: string) =>
  JSON.stringify({ timestamp: '2026-10-20T10:00:00Z', type: 'turn_context', payload: { model } })

const sec = (iso: string) => Math.round(Date.parse(iso) / 1000)

// ---------------------------------------------------- token_count math

describe('Codex token counts', () => {
  it('counts each response by its last usage; input includes cached, output includes reasoning', () => {
    const t1 = counts(1000, 400, 50, 20)
    const t2 = counts(2500, 1400, 90, 40)
    const text = [
      turn('gpt-5.5-codex'),
      tc('2026-10-20T10:00:01Z', { total_token_usage: t1, last_token_usage: t1 }),
      tc('2026-10-20T10:00:02Z', {
        total_token_usage: counts(3500, 1800, 140, 60),
        last_token_usage: t2
      })
    ].join('\n')
    const { records } = analyzeCodexUsage(text, ctx)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5-codex',
      input: 600,
      cacheRead: 400,
      cacheWrite: 0,
      output: 50,
      reasoning: 20
    })
    expect(records[1]).toMatchObject({ input: 1100, cacheRead: 1400, output: 90, reasoning: 40 })
    // The total is Codex's own total_tokens (input + output; reasoning is part of output).
    const sum = records.reduce((a, r) => a + r.input + r.cacheRead + r.cacheWrite + r.output, 0)
    expect(sum).toBe(3500 + 140)
  })

  it('without last usage (older Codex), counts the change in the running total', () => {
    const text = [
      tc('2026-09-30T15:00:01Z', { total_token_usage: counts(5000, 1000, 300) }),
      tc('2026-09-30T15:00:02Z', { total_token_usage: counts(12000, 3000, 700) })
    ].join('\n')
    const { records } = analyzeCodexUsage(text, ctx)
    expect(records.map((r) => [r.input, r.cacheRead, r.output])).toEqual([
      [4000, 1000, 300],
      [5000, 2000, 400]
    ])
  })

  it('skips re-sent events with an unchanged total, and survives a total that went down', () => {
    const a = counts(1000, 0, 10)
    const text = [
      tc('2026-10-20T10:00:01Z', { total_token_usage: a, last_token_usage: a }),
      // Re-sent (only the limits moved): no new usage.
      tc('2026-10-20T10:00:02Z', { total_token_usage: a, last_token_usage: a }),
      // A reset (resume): the total starts again; the event's own usage counts.
      tc('2026-10-20T11:00:00Z', { total_token_usage: counts(300, 0, 5) }),
      tc('2026-10-20T11:00:05Z', { total_token_usage: counts(900, 0, 15) })
    ].join('\n')
    const { records } = analyzeCodexUsage(text, ctx)
    expect(records.map((r) => r.input + r.output)).toEqual([1010, 305, 610])
  })

  it('takes the model from the turn before each event (the first turn for earlier ones)', () => {
    const a = counts(10, 0, 1)
    const b = counts(30, 0, 3)
    const text = [
      tc('2026-10-20T10:00:01Z', { total_token_usage: a, last_token_usage: a }),
      turn('gpt-5.4'),
      turn('gpt-6.1-sol'),
      tc('2026-10-20T10:00:03Z', { total_token_usage: b, last_token_usage: counts(20, 0, 2) })
    ].join('\n')
    expect(analyzeCodexUsage(text, ctx).records.map((r) => r.model)).toEqual([
      'gpt-5.4',
      'gpt-6.1-sol'
    ])
  })

  it('reads compressed rollouts in full, keeping only the lines usage needs', async () => {
    const text = await readCodexUsageText(DESKTOP_FILE)
    const types = text.split('\n').map((l) => JSON.parse(l).type)
    expect(new Set(types)).toEqual(new Set(['session_meta', 'turn_context', 'event_msg']))
    // The instructions Codex was started with are never kept.
    expect(text).not.toContain('base_instructions')
    const { records, codexLimits } = analyzeCodexUsage(text, { ...ctx, sessionId: ID.desktop })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ model: 'gpt-5.5', input: 8000, cacheRead: 6000, output: 700 })
    expect(codexLimits?.[0]).toMatchObject({ planType: 'plus', limitId: 'codex' })
  })

  it('reads the older format (archived, compressed) through its totals', async () => {
    const { records } = analyzeCodexUsage(await readCodexUsageText(OLD_FILE), {
      ...ctx,
      sessionId: ID.old
    })
    expect(records.map((r) => r.input + r.cacheRead + r.output)).toEqual([5300, 7400])
    expect(records[0].model).toBe('gpt-5-codex')
  })
})

// ------------------------------------------------------ fork / resume dedupe

describe('counting each response once across forks', () => {
  const t1 = counts(1000, 200, 40)
  const t2 = counts(1800, 900, 70)
  const parent = [
    turn('gpt-5.5-codex'),
    tc('2026-10-20T10:00:01Z', { total_token_usage: t1, last_token_usage: t1 }),
    tc('2026-10-20T10:05:00Z', {
      total_token_usage: counts(2800, 1100, 110),
      last_token_usage: t2
    })
  ].join('\n')
  // A fork copies the parent's events with new timestamps, then adds its own.
  const fork = [
    turn('gpt-5.5-codex'),
    tc('2026-10-21T09:00:00Z', { total_token_usage: t1, last_token_usage: t1 }),
    tc('2026-10-21T09:00:00Z', {
      total_token_usage: counts(2800, 1100, 110),
      last_token_usage: t2
    }),
    tc('2026-10-21T09:10:00Z', {
      total_token_usage: counts(3300, 1100, 130),
      last_token_usage: counts(500, 0, 20)
    })
  ].join('\n')

  const analyzed = (text: string, key: string, sid: string, root: string) =>
    analyzeCodexUsage(text, { ...ctx, key, sessionId: sid, lineageRoot: root })

  it('gives a copied event the same identity as the original (lineage + exact counts)', () => {
    const p = analyzed(parent, 'w:p', 'p', 'p')
    const f = analyzed(fork, 'w:f', 'f', 'p')
    expect(f.records.slice(0, 2).map((r) => r.id)).toEqual(p.records.map((r) => r.id))
    expect(f.records[2].id).not.toBe(p.records[1].id)
  })

  it('keeps the earliest copy (the parent, at its real time), in any reading order', () => {
    const p = analyzed(parent, 'w:p', 'p', 'p')
    const f = analyzed(fork, 'w:f', 'f', 'p')
    for (const order of [
      [p, f],
      [f, p]
    ]) {
      const store = new CodexUsageStore()
      for (const a of order) store.set(a === p ? 'w:p' : 'w:f', a.records, a.codexLimits ?? [])
      const recs = store.records()
      expect(recs).toHaveLength(3)
      expect(recs.filter((r) => r.key === 'w:p').map((r) => r.ts)).toEqual([
        Date.parse('2026-10-20T10:00:01Z'),
        Date.parse('2026-10-20T10:05:00Z')
      ])
      expect(recs.filter((r) => r.key === 'w:f')).toHaveLength(1)
    }
  })

  it('never merges unrelated sessions with the same counts', () => {
    const p = analyzed(parent, 'w:p', 'p', 'p')
    const q = analyzed(parent, 'w:q', 'q', 'q')
    const store = new CodexUsageStore()
    store.set('w:p', p.records, [])
    store.set('w:q', q.records, [])
    expect(store.records()).toHaveLength(4)
  })

  it("finds a fork chain's first thread; a missing parent is the root itself", () => {
    const roots = lineageRoots([
      { sessionId: 'a' },
      { sessionId: 'b', forkedFromId: 'a' },
      { sessionId: 'c', forkedFromId: 'b' },
      { sessionId: 'd', forkedFromId: 'gone' },
      { sessionId: 'e', forkedFromId: 'gone' },
      { sessionId: 'x', forkedFromId: 'y' },
      { sessionId: 'y', forkedFromId: 'x' }
    ])
    expect([roots.get('b'), roots.get('c')]).toEqual(['a', 'a'])
    expect([roots.get('d'), roots.get('e')]).toEqual(['gone', 'gone'])
    // A loop never hangs.
    expect(roots.get('x')).toBeDefined()
  })

  it("a session parsed again (or gone) keeps another session's copy of a shared response", () => {
    const p = analyzed(parent, 'w:p', 'p', 'p')
    const f = analyzed(fork, 'w:f', 'f', 'p')
    const store = new CodexUsageStore()
    store.set('w:p', p.records, [])
    store.set('w:f', f.records, [])
    store.set('w:p', [], [])
    // The fork's copies now stand for those responses.
    expect(store.records()).toHaveLength(3)
  })
})

// ------------------------------------------------------------ rate_limits

describe('Codex rate_limits', () => {
  const meta = { id: 'e1', key: 'w:s', source: 'codex-windows', sessionId: 's' }
  const ts = Date.parse('2026-10-20T10:00:00Z')

  it('reads both windows, and tells them apart by window_minutes, not by slot', () => {
    const r = parseRateLimits(
      {
        limit_id: 'codex',
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: sec('2026-10-20T13:00:00Z') },
        secondary: {
          used_percent: 40,
          window_minutes: 10080,
          resets_at: sec('2026-10-25T08:00:00Z')
        },
        plan_type: 'plus',
        credits: { has_credits: false, unlimited: false, balance: null }
      },
      ts,
      meta
    )!
    expect(r.windows).toEqual([
      { pct: 12.5, minutes: 300, resetsAt: Date.parse('2026-10-20T13:00:00Z') },
      { pct: 40, minutes: 10080, resetsAt: Date.parse('2026-10-25T08:00:00Z') }
    ])
    expect(r).toMatchObject({ limitId: 'codex', planType: 'plus', credits: { hasCredits: false } })
    // Newer Codex: the weekly window as primary, no 5-hour window.
    const weekly = parseRateLimits(
      {
        primary: { used_percent: 7, window_minutes: 10080, resets_at: sec('2026-10-25T08:00:00Z') },
        secondary: null,
        plan_type: 'prolite'
      },
      ts,
      meta
    )!
    const b = asBridgeReadings([weekly])[0]
    expect(b.fiveHour).toBeUndefined()
    expect(b.sevenDay).toEqual({ pct: 7, resetsAt: Date.parse('2026-10-25T08:00:00Z') })
    expect(weekly.limitId).toBe('codex')
    expect([windowKindOf(300), windowKindOf(10080), windowKindOf(120)]).toEqual([
      'five_hour',
      'seven_day',
      undefined
    ])
    expect([windowLabel(300), windowLabel(10080), windowLabel(120), windowLabel(43200)]).toEqual([
      '5-hour window',
      'Weekly',
      '2-hour window',
      '30-day window'
    ])
  })

  it('skips missing fields and windows that had already reset when read', () => {
    expect(parseRateLimits(null, ts, meta)).toBeUndefined()
    expect(parseRateLimits({ primary: { used_percent: 5 } }, ts, meta)).toBeUndefined()
    expect(
      parseRateLimits(
        { primary: { used_percent: 5, window_minutes: 300, resets_at: sec('2026-10-20T08:00:00Z') } },
        ts,
        meta
      )
    ).toBeUndefined()
    // Older Codex: seconds until the reset.
    const old = parseRateLimits(
      { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 } },
      ts,
      meta
    )!
    expect(old.windows[0].resetsAt).toBe(ts + 3_600_000)
    // Another limit: its id and name.
    const spark = parseRateLimits(
      {
        limit_id: 'codex_bengalfox',
        limit_name: 'GPT-5.3-Codex-Spark',
        primary: { used_percent: 3, window_minutes: 10080, resets_at: sec('2026-10-27T00:00:00Z') }
      },
      ts,
      meta
    )!
    expect(spark).toMatchObject({ limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' })
  })

  it('keeps changed readings, one every 10 minutes and the last one, not every repeat', () => {
    const rl = (pct: number) => ({
      primary: { used_percent: pct, window_minutes: 10080, resets_at: sec('2026-10-25T08:00:00Z') }
    })
    const lines: string[] = []
    let total = 0
    for (let i = 0; i < 30; i++) {
      total += 10
      const t = new Date(Date.parse('2026-10-20T10:00:00Z') + i * 60_000).toISOString()
      lines.push(tc(t, { total_token_usage: counts(total, 0, 0), last_token_usage: counts(10, 0, 0) }, rl(i < 20 ? 5 : 6)))
    }
    const { codexLimits } = analyzeCodexUsage(lines.join('\n'), ctx)
    const at = codexLimits!.map((r) => (r.ts - Date.parse('2026-10-20T10:00:00Z')) / 60_000)
    // First, after 10 and 20 minutes (one of them a change), and the last.
    expect(at).toEqual([0, 10, 20, 29])
  })
})

// ------------------------------------------------------------------ plans

describe('Codex plans', () => {
  it('maps plan_type codes, showing the raw code next to the label', () => {
    expect(planOfCode('prolite')).toBe('pro100')
    expect(planOfCode('plus')).toBe('plus')
    expect(planOfCode('team')).toBe('business')
    expect(planOfCode('mystery')).toBeUndefined()
    expect(codeLabel('prolite')).toBe('Pro $100 (prolite)')
    expect(codeLabel('mystery')).toBe('Unknown plan (mystery)')
  })

  it('detects plan changes from the logs and builds the plans over time', () => {
    const r = (ts: string, planType?: string) =>
      ({ id: ts, ts: Date.parse(ts), key: 'k', source: 's', limitId: 'codex', windows: [], planType }) as CodexLimitReading
    const changes = detectPlanChanges([
      r('2026-09-01T10:00:00Z', 'plus'),
      r('2026-09-02T10:00:00Z'),
      r('2026-09-03T10:00:00Z', 'plus'),
      r('2026-10-01T10:00:00Z', 'prolite')
    ])
    expect(changes.map((c) => c.code)).toEqual(['plus', 'prolite'])
    const spans = codexPlanSpans('auto', changes, { pro100: 6 })
    expect(spans.map((s) => [s.label, s.mult])).toEqual([
      ['Plus (plus)', 1],
      ['Pro $100 (prolite)', 6]
    ])
    expect(spans[0].start).toBe(0)
    // A chosen plan applies all along, with its multiplier.
    expect(codexPlanSpans('pro200', changes)).toMatchObject([{ label: 'Pro $200', mult: 10 }])
  })
})

// --------------------------------------------------------------- prices

describe('Codex prices', () => {
  it('has its own table; OpenAI rows match their own id or a dated copy, never a sized variant', () => {
    expect(findPrice('gpt-5.3-codex', DEFAULT_CODEX_PRICES)?.model).toBe('gpt-5.3-codex')
    expect(findPrice('gpt-5.4-2026-03-05', DEFAULT_CODEX_PRICES)?.model).toBe('gpt-5.4')
    expect(findPrice('gpt-5.6-mars', DEFAULT_CODEX_PRICES)).toBeUndefined()
    // Claude Code's table is the same as before.
    expect(DEFAULT_PRICES.every((p) => p.model.startsWith('claude-'))).toBe(true)
    expect(modelLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(unpricedModels(['gpt-5.3-codex', 'GPT-5.3-Codex_spark', 'unknown'], DEFAULT_CODEX_PRICES)).toEqual(['GPT-5.3-Codex_spark'])
  })

  it('adds a newer snapshot\'s models to a saved table, keeping edited rows', () => {
    const saved = [{ ...DEFAULT_CODEX_PRICES[0], input: 99 }]
    const merged = withSnapshotModels(saved, DEFAULT_CODEX_PRICES)
    expect(merged[0].input).toBe(99)
    expect(merged).toHaveLength(DEFAULT_CODEX_PRICES.length)
    expect(codexUsageSettings({}).codexPrices).toHaveLength(DEFAULT_CODEX_PRICES.length)
    expect(codexUsageSettings({}).codexPlan).toBe('auto')
  })
})

// ------------------------------------------- the whole pipeline on fixtures

let root: string
const busy: SessionService[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'csd-codex-usage-'))
  vi.useFakeTimers({ toFake: ['Date'], now: FIXTURES_NOW })
})
afterEach(async () => {
  vi.useRealTimers()
  for (const s of busy.splice(0)) await s.idle()
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

function limitsSettings(over: Partial<CodexLimitsSettings> = {}): CodexLimitsSettings {
  return {
    plan: 'auto',
    mults: {},
    health: { ...DEFAULT_HEALTH },
    elsewhere: [],
    prices: DEFAULT_CODEX_PRICES,
    pace: DEFAULT_PACE,
    weights: DEFAULT_WEIGHTS,
    alertsEnabled: true,
    alertThresholds: [75, 90],
    ...over
  }
}

async function pipeline() {
  await cp(FIXTURES, join(root, 'fixtures'), { recursive: true })
  await prepareFixtures(root, { codex: true })
  const layout = fixturesLayout(root)
  const paths = appPaths(layout.dataDir)
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await metadata.load()
  await settings.load()
  await seedFixtureData(root, paths.archiveDir, metadata)
  const sessions = new SessionService(
    createFixturesPlatform(layout.fixturesDir, layout.sourcesDir),
    paths,
    metadata,
    settings,
    new ProviderRegistry([claudeProvider, createCodexProvider()])
  )
  busy.push(sessions)
  await sessions.start()
  await sessions.idle()
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: 'monday',
    prices: settings.value.prices,
    codexPrices: DEFAULT_CODEX_PRICES
  }))
  await usage.start()
  await usage.idle()
  const key = (id: string) =>
    sessions.list().find((s) => s.provider === 'codex' && s.sessionId === id)!.key
  return { sessions, usage, paths, key, settings }
}

describe('Codex usage on the sample homes', () => {
  it('counts every response once: forks copy, subagents and resumes add', async () => {
    const { usage, key } = await pipeline()
    const recs = usage.codexRecords()
    // 1: two (one re-send skipped), desktop .zst: 1, subagent: 1, fork: its own 1 (2 copies
    // dropped), old format: 2, WSL: 1 (the Spark event has no usage), now: 2.
    expect(recs).toHaveLength(10)
    const total = recs.reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0)
    expect(total).toBe(246_800)
    expect(usage.sessionUsage(key(ID.cli)).responses).toBe(2)
    expect(usage.sessionUsage(key(ID.fork)).responses).toBe(1)
    expect(usage.sessionUsage(key(ID.sub)).responses).toBe(1)
    // Claude Code's records hold no Codex usage.
    expect(usage.allRecords().some((r) => r.provider === 'codex')).toBe(false)
    expect(usage.status().codexRecords).toBe(10)
  })

  it('keeps them across a restart, and recalculates to the same numbers', async () => {
    const { usage, sessions, paths } = await pipeline()
    await usage.flush()
    const again = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
      weekStart: 'monday',
      prices: [],
      codexPrices: DEFAULT_CODEX_PRICES
    }))
    await again.start()
    await again.idle()
    expect(again.codexRecords().map((r) => r.id)).toEqual(usage.codexRecords().map((r) => r.id))
    await again.recalculate()
    expect(again.codexRecords()).toHaveLength(10)
  })

  it('reports per view: Claude (as before), Codex, or both split by provider', async () => {
    const { usage } = await pipeline()
    const claude = usage.report({ period: 'day' })
    const asBefore = usage.report({ period: 'day', provider: 'claude' })
    expect(asBefore.totals).toEqual(claude.totals)
    const codex = usage.report({ period: 'day', provider: 'codex' })
    expect(codex.totals.total).toBe(246_800)
    expect(codex.totals.reasoning).toBeGreaterThan(0)
    expect(codex.totals.cost).toBeGreaterThan(0)
    const all = usage.report({ period: 'day', provider: 'all', groupBy: 'provider' })
    expect(all.totals.total).toBe(claude.totals.total + 246_800)
    expect(all.breakdown.map((b) => b.key).sort()).toEqual(['claude', 'codex'])
    const day = all.series.find((p) => p.bucket === '2026-10-22')!
    expect(Object.keys(day.byProvider ?? {}).sort()).toEqual(['claude', 'codex'])
    expect(claude.series.every((p) => p.byProvider === undefined)).toBe(true)
    // The query from the renderer: "claude" is the same as no provider.
    expect(cleanQuery({ provider: 'codex' }).provider).toBe('codex')
    expect(cleanQuery({ provider: 'claude' }).provider).toBeUndefined()
    expect(cleanQuery({ provider: 'nope' }).provider).toBeUndefined()
  })

  it('exports CSV with a provider column', async () => {
    const { usage } = await pipeline()
    const csv = usage.csv({ period: 'day', provider: 'all' }, false).split('\r\n')
    expect(csv[0].split(',').slice(-2)).toEqual(['reasoning', 'provider'])
    expect(csv.some((l) => l.endsWith(',codex'))).toBe(true)
    expect(csv.some((l) => l.endsWith(',claude'))).toBe(true)
    const perRecord = usage.csv({ period: 'day', provider: 'codex' }, true).split('\r\n')
    expect(perRecord.slice(1).filter(Boolean).every((l) => l.endsWith(',codex'))).toBe(true)
    const rec: UsageRecord = { ...usage.codexRecords()[0] }
    expect(toCsv([rec], { timeZone: 'UTC', prices: DEFAULT_CODEX_PRICES })).toContain(',codex')
  })

  it('reads context size from the last token_count, with the window from the log', async () => {
    const { sessions, key, usage } = await pipeline()
    const s = sessions.get(key(ID.now))!
    expect(s.context).toMatchObject({
      tokens: 65_800,
      from: 'usage',
      model: 'gpt-6.1-sol',
      windowSize: 353_400,
      baseTokens: 41_000
    })
    const limits = new CodexLimitsService(usage, () => limitsSettings(), () => undefined)
    const cost = new ContextCost({
      limits: { dollarsPerPct: () => undefined, state: async () => ({}) as never, isSubscription: () => true },
      usage,
      settings: () => ({ capacityWeights: DEFAULT_WEIGHTS, prices: DEFAULT_PRICES }) as never,
      codex: { limits, prices: () => DEFAULT_CODEX_PRICES }
    })
    const est = (await cost.estimate(s, {}))!
    expect(est.windowFrom).toBe('codex-log')
    expect(est.cacheNote).toBe(CODEX_CACHE_NOTE)
    expect(est.warmUntil).toBeUndefined()
    // Cold: the whole context at the input price.
    const p = findPrice('gpt-6.1-sol', DEFAULT_CODEX_PRICES)!
    expect(est.resume.costUsd).toBeCloseTo((65_800 * p.input) / 1e6, 6)
    expect(est.unknown).toMatch(/Codex limit history/)
    // A compaction with no reply since: estimated from the summary.
    const compacted = analyzeCodex(
      [
        tc('2026-10-20T10:00:01Z', { total_token_usage: counts(9000, 0, 100), last_token_usage: counts(9000, 0, 100), model_context_window: 272000 }),
        JSON.stringify({ timestamp: '2026-10-20T10:05:00Z', type: 'compacted', payload: { message: 'x'.repeat(4000) } })
      ].join('\n')
    )
    expect(compacted.context).toMatchObject({ from: 'compaction', tokens: 9000 + 1000, compactions: 1, preCompactTokens: 9100 })
  })
})

describe('Codex limits on the sample homes', () => {
  it('shows gauges by window length, with stale windows, extra limits and the detected plan', async () => {
    const { usage } = await pipeline()
    const l = new CodexLimitsService(usage, () => limitsSettings(), () => undefined).state()
    expect(l.provider).toBe('codex')
    expect(l.hasData).toBe(true)
    // Weekly: the session running now, 23%, fresh.
    expect(l.sevenDay).toMatchObject({ pct: 23, expired: false })
    expect(FIXTURES_NOW - l.sevenDay!.updatedAt).toBeLessThan(60 * 60_000)
    expect(l.stale).toBe(false)
    // 5-hour: last seen on Plus (Oct 20), reset since: no current %, the last one kept.
    expect(l.fiveHour).toMatchObject({ expired: true, pct: 0, lastPct: 20 })
    expect(l.fiveHourRecent).toBe(true)
    // The fork's copies of the Plus readings never pose as newer ones.
    expect(l.plan).toMatchObject({
      setting: 'auto',
      plan: 'pro100',
      label: 'Pro $100 (prolite)',
      detectedCode: 'prolite',
      mult: 5
    })
    expect(l.plan.changes.map((c) => c.code)).toEqual(['plus', 'prolite'])
    expect(l.extraLimits).toMatchObject([
      { limitId: 'codex_bengalfox', label: 'GPT-5.3-Codex-Spark', recent: true }
    ])
    expect(l.extraLimits[0].windows[0]).toMatchObject({ minutes: 10080, label: 'Weekly' })
    expect(l.pace7d?.kind).toBe('seven_day')
    expect(l.advice?.text).not.toMatch(/Claude/)
  })

  it('a chosen plan overrides the detected one, with its multiplier', async () => {
    const { usage } = await pipeline()
    const l = new CodexLimitsService(
      usage,
      () => limitsSettings({ plan: 'pro200', mults: { pro200: 12 } }),
      () => undefined
    ).state()
    expect(l.plan).toMatchObject({ setting: 'pro200', plan: 'pro200', label: 'Pro $200', mult: 12, detectedCode: 'prolite' })
    expect(l.health7d?.plans).toMatchObject([{ label: 'Pro $200', mult: 12 }])
  })

  it("keeps limit health per provider: Codex's own baseline, plans and wording", async () => {
    const { usage } = await pipeline()
    const svc = new CodexLimitsService(
      usage,
      () => limitsSettings({ health: { ...DEFAULT_HEALTH, baselineFrom: '2026-10-01', baselineTo: '2026-10-31', minPct: 1 } }),
      () => undefined
    )
    const h = svc.health('seven_day')
    expect(h.settings.baselineFrom).toBe('2026-10-01')
    expect(h.plans.map((p) => p.label)).toEqual(['Plus (plus)', 'Pro $100 (prolite)'])
    // Scored from Codex's own records only.
    const models = new Set(h.windows.flatMap((w) => Object.keys(w.models)))
    expect([...models].every((m) => !m.startsWith('claude'))).toBe(true)
  })

  it('alerts once when a Codex window passes 75% or 90%', async () => {
    const readings: CodexLimitReading[] = []
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [] as UsageRecord[],
      codexLimitReadings: () => readings
    })
    const notify = vi.fn()
    const svc = new CodexLimitsService(usage, () => limitsSettings(), notify)
    svc.start()
    const at = (pct: number, dt: number): CodexLimitReading => ({
      id: `r${pct}`,
      ts: FIXTURES_NOW - dt,
      key: 'k',
      source: 's',
      limitId: 'codex',
      windows: [{ pct, minutes: 10080, resetsAt: FIXTURES_NOW + 86_400_000 }]
    })
    readings.push(at(60, 120_000))
    usage.emit('changed')
    readings.push(at(80, 60_000))
    usage.emit('changed')
    readings.push(at(81, 30_000))
    usage.emit('changed')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatch(/Codex weekly: 80% used/)
    readings.push(at(92, 0))
    usage.emit('changed')
    expect(notify).toHaveBeenCalledTimes(2)
    // Off in Settings: nothing.
    const quiet = vi.fn()
    const off = new CodexLimitsService(usage, () => limitsSettings({ alertsEnabled: false }), quiet)
    off.start()
    readings.push({ ...at(99, 0), id: 'r99' })
    usage.emit('changed')
    expect(quiet).not.toHaveBeenCalled()
  })

  it('a window that has reset since its reading shows no current %', () => {
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [] as UsageRecord[],
      codexLimitReadings: (): CodexLimitReading[] => [
        {
          id: 'a',
          ts: FIXTURES_NOW - 6 * 3_600_000,
          key: 'k',
          source: 's',
          limitId: 'codex',
          windows: [{ pct: 55, minutes: 300, resetsAt: FIXTURES_NOW - 3_600_000 }]
        }
      ]
    })
    const l = new CodexLimitsService(usage, () => limitsSettings(), () => undefined).state()
    expect(l.fiveHour).toMatchObject({ expired: true, pct: 0, lastPct: 55 })
    expect(l.stale).toBe(true)
    expect(l.sevenDay).toBeUndefined()
  })
})
