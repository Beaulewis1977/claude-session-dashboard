// Codex usage and limits (Phase C): token_count deltas, counting each
// response once across forks / resumes / subagents, .zst rollouts,
// rate_limits parsing (both windows, missing fields, stale), plan detection,
// limit health per provider, the provider views, the CSV provider column and
// resume estimates. The sample homes are in fixtures/codex (see
// scripts/make-codex-fixtures.mjs).

import { EventEmitter } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const OLD_FILE = join(CODEX, 'archived_sessions', `rollout-2026-09-30T10-00-00-${ID.old}.jsonl.zst`)

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
    expect(records[0]).toMatchObject({
      model: 'gpt-5.5',
      input: 8000,
      cacheRead: 6000,
      output: 700
    })
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
        primary: {
          used_percent: 12.5,
          window_minutes: 300,
          resets_at: sec('2026-10-20T13:00:00Z')
        },
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
        {
          primary: { used_percent: 5, window_minutes: 300, resets_at: sec('2026-10-20T08:00:00Z') }
        },
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
      lines.push(
        tc(
          t,
          { total_token_usage: counts(total, 0, 0), last_token_usage: counts(10, 0, 0) },
          rl(i < 20 ? 5 : 6)
        )
      )
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
      ({
        id: ts,
        ts: Date.parse(ts),
        key: 'k',
        source: 's',
        limitId: 'codex',
        windows: [],
        planType
      }) as CodexLimitReading
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
    expect(
      unpricedModels(['gpt-5.3-codex', 'GPT-5.3-Codex_spark', 'unknown'], DEFAULT_CODEX_PRICES)
    ).toEqual(['GPT-5.3-Codex_spark'])
  })

  it("adds a newer snapshot's models to a saved table, keeping edited rows", () => {
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
    expect(
      perRecord
        .slice(1)
        .filter(Boolean)
        .every((l) => l.endsWith(',codex'))
    ).toBe(true)
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
    const limits = new CodexLimitsService(
      usage,
      () => limitsSettings(),
      () => undefined
    )
    const cost = new ContextCost({
      limits: {
        dollarsPerPct: () => undefined,
        state: async () => ({}) as never,
        isSubscription: () => true
      },
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
        tc('2026-10-20T10:00:01Z', {
          total_token_usage: counts(9000, 0, 100),
          last_token_usage: counts(9000, 0, 100),
          model_context_window: 272000
        }),
        JSON.stringify({
          timestamp: '2026-10-20T10:05:00Z',
          type: 'compacted',
          payload: { message: 'x'.repeat(4000) }
        })
      ].join('\n')
    )
    expect(compacted.context).toMatchObject({
      from: 'compaction',
      tokens: 9000 + 1000,
      compactions: 1,
      preCompactTokens: 9100
    })
  })
})

