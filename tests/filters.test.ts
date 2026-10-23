import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@shared/types'
import {
  clearedFilters,
  EMPTY_FILTERS,
  facets,
  inDateRange,
  presetRange,
  sortSessions,
  visibleSessions,
  type Filters
} from '@/lib/filters'
import { formatDateTime, formatRelative } from '@shared/format'

function s(partial: Partial<SessionSummary> & { key: string }): SessionSummary {
  return {
    sessionId: partial.key,
    sourceId: 'windows',
    sourceLabel: 'Windows',
    env: 'windows',
    filePath: '',
    originalPath: '',
    availability: 'live',
    projectDir: 'p',
    projectName: 'p',
    messageCount: 1,
    userMessageCount: 1,
    assistantMessageCount: 0,
    toolCallCount: 0,
    malformedLines: 0,
    sizeBytes: 1,
    models: [],
    meta: {},
    title: partial.key,
    titleSource: 'fallback',
    source: 'terminal-windows',
    sourceReason: 'entrypoint "cli"',
    ...partial
  }
}

const list = [
  s({
    key: 'a',
    title: 'beta',
    startedAt: '2026-10-01T10:00:00Z',
    lastActivityAt: '2026-10-20T10:00:00Z',
    meta: { tags: ['bug'] }
  }),
  s({
    key: 'b',
    title: 'Alpha',
    startedAt: '2026-10-05T10:00:00Z',
    lastActivityAt: '2026-10-06T10:00:00Z',
    env: 'wsl',
    distro: 'Ubuntu',
    cwd: '/home/me/api',
    projectName: 'api'
  }),
  s({
    key: 'c',
    title: 'gamma',
    startedAt: '2026-09-01T10:00:00Z',
    lastActivityAt: '2026-09-02T10:00:00Z',
    meta: { hidden: true }
  }),
  s({
    key: 'd',
    title: 'delta',
    availability: 'archived-only',
    lastActivityAt: '2026-10-21T10:00:00Z'
  })
]

describe('sorting', () => {
  it('sorts by last activity, start time and name', () => {
    expect(sortSessions(list, 'activity').map((x) => x.key)).toEqual(['d', 'a', 'b', 'c'])
    expect(sortSessions(list, 'started').map((x) => x.key)).toEqual(['b', 'a', 'c', 'd'])
    expect(sortSessions(list, 'name').map((x) => x.key)).toEqual(['b', 'a', 'd', 'c'])
  })
  it('sorts by relevance when there are search hits', () => {
    const hits = new Map([
      ['b', { key: 'b', score: 1, fields: [] }],
      ['c', { key: 'c', score: 5, fields: [] }]
    ])
    expect(
      sortSessions(list, 'relevance', hits)
        .map((x) => x.key)
        .slice(0, 2)
    ).toEqual(['c', 'b'])
  })
})

describe('filtering', () => {
  it('hides hidden sessions by default and shows them on request', () => {
    expect(visibleSessions(list, EMPTY_FILTERS, 'activity', null).map((x) => x.key)).toEqual([
      'd',
      'a',
      'b'
    ])
    expect(
      visibleSessions(list, { ...EMPTY_FILTERS, visibility: 'hidden' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['c'])
    expect(
      visibleSessions(list, { ...EMPTY_FILTERS, visibility: 'archived' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['d'])
  })
  it('filters by environment, project, tag and search hits', () => {
    expect(
      visibleSessions(list, { ...EMPTY_FILTERS, env: 'wsl:Ubuntu' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['b'])
    expect(
      visibleSessions(list, { ...EMPTY_FILTERS, project: '/home/me/api' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['b'])
    expect(
      visibleSessions(list, { ...EMPTY_FILTERS, tag: 'bug' }, 'activity', null).map((x) => x.key)
    ).toEqual(['a'])
    const hits = new Map([['a', { key: 'a', score: 1, fields: ['text'] }]])
    expect(visibleSessions(list, EMPTY_FILTERS, 'relevance', hits).map((x) => x.key)).toEqual(['a'])
  })
  it('filters by date range (inclusive, local days)', () => {
    const range = { from: '2026-10-06', to: '2026-10-20' }
    expect(inDateRange('2026-10-06T12:00:00', range)).toBe(true)
    expect(inDateRange('2026-10-20T23:59:00', range)).toBe(true)
    expect(inDateRange('2026-10-21T00:00:01', range)).toBe(false)
    expect(presetRange('7d', new Date(2026, 9, 22))).toMatchObject({
      from: '2026-10-16',
      to: '2026-10-22'
    })
  })
  it('counts facets ignoring their own filter', () => {
    const f = facets(list, { ...EMPTY_FILTERS, env: 'windows' })
    expect(f.env.map((e) => [e.key, e.count])).toEqual([
      ['windows', 2],
      ['wsl:Ubuntu', 1]
    ])
    expect(f.views).toEqual({ visible: 3, hidden: 1, archived: 1 })
  })
})

describe('source filter', () => {
  const withAsk = [
    s({ key: 'v', source: 'vscode' }),
    s({ key: 't', source: 'terminal-windows' }),
    s({ key: 'ask', source: 'ask-claude' })
  ]
  it('hides Ask Claude runs unless that source is picked, and filters by source', () => {
    expect(visibleSessions(withAsk, EMPTY_FILTERS, 'activity', null).map((x) => x.key)).toEqual([
      'v',
      't'
    ])
    expect(
      visibleSessions(withAsk, { ...EMPTY_FILTERS, source: 'ask-claude' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['ask'])
    expect(
      visibleSessions(withAsk, { ...EMPTY_FILTERS, source: 'vscode' }, 'activity', null).map(
        (x) => x.key
      )
    ).toEqual(['v'])
  })
  it('counts sources, with the dashboard’s own runs last and out of the view counts', () => {
    const f = facets(withAsk, EMPTY_FILTERS)
    expect(f.source.map((x) => [x.label, x.count])).toEqual([
      ['Terminal (Windows)', 1],
      ['VS Code', 1],
      ['Ask Claude (dashboard)', 1]
    ])
    expect(f.views.visible).toBe(2)
  })
})

describe('formatting', () => {
  it('formats local date/time like "Oct 22, 2026 2:47 PM"', () => {
    expect(formatDateTime(new Date(2026, 9, 22, 14, 47).toISOString())).toBe('Oct 22, 2026 2:47 PM')
    expect(formatDateTime(undefined)).toBe('—')
  })
  it('formats relative times', () => {
    const now = Date.parse('2026-10-22T12:00:00Z')
    expect(formatRelative('2026-10-22T11:55:00Z', now)).toBe('5m')
    expect(formatRelative('2026-10-22T09:00:00Z', now)).toBe('3h')
    expect(formatRelative('2026-10-19T12:00:00Z', now)).toBe('3d')
  })
})

describe('clearedFilters', () => {
  it('clears every filter, including the source, and keeps the view', () => {
    const f: Filters = {
      visibility: 'hidden',
      env: 'windows',
      project: 'c:\\code\\app',
      tag: 'bug',
      date: { preset: '7d', from: '2026-10-16', to: '2026-10-22' },
      source: 'terminal-windows'
    }
    expect(clearedFilters(f)).toEqual({ ...EMPTY_FILTERS, visibility: 'hidden' })
    expect(clearedFilters(f).source).toBeNull()
  })
})
