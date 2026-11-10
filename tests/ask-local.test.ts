// Ask across sessions (roadmap #7): local questions. Which questions are
// answered on the PC (and which go to Claude), the filters read from them, the
// dates they mean, and what is worked out (with nothing sent).

import { describe, expect, it } from 'vitest'
import { findDateRange } from '../src/shared/ask-sessions/dates'
import {
  computeLocal,
  modelMatches,
  routeQuestion,
  vocabOf,
  type LocalData,
  type LocalSession
} from '../src/shared/ask-sessions/local'
import { DEFAULT_PRICES } from '../src/shared/usage/pricing'
import type { UsageRecord } from '../src/shared/usage/types'
import { ASK_USAGE_KEY } from '../src/shared/summary'

// Tuesday, Nov 10 2026, noon in Chicago (UTC-6 after the clocks went back).
const NOW = Date.parse('2026-11-10T18:00:00Z')
const TZ = 'America/Chicago'
const day = (iso: string): number => Date.parse(`${iso}T12:00:00-06:00`)

describe('dates in a question', () => {
  const r = (q: string, weekStart: 'monday' | 'sunday' = 'monday') => findDateRange(q, NOW, TZ, weekStart)

  it('last week follows the week start', () => {
    expect(r('sessions last week')).toMatchObject({ fromKey: '2026-11-02', toKey: '2026-11-09' })
    expect(r('sessions last week', 'sunday')).toMatchObject({ fromKey: '2026-11-01', toKey: '2026-11-08' })
    expect(r('this week')).toMatchObject({ fromKey: '2026-11-09', toKey: '2026-11-11' })
  })

  it('local midnight in my time zone', () => {
    const w = r('yesterday')!
    expect(w.fromKey).toBe('2026-11-09')
    expect(w.from).toBe(Date.parse('2026-11-09T06:00:00Z'))
    expect(w.to).toBe(Date.parse('2026-11-10T06:00:00Z'))
  })

  it('a month without a year is the latest one that has started', () => {
    expect(r('what did I spend in October')).toMatchObject({ fromKey: '2026-10-01', toKey: '2026-11-01', explicit: true })
    expect(r('in december')).toMatchObject({ fromKey: '2025-12-01', toKey: '2026-01-01' })
    expect(r('in march 2025')).toMatchObject({ fromKey: '2025-03-01', toKey: '2025-04-01' })
    expect(r('last november')).toMatchObject({ fromKey: '2025-11-01' })
    // "the October release" names a month, but not as a date range of the question.
    expect(r('what did I decide about the October release')?.explicit).toBe(false)
  })

  it('since, between, the last N days, on a weekday', () => {
    expect(r('since Oct 3')).toMatchObject({ fromKey: '2026-10-03', toKey: '2026-11-11' })
    expect(r('between Oct 1 and Oct 15')).toMatchObject({ fromKey: '2026-10-01', toKey: '2026-10-16' })
    expect(r('from 2026-09-01 to 2026-09-30')).toMatchObject({ fromKey: '2026-09-01', toKey: '2026-10-01' })
    expect(r('in the past 30 days')).toMatchObject({ fromKey: '2026-10-12', toKey: '2026-11-11' })
    expect(r('over the last two weeks')).toMatchObject({ fromKey: '2026-10-28' })
    expect(r('on Monday')).toMatchObject({ fromKey: '2026-11-09', toKey: '2026-11-10' })
    expect(r('last tuesday')).toMatchObject({ fromKey: '2026-11-03' })
    expect(r('may I ask')).toBeUndefined()
  })
})

function session(p: Partial<LocalSession> & { key: string }): LocalSession {
  return {
    title: p.key,
    provider: 'claude',
    source: 'terminal-windows',
    env: 'windows',
    project: 'acme-web',
    startedAt: day('2026-11-03'),
    lastActivityAt: day('2026-11-04'),
    models: ['claude-opus-5-5'],
    subagent: false,
    hidden: false,
    named: false,
    pinned: false,
    tags: [],
    availability: 'live',
    messageCount: 10,
    ...p
  }
}

function rec(p: Partial<UsageRecord> & { key: string; ts: number; model: string }): UsageRecord {
  return {
    id: `${p.key}:${p.ts}:${p.model}`,
    project: 'acme-web',
    env: 'windows',
    input: 1000,
    output: 1000,
    cacheRead: 0,
    cacheWrite: 0,
    ...p
  }
}

const SESSIONS: LocalSession[] = [
  session({ key: 'w:a', title: 'Opus last week' }),
  session({ key: 'w:b', title: 'Sonnet last week', models: ['claude-sonnet-5-5'] }),
  session({ key: 'w:c', title: 'Opus in October', startedAt: day('2026-10-10'), lastActivityAt: day('2026-10-12') }),
  session({ key: 'w:hidden', title: 'Hidden opus', hidden: true }),
  session({ key: 'x:sub', title: 'Codex subagent', provider: 'codex', subagent: true, models: ['gpt-5.5-codex'] }),
  session({ key: 'x:cx', title: 'Codex orders', provider: 'codex', project: 'orders-api', env: 'wsl', distro: 'Ubuntu', models: ['gpt-5.5-codex'], tags: ['backend'] }),
  session({ key: 'ask', title: 'Ask Claude: x', source: 'ask-claude' })
]