describe('Codex limits on the sample homes', () => {
  it('shows gauges by window length, with stale windows, extra limits and the detected plan', async () => {
    const { usage } = await pipeline()
    const l = new CodexLimitsService(
      usage,
      () => limitsSettings(),
      () => undefined
    ).state()
    expect(l.provider).toBe('codex')
    expect(l.hasData).toBe(true)
    // Weekly: the session running now, 23%, fresh.
    expect(l.sevenDay).toMatchObject({ pct: 23, expired: false })
    expect(FIXTURES_NOW - l.sevenDay!.updatedAt).toBeLessThan(60 * 60_000)
    expect(l.stale).toBe(false)
    // Pro has no 5-hour window. The Plus readings (Oct 18-20) are another plan_type: never
    // mixed into these gauges, shown as their own (reset since: the last value kept).
    expect(l.fiveHour).toBeUndefined()
    expect(l.fiveHourRecent).toBe(false)
    const plus = l.extraLimits.find((e) => e.limitId === 'account:plus')!
    expect(plus.label).toBe('Plus (plus) · another sign-in or an earlier plan')
    expect(plus.windows.map((w) => [w.minutes, w.gauge.expired, w.gauge.lastPct])).toEqual([
      [300, true, 20],
      [10080, false, 25]
    ])
    // The fork's copies of the Plus readings never pose as newer ones.
    expect(l.plan).toMatchObject({
      setting: 'auto',
      plan: 'pro100',
      label: 'Pro $100 (prolite)',
      detectedCode: 'prolite',
      mult: 5
    })
    expect(l.plan.changes.map((c) => c.code)).toEqual(['plus', 'prolite'])
    const spark = l.extraLimits.find((e) => e.limitId === 'codex_bengalfox')!
    expect(spark).toMatchObject({ label: 'GPT-5.3-Codex-Spark', recent: true })
    expect(spark.windows[0]).toMatchObject({ minutes: 10080, label: 'Weekly' })
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
    expect(l.plan).toMatchObject({
      setting: 'pro200',
      plan: 'pro200',
      label: 'Pro $200',
      mult: 12,
      detectedCode: 'prolite'
    })
    expect(l.health7d?.plans).toMatchObject([{ label: 'Pro $200', mult: 12 }])
  })

  it("keeps limit health per provider: Codex's own baseline, plans and wording", async () => {
    const { usage } = await pipeline()
    const svc = new CodexLimitsService(
      usage,
      () =>
        limitsSettings({
          health: {
            ...DEFAULT_HEALTH,
            baselineFrom: '2026-10-01',
            baselineTo: '2026-10-31',
            minPct: 1
          }
        }),
      () => undefined
    )
    const h = svc.health('seven_day')
    expect(h.settings.baselineFrom).toBe('2026-10-01')
    // The followed account's plan only.
    expect(h.plans.map((p) => p.label)).toEqual(['Pro $100 (prolite)'])
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

  it('never mixes two accounts (plan types) in one gauge, and reads 299/10079-minute windows', () => {
    const r = (
      ts: number,
      plan: string | undefined,
      pct: number,
      minutes = 10080
    ): CodexLimitReading => ({
      id: `${plan}${ts}`,
      ts,
      key: 'k',
      source: 's',
      limitId: 'codex',
      ...(plan ? { planType: plan } : {}),
      windows: [{ pct, minutes, resetsAt: FIXTURES_NOW + 86_400_000 }]
    })
    const readings = [
      r(FIXTURES_NOW - 5_000, 'plus', 90),
      r(FIXTURES_NOW - 4_000, 'prolite', 10),
      r(FIXTURES_NOW - 3_000, 'plus', 91),
      r(FIXTURES_NOW - 2_000, 'prolite', 11, 10079)
    ]
    const rec = (plan: string, ts: number): UsageRecord => ({
      id: plan + ts,
      ts,
      key: 'k',
      project: 'p',
      env: 'windows',
      model: 'gpt-6.1-sol',
      provider: 'codex',
      plan,
      input: 1000,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0
    })
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [
        rec('plus', FIXTURES_NOW - 10_000),
        rec('prolite', FIXTURES_NOW - 9_000)
      ],
      codexLimitReadings: () => readings
    })
    const l = new CodexLimitsService(
      usage,
      () => limitsSettings(),
      () => undefined
    ).state()
    expect(l.sevenDay).toMatchObject({ pct: 11, tokens: 1000 })
    expect(l.plan).toMatchObject({ detectedCode: 'prolite', label: 'Pro $100 (prolite)' })
    expect(l.plan.changes.map((c) => c.code)).toEqual(['plus', 'prolite'])
    expect(l.extraLimits[0]).toMatchObject({ limitId: 'account:plus', recent: true })
    expect(l.extraLimits[0].windows[0].gauge.pct).toBe(91)
    expect(windowKindOf(299)).toBe('five_hour')
    expect(windowLabel(10079)).toBe('Weekly')
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
    const l = new CodexLimitsService(
      usage,
      () => limitsSettings(),
      () => undefined
    ).state()
    expect(l.fiveHour).toMatchObject({ expired: true, pct: 0, lastPct: 55 })
    expect(l.stale).toBe(true)
    expect(l.sevenDay).toBeUndefined()
  })
})

describe('Ask Claude and settings', () => {
  it('sends Codex numbers only, in their own section; Claude-only data is as before', async () => {
    const { buildAskData, buildAskPrompt } = await import('@shared/ask')
    const base = {
      now: FIXTURES_NOW,
      timeZone: 'UTC',
      plan: 'max5' as const,
      planHistory: [],
      records: [],
      limitHits: [],
      prices: DEFAULT_PRICES,
      elsewhere: []
    }
    const claudeOnly = buildAskData(base)
    expect('codex' in claudeOnly).toBe(false)
    expect(buildAskPrompt('q', claudeOnly)).not.toContain('Codex')
    const rec: UsageRecord = {
      id: 'c1',
      ts: FIXTURES_NOW - 3_600_000,
      key: 'codex-windows:x',
      project: 'secret-project',
      env: 'windows',
      model: 'gpt-6.1-sol',
      provider: 'codex',
      input: 100,
      output: 50,
      cacheWrite: 0,
      cacheRead: 900,
      reasoning: 20
    }
    const withCodex = buildAskData({
      ...base,
      codex: {
        plan: 'Pro $100 (prolite)',
        multiplier: 5,
        records: [rec],
        prices: DEFAULT_CODEX_PRICES,
        windows: [{ minutes: 10080, pct: 23, resetsAt: FIXTURES_NOW + 86_400_000 }]
      }
    })
    expect(withCodex.codex).toMatchObject({
      plan: 'Pro $100 (prolite)',
      planMultiplierVsPlus: 5,
      limitsNow: [{ windowMinutes: 10080, pct: 23 }],
      monthlyTotals: [{ month: '2026-10', tokens: 1050, reasoning: 20, responses: 1 }]
    })
    // Numbers only: no project names or session keys.
    expect(JSON.stringify(withCodex.codex)).not.toMatch(/secret-project|codex-windows/)
    expect(buildAskPrompt('q', withCodex)).toContain('Never combine')
  })

  it('cleans Codex settings from the renderer', async () => {
    const { codexSettingsPatch } = await import('@shared/usage/codex-settings')
    expect(codexSettingsPatch({ codexPlan: 'nope' as never }, {})).toEqual({})
    expect(codexSettingsPatch({ codexPlan: 'pro200' }, {})).toEqual({ codexPlan: 'pro200' })
    // The whole map (Reset sends {}), never merged with the old one.
    expect(codexSettingsPatch({ codexPlanMults: {} }, { codexPlanMults: { pro200: 12 } })).toEqual({
      codexPlanMults: {}
    })
    expect(
      codexSettingsPatch(
        { codexPlanMults: { pro100: 6, plus: -1 } as never },
        { codexPlanMults: { pro200: 12 } }
      )
    ).toEqual({ codexPlanMults: { pro100: 6 } })
    expect(codexSettingsPatch({ codexAccounts: 'one' }, {})).toEqual({ codexAccounts: 'one' })
    expect(codexSettingsPatch({ meterProvider: 'both', usageSplit: 'split' }, {})).toEqual({
      meterProvider: 'both',
      usageSplit: 'split'
    })
    expect(
      codexSettingsPatch({ codexHealth: { threshold: 2 } as never }, {}).codexHealth
    ).toMatchObject({
      threshold: 2,
      streak: DEFAULT_HEALTH.streak
    })
  })
})