const RECORDS: UsageRecord[] = [
  rec({ key: 'w:a', ts: day('2026-11-03'), model: 'claude-opus-5-5' }),
  rec({ key: 'w:b', ts: day('2026-11-04'), model: 'claude-sonnet-5-5' }),
  rec({ key: 'w:c', ts: day('2026-10-11'), model: 'claude-opus-5-5' }),
  rec({ key: 'w:hidden', ts: day('2026-11-03'), model: 'claude-opus-5-5' }),
  rec({ key: 'x:cx', ts: day('2026-10-20'), model: 'gpt-5.5-codex', provider: 'codex', output: 2_000_000 }),
  rec({ key: 'x:cx', ts: day('2026-11-02'), model: 'gpt-5.5-codex', provider: 'codex', output: 500_000 }),
  rec({ key: ASK_USAGE_KEY, ts: day('2026-11-05'), model: 'claude-sonnet-5-5', project: 'Ask (dashboard)' })
]

function data(over: Partial<LocalData> = {}): LocalData {
  return {
    now: NOW,
    timeZone: TZ,
    weekStart: 'monday',
    sessions: SESSIONS,
    records: RECORDS,
    prices: DEFAULT_PRICES,
    codexPrices: [{ model: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 }],
    limitHits: [
      { id: 'h1', ts: day('2026-11-03'), key: 'w:a', text: 'limit', kind: 'five_hour' },
      { id: 'h2', ts: day('2026-10-03'), key: 'w:c', text: 'limit', kind: 'weekly' }
    ],
    codexLimitHits: [],
    limitsNow: { claude: { fiveHour: { pct: 42, resetsAt: NOW + 3600_000 } } },
    plans: { claude: { current: 'Max 5x', history: [{ from: '2026-09-01', plan: 'Max 5x' }] }, codex: { current: 'Plus', changes: [] } },
    git: {
      enabled: true,
      touched: (p) => new Set(p.endsWith('bridge.ts') ? ['w:a', 'x:cx'] : []),
      commitSessions: (sha) => new Set(sha.startsWith('abc1234') ? ['w:b'] : []),
      commits: () => [
        { key: 'w:a', sha: 'abc1234def', subject: 'Fix bridge', at: day('2026-11-03'), files: ['src/main/bridge.ts'] },
        { key: 'w:c', sha: 'fff0000111', subject: 'Old work', at: day('2026-10-11'), files: ['README.md'] }
      ],
      prs: () => [{ key: 'w:a', number: 14, url: 'https://github.com/o/r/pull/14', title: 'Bridge', state: 'merged' }],
      files: () => [{ key: 'w:a', path: 'src/main/bridge.ts', at: day('2026-11-03') }]
    },
    ...over
  }
}

const vocab = vocabOf({ sessions: SESSIONS, records: RECORDS })
const route = (q: string) => routeQuestion(q, vocab, NOW, TZ, 'monday')

describe('which questions are answered on this PC', () => {
  it.each([
    'How many sessions used Opus last week?',
    'which sessions touched bridge.ts',
    'What did I spend on Codex in October?',
    'how often did I hit my limit this month',
    'what plan am I on',
    'which models did I use in October',
    'When did I first use Opus 5.5?',
    'how many commits did I make last week',
    'list sessions tagged backend',
    'how many tokens on codex last month by model',
    'which sessions are linked to PR #14',
    'how many codex sessions in WSL',
    'what are my current limits'
  ])('local: %s', (q) => {
    expect(route(q).mode).toBe('local')
  })

  it.each([
    'Where did I fix the WSL path bug?',
    'What did I decide about pricing?',
    'which sessions mention the redirect loop',
    'how many tokens does the bridge script use',
    'what was the plan for the migration'
  ])('content: %s', (q) => {
    expect(route(q).mode).toBe('content')
  })

  it('reads the filters', () => {
    const r = route('How many sessions used Opus 5.5 last week in acme-web?')
    expect(r.mode).toBe('local')
    if (r.mode !== 'local') return
    expect(r.query).toMatchObject({ intent: 'sessions', count: true, models: ['opus-5-5'], projects: ['acme-web'] })
    expect(r.query.range).toMatchObject({ fromKey: '2026-11-02' })
    expect(r.chips).toContain('Project: acme-web')
    const f = route('which sessions touched src/main/bridge.ts or commit abc1234ff')
    if (f.mode === 'local') {
      expect(f.query.files).toEqual(['src/main/bridge.ts'])
      expect(f.query.commits).toEqual(['abc1234ff'])
    }
    const pr = route('which sessions are linked to PR #14')
    expect(pr.mode === 'local' && pr.query.pr).toBe(14)
  })

  it('a content question keeps only filters that cannot be what it is about', () => {
    const a = route('What did I decide about pricing last month in Codex?')
    expect(a.mode).toBe('content')
    if (a.mode !== 'content') return
    expect(a.scope).toMatchObject({ providers: ['codex'] })
    expect(a.scope.from).toBe(Date.parse('2026-10-01T05:00:00Z'))
    // The scope's words aren't searched for.
    expect(a.searchText).toBe('what did i decide about pricing ?')
    // A bare "WSL" in a content question is a word to search, not a filter.
    const b = route('Where did I fix the WSL path bug?')
    expect(b.mode === 'content' && b.scope).toEqual({})
    expect(b.mode === 'content' && b.searchText).toContain('wsl')
    // "the October release" is a topic, not a date.
    const c = route('what did I decide about the October release')
    expect(c.mode === 'content' && c.scope.from).toBeUndefined()
  })

  it('model names match ids of either naming', () => {
    expect(modelMatches('claude-opus-5-5-20261001', 'opus-5-5')).toBe(true)
    expect(modelMatches('claude-3-5-sonnet', 'sonnet-3-5')).toBe(true)
    expect(modelMatches('gpt-5.5-codex', 'gpt-5.5')).toBe(true)
    expect(modelMatches('claude-sonnet-5-5', 'opus')).toBe(false)
  })
})

function answer(q: string, d = data()) {
  const r = routeQuestion(q, vocabOf(d), d.now, d.timeZone, d.weekStart)
  if (r.mode !== 'local') throw new Error(`not local: ${q}`)
  return computeLocal(r.query, d)
}

describe('local answers', () => {
  it('sessions that used a model in a week: by their responses, without hidden ones or subagents', () => {
    const a = answer('How many sessions used Opus last week?')
    expect(a.headline).toContain('**1 session**')
    expect(a.sessions?.map((s) => s.key)).toEqual(['w:a'])
    expect(a.interpretation).toContain('Nov 2')
    expect(a.steps.join(' ')).toMatch(/1 hidden session not counted/)
    expect(a.steps.join(' ')).toMatch(/subagent/)
    // The dashboard's own runs never count.
    expect(answer('how many sessions last week').sessions?.some((s) => s.key === 'ask')).toBe(false)
  })

  it('sessions that touched a file (git links)', () => {
    const a = answer('which sessions touched bridge.ts')
    expect(a.sessions?.map((s) => s.key).sort()).toEqual(['w:a', 'x:cx'])
    expect(a.steps.join(' ')).toContain('touched: search')
  })

  it('spend on Codex in a month, by model, at API prices', () => {
    const a = answer('What did I spend on Codex in October?')
    // 2M output tokens at $10 per million (plus 1k input at $2).
    expect(a.headline).toContain('$20.00')
    expect(a.table?.rows.at(-1)?.[0]).toBe('Total')
    expect(a.steps.join(' ')).toMatch(/ChatGPT plan isn't billed per token/)
  })

  it("the app's own Ask runs show as their own project", () => {
    const a = answer('how many tokens last week by project')
    expect(a.table?.rows.some((r) => r[0] === 'Ask (dashboard)')).toBe(true)
  })

  it('limit hits, current limits and plans', () => {
    expect(answer('how often did I hit my limit this month').headline).toContain('**1 time**')
    expect(answer('how many times did I hit the weekly limit').headline).toContain('**1 time**')
    expect(answer('what are my current limits').headline).toContain('42%')
    const p = answer('what plan am I on')
    expect(p.headline).toContain('Max 5x')
    expect(p.headline).toContain('Plus')
  })

  it('models, and when one was first used', () => {
    expect(answer('which models did I use in October').table?.rows.map((r) => r[0])).toEqual(
      expect.arrayContaining(['Opus 5.5'])
    )
    const f = answer('When did I first use Opus 5.5?')
    expect(f.headline).toContain('Oct 11, 2026')
    expect(f.sessions?.[0].key).toBe('w:c')
  })

  it('commits and PRs from git links, and an answer when git links are off', () => {
    const c = answer('how many commits did I make last week')
    expect(c.commits?.map((x) => x.sha)).toEqual(['abc1234def'])
    expect(answer('which pull requests did I open').table?.rows[0][0]).toBe('#14')
    const off = answer('how many commits last week', data({ git: { ...data().git, enabled: false } }))
    expect(off.headline).toContain('Git links are off')
  })

  it('every answer says how it was worked out', () => {
    for (const q of ['How many sessions used Opus last week?', 'What did I spend on Codex in October?', 'what plan am I on'])
      expect(answer(q).steps.length).toBeGreaterThan(0)
  })
})