describe('older window lengths', () => {
  it('counts 299 and 300 minutes as one 5-hour window in every gauge list', () => {
    const r = (ts: number, minutes: number, pct: number): CodexLimitReading => ({
      id: `r${ts}`,
      ts,
      key: 'k',
      source: 's',
      limitId: 'codex_other',
      windows: [{ pct, minutes, resetsAt: FIXTURES_NOW + 3_600_000 }]
    })
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [] as UsageRecord[],
      codexLimitReadings: () => [r(FIXTURES_NOW - 9_000, 299, 40), r(FIXTURES_NOW - 1_000, 300, 45)]
    })
    const l = new CodexLimitsService(
      usage,
      () => limitsSettings(),
      () => undefined
    ).state()
    expect(l.extraLimits[0].windows.map((w) => [w.minutes, w.label, w.gauge.pct])).toEqual([
      [300, '5-hour window', 45]
    ])
  })
})

describe('review fixes: counting and limit history', () => {
  const ev = (ts: string, total: number[], last: number[], rl: unknown = null) =>
    tc(
      ts,
      {
        total_token_usage: counts(total[0], 0, total[1]),
        last_token_usage: counts(last[0], 0, last[1])
      },
      rl
    )
  const parent = [
    ev('2026-10-20T10:00:00Z', [100, 10], [100, 10]),
    ev('2026-10-20T10:01:00Z', [300, 20], [200, 10])
  ]
  // Two sibling forks copy the parent, then each makes one response with the same counts.
  const sibling = [...parent, ev('2026-10-21T09:00:00Z', [400, 30], [100, 10])]
  const meta = (key: string, sid: string) => ({ ...ctx, key, sessionId: sid, lineageRoot: 'p' })

  it('counts matching responses in sibling forks twice, their copied history once', () => {
    const store = new CodexUsageStore()
    store.setLineage([
      { sessionId: 'p' },
      { sessionId: 'a', forkedFromId: 'p' },
      { sessionId: 'b', forkedFromId: 'p' }
    ])
    for (const [k, sid, text] of [
      ['w:p', 'p', parent],
      ['w:a', 'a', sibling],
      ['w:b', 'b', sibling]
    ] as const) {
      const r = analyzeCodexUsage(text.join('\n'), meta(k, sid))
      store.set(k, r.records, r.codexLimits ?? [])
    }
    const recs = store.records()
    expect(recs.filter((r) => r.key === 'w:p')).toHaveLength(2)
    expect(
      recs
        .filter((r) => r.key !== 'w:p')
        .map((r) => r.key)
        .sort()
    ).toEqual(['w:a', 'w:b'])
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length)
  })

  it("takes siblings' shared events as copied history when their parent is gone", () => {
    const store = new CodexUsageStore()
    store.setLineage([
      { sessionId: 'a', forkedFromId: 'p' },
      { sessionId: 'b', forkedFromId: 'p' }
    ])
    for (const [k, sid] of [
      ['w:a', 'a'],
      ['w:b', 'b']
    ] as const) {
      const r = analyzeCodexUsage(parent.join('\n'), meta(k, sid))
      store.set(k, r.records, [])
    }
    expect(store.records()).toHaveLength(2)
  })

  it('counts a response after a counter reset even when its counts match an earlier one', () => {
    const text = [
      ev('2026-10-20T10:00:00Z', [100, 10], [100, 10]),
      ev('2026-10-20T11:00:00Z', [100, 10], [100, 10])
    ]
    // The second one is a repeat (same total), so a reset in between makes it new usage:
    const reset = [
      text[0],
      tc('2026-10-20T10:30:00Z', {
        total_token_usage: counts(5, 0, 0),
        last_token_usage: counts(5, 0, 0)
      }),
      text[1]
    ]
    const { records } = analyzeCodexUsage(reset.join('\n'), ctx)
    expect(records).toHaveLength(3)
    expect(new Set(records.map((r) => r.id)).size).toBe(3)
  })

  it('keeps a later identical reading, so a current gauge stays current', () => {
    const rl = {
      primary: { used_percent: 9, window_minutes: 10080, resets_at: sec('2026-10-25T00:00:00Z') },
      plan_type: 'plus'
    }
    const a = counts(10, 0, 1)
    const text = [
      tc('2026-10-20T10:00:00Z', { total_token_usage: a, last_token_usage: a }, rl),
      tc('2026-10-20T10:30:00Z', { total_token_usage: a, last_token_usage: a }, rl)
    ].join('\n')
    const { codexLimits } = analyzeCodexUsage(text, ctx)
    expect(codexLimits!.map((r) => r.ts)).toEqual([
      Date.parse('2026-10-20T10:00:00Z'),
      Date.parse('2026-10-20T10:30:00Z')
    ])
    expect(new Set(codexLimits!.map((r) => r.id)).size).toBe(2)
  })

  const reading = (
    id: string,
    ts: number,
    planType: string | undefined,
    pct: number
  ): CodexLimitReading => ({
    id,
    ts,
    key: 'k',
    source: 's',
    limitId: 'codex',
    ...(planType ? { planType } : {}),
    windows: [{ pct, minutes: 10080, resetsAt: FIXTURES_NOW + 86_400_000 }]
  })
  const svc = (
    readings: CodexLimitReading[],
    over: Partial<CodexLimitsSettings> = {},
    notify = () => undefined
  ) =>
    new CodexLimitsService(
      Object.assign(new EventEmitter(), {
        codexRecords: () => [] as UsageRecord[],
        codexLimitReadings: () => readings
      }),
      () => limitsSettings(over),
      notify
    )

  it('a newest reading without a plan keeps the account; One account merges plan changes', () => {
    const rs = [
      reading('a', FIXTURES_NOW - 3_000, 'plus', 30),
      reading('b', FIXTURES_NOW - 2_000, 'prolite', 5),
      reading('c', FIXTURES_NOW - 1_000, undefined, 6)
    ]
    expect(svc(rs).state().plan.detectedCode).toBe('prolite')
    const one = svc(rs, { accounts: 'one' }).state()
    expect(one.extraLimits).toEqual([])
    expect(one.sevenDay?.pct).toBe(6)
    expect(one.health7d?.plans.map((p) => p.label)).toEqual(['Plus (plus)', 'Pro $100 (prolite)'])
  })

  it('alerts each sign-in on its own, also for a session scanned late', () => {
    const rs: CodexLimitReading[] = []
    const notify = vi.fn()
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [] as UsageRecord[],
      codexLimitReadings: () => rs
    })
    const s = new CodexLimitsService(usage, () => limitsSettings(), notify)
    rs.push(reading('n1', FIXTURES_NOW - 60_000, 'plus', 80))
    s.start()
    rs.push(reading('n2', FIXTURES_NOW - 50_000, 'prolite', 80))
    usage.emit('changed')
    expect(notify).toHaveBeenCalledTimes(1)
    // An older reading from a session found later is still checked.
    rs.unshift(reading('late', FIXTURES_NOW - 120_000, 'pro', 92))
    usage.emit('changed')
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

describe('review fixes: migration, fork timing, gone forks, plan changes, model limits', () => {
  const ev = (ts: string, total: number[], last: number[]) =>
    tc(ts, {
      total_token_usage: counts(total[0], 0, total[1]),
      last_token_usage: counts(last[0], 0, last[1])
    })
  const meta = (key: string, sid: string) => ({ ...ctx, key, sessionId: sid, lineageRoot: 'p' })
  const add = (store: CodexUsageStore, key: string, sid: string, text: string[]) => {
    const a = analyzeCodexUsage(text.join('\n'), meta(key, sid))
    store.set(key, a.records, a.codexLimits ?? [])
  }
  // The parent's history, then (after the fork was made at 09:00) one more response.
  const history = [
    ev('2026-10-20T10:00:00Z', [100, 10], [100, 10]),
    ev('2026-10-20T10:01:00Z', [300, 20], [200, 10])
  ]
  const parent = [...history, ev('2026-10-21T09:30:00Z', [400, 30], [100, 10])]
  // Codex writes a fork's copies right when it makes the fork, then its own responses.
  const copies = (start: string) => [
    ev(start, [100, 10], [100, 10]),
    ev(start, [300, 20], [200, 10])
  ]
  const fork = [
    ...copies('2026-10-21T09:00:00.005Z'),
    ev('2026-10-21T09:20:00Z', [400, 30], [100, 10])
  ]

  it('counts a fork response that matches a later one of its parent (copies still once)', () => {
    const store = new CodexUsageStore()
    store.setLineage([
      { sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' },
      { sessionId: 'f', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' }
    ])
    add(store, 'w:p', 'p', parent)
    add(store, 'w:f', 'f', fork)
    const recs = store.records()
    expect(recs.filter((x) => x.key === 'w:p')).toHaveLength(3)
    // Only the fork's own response: its copies of the history are the parent's.
    expect(recs.filter((x) => x.key === 'w:f').map((x) => x.ts)).toEqual([
      Date.parse('2026-10-21T09:20:00Z')
    ])
    expect(new Set(recs.map((x) => x.id)).size).toBe(recs.length)
  })

  it('with the parent gone, siblings count its copied history once and own matches twice', () => {
    const store = new CodexUsageStore()
    store.setLineage([
      { sessionId: 'a', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' },
      { sessionId: 'b', forkedFromId: 'p', startedAt: '2026-10-22T08:00:00Z' }
    ])
    add(store, 'w:a', 'a', fork)
    add(store, 'w:b', 'b', [
      ...copies('2026-10-22T08:00:00.004Z'),
      ev('2026-10-22T08:30:00Z', [400, 30], [100, 10])
    ])
    const recs = store.records()
    expect(recs).toHaveLength(4)
    const own = recs.filter((x) => x.ts >= Date.parse('2026-10-21T09:10:00Z'))
    expect(own.map((x) => x.key)).toEqual(['w:a', 'w:b'])
  })

  it("keeps a gone fork's links, so its copies of the parent's history never count again", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-lineage-'))
    try {
      const store = new CodexUsageStore()
      store.setLineage([
        { sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' },
        { sessionId: 'f', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' }
      ])
      add(store, 'w:p', 'p', parent)
      add(store, 'w:f', 'f', fork)
      await store.flush(dir, dir)
      // Next start: the fork's rollout is gone from the catalogue, its rows stay.
      const next = new CodexUsageStore()
      await next.load(dir)
      next.setLineage([{ sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' }])
      expect(next.records()).toHaveLength(4)
      expect(next.roots().get('f')).toBe('p')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("an update keeps an older parser's rows until that session is read again", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-migrate-'))
    try {
      const old = new CodexUsageStore()
      add(old, 'w:p', 'p', parent)
      // An unrelated session (other counts).
      add(old, 'w:q', 'q', [
        ev('2026-10-20T12:00:00Z', [111, 11], [111, 11]),
        ev('2026-10-20T12:01:00Z', [222, 22], [111, 11])
      ])
      old.index['w:p'] = 'old'
      await old.flush(dir, dir)
      // As if an older parser wrote them.
      const idxPath = join(dir, 'codex-index.json')
      const idx = JSON.parse(await readFile(idxPath, 'utf8'))
      await writeFile(idxPath, JSON.stringify({ ...idx, version: 1 }))

      const store = new CodexUsageStore()
      await store.load(dir)
      expect(store.index).toEqual({})
      expect(store.records()).toHaveLength(5)
      // w:p is read again; w:q's rollout is offline this time.
      add(store, 'w:p', 'p', parent.slice(0, 1))
      store.index['w:p'] = 'sig'
      await store.flush(dir, dir)
      const again = new CodexUsageStore()
      await again.load(dir)
      expect(again.records().filter((x) => x.key === 'w:q')).toHaveLength(2)
      expect(again.records().filter((x) => x.key === 'w:p')).toHaveLength(1)
      const saved = JSON.parse(await readFile(idxPath, 'utf8'))
      expect(saved.legacy).toEqual(['w:q'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const r = (
    id: string,
    ago: number,
    planType: string,
    windows: { pct: number; minutes: number }[],
    limitId = 'codex'
  ): CodexLimitReading => ({
    id,
    ts: FIXTURES_NOW - ago,
    key: 'k',
    source: 's',
    limitId,
    planType,
    windows: windows.map((w) => ({ ...w, resetsAt: FIXTURES_NOW + 3_600_000 }))
  })
  const svc = (readings: CodexLimitReading[], over: Partial<CodexLimitsSettings> = {}) =>
    new CodexLimitsService(
      Object.assign(new EventEmitter(), {
        codexRecords: () => [] as UsageRecord[],
        codexLimitReadings: () => readings
      }),
      () => limitsSettings(over),
      () => undefined
    )
  const report = (value: number) => ({ baseline: { value }, plans: [{ start: 0, mult: 1 }] })

  it('one account on a weekly-only plan now: no 5-hour gauge or baseline from the earlier plan', () => {
    const rs = [
      r('a', 2 * 86_400_000, 'plus', [
        { pct: 40, minutes: 300 },
        { pct: 20, minutes: 10080 }
      ]),
      r('b', 60_000, 'prolite', [{ pct: 7, minutes: 10080 }])
    ]
    const s = svc(rs, { accounts: 'one' })
    const st = s.state()
    expect(st.fiveHourRecent).toBe(false)
    expect(st.fiveHour).toBeUndefined()
    expect(st.sevenDay?.pct).toBe(7)
    // A 5-hour baseline (from the earlier plan) is never used for estimates.
    vi.spyOn(s, 'health').mockImplementation(
      (kind) => (kind === 'five_hour' ? report(0.5) : { plans: [] }) as never
    )
    expect(s.dollarsPerPct()).toBeUndefined()
    // While the plan in force has a 5-hour window, its baseline is used.
    const both = svc([...rs, r('c', 1_000, 'prolite', [{ pct: 3, minutes: 300 }])], {
      accounts: 'one'
    })
    vi.spyOn(both, 'health').mockImplementation(
      (kind) => (kind === 'five_hour' ? report(0.5) : { plans: [] }) as never
    )
    expect(both.dollarsPerPct()?.kind).toBe('five_hour')
  })

  it("shows each sign-in's model limits apart (a Spark gauge never mixes two)", () => {
    const rs = [
      r('m1', 120_000, 'plus', [{ pct: 50, minutes: 10080 }]),
      r('x1', 110_000, 'plus', [{ pct: 61, minutes: 300 }], 'codex_spark'),
      r('m2', 60_000, 'prolite', [{ pct: 4, minutes: 10080 }]),
      r('x2', 50_000, 'prolite', [{ pct: 2, minutes: 10080 }], 'codex_spark')
    ]
    const st = svc(rs).state()
    const spark = st.extraLimits.filter((b) => b.limitId.startsWith('codex_spark'))
    expect(spark.map((b) => [b.limitId, b.windows.map((w) => w.gauge.pct)])).toEqual([
      ['codex_spark', [2]],
      ['codex_spark@plus', [61]]
    ])
    expect(spark[1].label).toContain('another sign-in')
    // One account: the plan in force now has its own Spark gauge; the earlier
    // plan's window is never mixed in (listed apart, under "Other limits").
    const one = svc(rs, { accounts: 'one' }).state()
    expect(
      one.extraLimits.map((b) => [b.limitId, b.windows.map((w) => w.gauge.pct), b.recent])
    ).toEqual([
      ['codex_spark', [2], true],
      ['codex_spark@earlier', [61], false]
    ])
    expect(one.extraLimits[1].label).toContain('earlier plan')
  })
})

describe('review fixes: parser versions, unsaved links, fork timing, alerts, loading', () => {
  const rl = (pct: number) => ({
    primary: { used_percent: pct, window_minutes: 10080, resets_at: sec('2026-10-25T00:00:00Z') },
    plan_type: 'plus'
  })
  const ev = (ts: string, total: number[], last: number[], pct?: number) =>
    tc(
      ts,
      {
        total_token_usage: counts(total[0], 0, total[1]),
        last_token_usage: counts(last[0], 0, last[1])
      },
      pct === undefined ? null : rl(pct)
    )
  const meta = (key: string, sid: string) => ({ ...ctx, key, sessionId: sid, lineageRoot: 'p' })
  const add = (store: CodexUsageStore, key: string, sid: string, text: string[]) => {
    const a = analyzeCodexUsage(text.join('\n'), meta(key, sid))
    store.set(key, a.records, a.codexLimits ?? [])
  }
  const lineage = [
    { sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' },
    { sessionId: 'f', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' }
  ]
  const parent = [
    ev('2026-10-20T10:00:00Z', [100, 10], [100, 10], 5),
    ev('2026-10-20T10:01:00Z', [300, 20], [200, 10], 7),
    ev('2026-10-21T09:30:00Z', [400, 30], [100, 10], 9)
  ]
  // Copies written when the fork is made (09:00), then the fork's own response.
  const fork = [
    ev('2026-10-21T09:00:00.004Z', [100, 10], [100, 10], 5),
    ev('2026-10-21T09:00:00.005Z', [300, 20], [200, 10], 7),
    ev('2026-10-21T09:20:00Z', [450, 35], [150, 15], 8)
  ]

  /** Saves p and f as an older parser did (other identities), then loads them. */
  async function olderCache(dir: string, saveLinks: boolean, older = true) {
    const store = new CodexUsageStore()
    if (saveLinks) store.setLineage(lineage)
    add(store, 'w:p', 'p', parent)
    add(store, 'w:f', 'f', fork)
    store.index = { 'w:p': 'x', 'w:f': 'x' }
    await store.flush(dir, dir)
    const idxPath = join(dir, 'codex-index.json')
    const idx = JSON.parse(await readFile(idxPath, 'utf8'))
    if (older) {
      // Another identity scheme: every id differs from what this parser makes.
      for (const f of ['codex-records-2026-10.ndjson', 'codex-limits-2026-10.ndjson']) {
        const rows = (await readFile(join(dir, f), 'utf8'))
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
          .map((x) => ({ ...x, id: `old:${x.id}` }))
        await writeFile(join(dir, f), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
      }
      idx.version = 2
    }
    if (!saveLinks) delete idx.lineage
    await writeFile(idxPath, JSON.stringify(idx))
    const next = new CodexUsageStore()
    await next.load(dir)
    return next
  }

  it("never counts an offline fork's older copies again next to its re-read parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-mixed-'))
    try {
      const store = await olderCache(dir, true)
      store.setLineage(lineage.slice(0, 1))
      add(store, 'w:p', 'p', parent) // the parent is read again; the fork is offline
      const recs = store.records()
      expect(recs.filter((x) => x.key === 'w:p')).toHaveLength(3)
      expect(recs.filter((x) => x.key === 'w:f').map((x) => x.ts)).toEqual([
        Date.parse('2026-10-21T09:20:00Z')
      ])
      // Limits too: the fork's copied readings aren't readings of their own.
      const reads = store.readings().filter((x) => x.key === 'w:f')
      expect(reads.map((x) => x.windows[0].pct)).toEqual([8])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("and the other way round: a re-read fork next to its offline parent's older rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-mixed2-'))
    try {
      const store = await olderCache(dir, true)
      store.setLineage(lineage.slice(1))
      add(store, 'w:f', 'f', fork)
      const recs = store.records()
      expect(recs).toHaveLength(4)
      expect(recs.filter((x) => x.key === 'w:f')).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("finds a gone fork's parent when no link was saved for it (from its copies)", async () => {
    for (const older of [false, true]) {
      const dir = await mkdtemp(join(tmpdir(), 'csd-codex-nolinks-'))
      try {
        const store = await olderCache(dir, false, older)
        // Only the parent is in the catalogue now; the fork's rows have no link.
        store.setLineage(lineage.slice(0, 1))
        if (older) add(store, 'w:p', 'p', parent)
        const recs = store.records()
        expect(recs).toHaveLength(4)
        expect(recs.filter((x) => x.key === 'w:f')).toHaveLength(1)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  it('counts a fork response matching one its parent made just after the fork', () => {
    const store = new CodexUsageStore()
    store.setLineage(lineage)
    add(store, 'w:p', 'p', [
      ...parent.slice(0, 2),
      // Half a second after the fork was made: a response of the parent's own.
      ev('2026-10-21T09:00:00.500Z', [400, 30], [100, 10])
    ])
    add(store, 'w:f', 'f', [...fork.slice(0, 2), ev('2026-10-21T09:20:00Z', [400, 30], [100, 10])])
    const recs = store.records()
    expect(recs.filter((x) => x.key === 'w:p')).toHaveLength(3)
    expect(recs.filter((x) => x.key === 'w:f').map((x) => x.ts)).toEqual([
      Date.parse('2026-10-21T09:20:00Z')
    ])
  })

  it('alerts for a crossing found by the startup scan, never again for a re-read', () => {
    const reading = (id: string, ago: number, pct: number): CodexLimitReading => ({
      id,
      ts: FIXTURES_NOW - ago,
      key: 'k',
      source: 's',
      limitId: 'codex',
      planType: 'plus',
      windows: [{ pct, minutes: 10080, resetsAt: FIXTURES_NOW + 86_400_000 }]
    })
    let rs = [reading('a', 120_000, 70)]
    const notify = vi.fn()
    const usage = Object.assign(new EventEmitter(), {
      codexRecords: () => [] as UsageRecord[],
      codexLimitReadings: () => rs
    })
    const s = new CodexLimitsService(usage, () => limitsSettings(), notify)
    s.start() // the saved data is loaded; the scan hasn't run
    // The scan re-reads the saved reading (a new parser: a new id) and finds a crossing.
    rs = [reading('a2', 120_000, 70), reading('b', 60_000, 80)]
    usage.emit('changed')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('80%')
  })

  it('announces the saved usage once loaded, before the scan', async () => {
    const { sessions, paths } = await pipeline()
    const again = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
      weekStart: 'monday',
      prices: [],
      codexPrices: DEFAULT_CODEX_PRICES
    }))
    const changed = vi.fn()
    again.on('changed', changed)
    await again.whenLoaded()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(again.codexRecords().length).toBeGreaterThan(0)
    expect(again.status().parsing).toBe(false)
  })
})

describe('review fixes: one-to-one copies, relative resets, alerts mid-scan, plan cutoff', () => {
  const ev = (ts: string, total: number[], last: number[], rl: unknown = null) =>
    tc(
      ts,
      {
        total_token_usage: counts(total[0], 0, total[1]),
        last_token_usage: counts(last[0], 0, last[1])
      },
      rl
    )
  const parsed = (key: string, sid: string, root: string, text: string[]) =>
    analyzeCodexUsage(text.join('\n'), { ...ctx, key, sessionId: sid, lineageRoot: root })
  const put = (store: CodexUsageStore, key: string, sid: string, root: string, text: string[]) => {
    const a = parsed(key, sid, root, text)
    store.set(key, a.records, a.codexLimits ?? [])
  }
  /** Saves the sessions, then loads them as an older parser's rows (other identities). */
  async function asOlder(dir: string, fill: (s: CodexUsageStore) => void) {
    const store = new CodexUsageStore()
    fill(store)
    for (const k of store.sessionKeys()) store.index[k] = 'x'
    await store.flush(dir, dir)
    for (const f of ['codex-records-2026-10.ndjson', 'codex-limits-2026-10.ndjson']) {
      const text = await readFile(join(dir, f), 'utf8').catch(() => '')
      const rows = text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ ...JSON.parse(l), id: `old:${JSON.parse(l).id}` }))
      await writeFile(join(dir, f), rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
    }
    const idxPath = join(dir, 'codex-index.json')
    const idx = JSON.parse(await readFile(idxPath, 'utf8'))
    await writeFile(idxPath, JSON.stringify({ ...idx, version: 2 }))
    const next = new CodexUsageStore()
    await next.load(dir)
    return next
  }

  it('one row an ancestor held stands for one copy only, not every copy with its counts', () => {
    const store = new CodexUsageStore()
    store.setLineage([
      { sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' },
      { sessionId: 'f', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' }
    ])
    // The parent's file holds one response; the fork copied two with the same
    // per-response counts (different running totals), read against another root.
    put(store, 'w:p', 'p', 'p', [ev('2026-10-20T10:00:00Z', [100, 10], [100, 10])])
    put(store, 'w:f', 'f', 'elsewhere', [
      ev('2026-10-21T09:00:00.004Z', [100, 10], [100, 10]),
      ev('2026-10-21T09:00:00.005Z', [200, 20], [100, 10]),
      ev('2026-10-21T09:20:00Z', [250, 25], [50, 5])
    ])
    const recs = store.records()
    expect(recs.filter((x) => x.key === 'w:p')).toHaveLength(1)
    // One copy gives way to the parent's row; the other copy and the own response count.
    expect(recs.filter((x) => x.key === 'w:f')).toHaveLength(2)
  })

  it("a guessed parent needs distinct rows in order: one row can't match two", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-guess-'))
    try {
      const store = await asOlder(dir, (s) => {
        s.setLineage([{ sessionId: 'x', startedAt: '2026-10-20T09:00:00Z' }])
        put(s, 'w:x', 'x', 'x', [ev('2026-10-20T10:00:00Z', [100, 10], [100, 10])])
        // A session with no saved link: two rows with x's counts in its first second.
        put(s, 'w:u', 'u', 'u', [
          ev('2026-10-21T09:00:00.004Z', [100, 10], [100, 10]),
          ev('2026-10-21T09:00:00.005Z', [200, 20], [100, 10])
        ])
      })
      store.setLineage([{ sessionId: 'x', startedAt: '2026-10-20T09:00:00Z' }])
      put(store, 'w:x', 'x', 'x', [ev('2026-10-20T10:00:00Z', [100, 10], [100, 10])])
      const recs = store.records()
      expect(recs.filter((r) => r.key === 'w:u')).toHaveLength(2)
      expect(recs).toHaveLength(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("matches an older parser's copied reading with a relative reset time", async () => {
    // Older Codex: seconds until the reset, so a copy's computed reset time moves with it.
    const rel = (pct: number) => ({
      primary: { used_percent: pct, window_minutes: 10080, resets_in_seconds: 86_400 }
    })
    const links = [
      { sessionId: 'p', startedAt: '2026-10-20T09:59:00Z' },
      { sessionId: 'f', forkedFromId: 'p', startedAt: '2026-10-21T09:00:00Z' }
    ]
    const dir = await mkdtemp(join(tmpdir(), 'csd-codex-rel-'))
    try {
      const store = await asOlder(dir, (s) => {
        s.setLineage(links)
        put(s, 'w:p', 'p', 'p', [ev('2026-10-20T10:00:00Z', [100, 10], [100, 10], rel(4))])
        put(s, 'w:f', 'f', 'p', [
          ev('2026-10-21T09:00:00.004Z', [100, 10], [100, 10], rel(4)),
          ev('2026-10-21T09:20:00Z', [150, 15], [50, 5], rel(6))
        ])
      })
      put(store, 'w:p', 'p', 'p', [ev('2026-10-20T10:00:00Z', [100, 10], [100, 10], rel(4))])
      const fork = store.readings().filter((r) => r.key === 'w:f')
      expect(fork.map((r) => r.windows[0].pct)).toEqual([6])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the newest Codex sessions first and tells the alerts before the scan ends', async () => {
    const { sessions, paths } = await pipeline()
    // A fresh data folder: everything is read again.
    const fresh = await mkdtemp(join(tmpdir(), 'csd-codex-scan-'))
    try {
      const usage = new UsageService(sessions, usagePaths(fresh, paths.archiveDir), () => ({
        weekStart: 'monday',
        prices: [],
        codexPrices: DEFAULT_CODEX_PRICES
      }))
      const seen: string[] = []
      let firstProgress: (string | undefined)[] | undefined
      usage.on('codex-progress', () => {
        seen.push('progress')
        firstProgress ??= [...new Set(usage.codexRecords().map((r) => r.sid))]
      })
      usage.on('changed', () => seen.push('changed'))
      await usage.start()
      await usage.idle()
      expect(seen.indexOf('progress')).toBeGreaterThan(-1)
      expect(seen.indexOf('progress')).toBeLessThan(seen.lastIndexOf('changed'))
      // The most recently active Codex session was read first.
      const newest = [...sessions.list()]
        .filter((s) => s.provider === 'codex')
        .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))[0]
      expect(firstProgress).toEqual([newest.sessionId])
    } finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it("one account: a model limit read before the new plan's main limit is the new plan's", () => {
    const r = (
      id: string,
      ago: number,
      planType: string,
      pct: number,
      limitId = 'codex'
    ): CodexLimitReading => ({
      id,
      ts: FIXTURES_NOW - ago,
      key: 'k',
      source: 's',
      limitId,
      planType,
      windows: [{ pct, minutes: 10080, resetsAt: FIXTURES_NOW + 3_600_000 }]
    })
    const rs = [
      r('m1', 300_000, 'plus', 50),
      r('x1', 290_000, 'plus', 61, 'codex_spark'),
      // The new plan's Spark limit reports before its main limit does.
      r('x2', 120_000, 'prolite', 3, 'codex_spark'),
      r('m2', 60_000, 'prolite', 4)
    ]
    const st = new CodexLimitsService(
      Object.assign(new EventEmitter(), {
        codexRecords: () => [] as UsageRecord[],
        codexLimitReadings: () => rs
      }),
      () => limitsSettings({ accounts: 'one' }),
      () => undefined
    ).state()
    expect(st.extraLimits.map((b) => [b.limitId, b.windows.map((w) => w.gauge.pct)])).toEqual([
      ['codex_spark', [3]],
      ['codex_spark@earlier', [61]]
    ])
  })
})
