import { describe, expect, it } from 'vitest'
import {
  computeLineage,
  familyTree,
  sharedPrefix,
  type LineageInput,
  type MessageStart
} from '@shared/lineage'

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString()
const starts = (...ids: (string | [string, number])[]): MessageStart[] =>
  ids.map((x, i) => (Array.isArray(x) ? { uuid: x[0], t: t(x[1]) } : { uuid: x, t: t(i) }))

const s = (key: string, extra: Partial<LineageInput> = {}): LineageInput => ({
  key: `windows:${key}`,
  sessionId: key,
  sourceId: 'windows',
  firstUuid: 'u1',
  startedAt: t(0),
  ...extra
})

describe('lineage: explicit links', () => {
  it('uses the parent recorded by the app', () => {
    const out = computeLineage([
      s('P', { starts: starts('u1', 'a1', 'u2', 'a2') }),
      s('B', {
        recorded: { parentSessionId: 'P', parentKey: 'windows:P', atMessageId: 'a1', via: 'app' },
        starts: starts('u1', 'a1')
      })
    ])
    expect(out.get('windows:B')).toMatchObject({
      parentKey: 'windows:P',
      parentSessionId: 'P',
      atMessageId: 'a1',
      shared: 2,
      via: 'app'
    })
    expect(out.has('windows:P')).toBe(false)
  })

  it("reads Claude Code's forkedFrom marker", () => {
    const out = computeLineage([
      s('P'),
      s('B', { forkedFrom: { sessionId: 'P', messageUuid: 'r3', messageId: 'a4' } })
    ])
    expect(out.get('windows:B')).toMatchObject({
      parentKey: 'windows:P',
      atMessageId: 'a4',
      via: 'claude-branch'
    })
  })

  it('links older-style copies whose entries carry the original session id', () => {
    const P = '0b5d6a5e-0000-4000-8000-000000000001'
    const out = computeLineage([s(P), s('C', { copiedFrom: P, firstUuid: undefined })])
    expect(out.get('windows:C')).toMatchObject({ parentKey: `windows:${P}`, via: 'copy' })
  })

  it('keeps the link when the parent is gone, without a parent key', () => {
    const out = computeLineage([s('B', { forkedFrom: { sessionId: 'long-gone' } })])
    expect(out.get('windows:B')).toMatchObject({
      parentSessionId: 'long-gone',
      via: 'claude-branch'
    })
    expect(out.get('windows:B')?.parentKey).toBeUndefined()
  })

  it('prefers a parent in the same source', () => {
    const out = computeLineage([
      s('P', { key: 'wsl-Ubuntu-beau:P', sourceId: 'wsl-Ubuntu-beau' }),
      s('P'),
      s('B', { forkedFrom: { sessionId: 'P' } })
    ])
    expect(out.get('windows:B')?.parentKey).toBe('windows:P')
  })
})

describe('lineage: forks detected from shared message uuids', () => {
  it('a fork made at the end of the original', () => {
    const out = computeLineage([
      s('P', { starts: starts('u1', 'a1', 'u2', 'a2') }),
      s('F', { starts: starts('u1', 'a1', 'u2', 'a2', ['u9', 30], ['a9', 31]) })
    ])
    expect(out.get('windows:F')).toMatchObject({
      parentKey: 'windows:P',
      atMessageId: 'a2',
      shared: 4,
      via: 'shared-history'
    })
    expect(out.has('windows:P')).toBe(false)
  })

  it('both went on: the file created first is the original', () => {
    const P = s('P', { starts: starts('u1', 'a1', ['p2', 50]), bornAt: 1_000 })
    const F = s('F', { starts: starts('u1', 'a1', ['f2', 20]), bornAt: 900_000 })
    const out = computeLineage([P, F])
    expect(out.get('windows:F')?.parentKey).toBe('windows:P')
    expect(out.has('windows:P')).toBe(false)
  })

  it('nests a fork of a fork under the closest relative', () => {
    const out = computeLineage([
      s('P', { starts: starts('u1', 'a1') }),
      s('F1', { starts: starts('u1', 'a1', ['u2', 10], ['a2', 11]) }),
      s('F2', { starts: starts('u1', 'a1', ['u2', 10], ['a2', 11], ['u3', 20]) })
    ])
    expect(out.get('windows:F1')?.parentKey).toBe('windows:P')
    expect(out.get('windows:F2')?.parentKey).toBe('windows:F1')
  })

  it('ignores sessions that only share a first prompt id with nothing else in common', () => {
    const out = computeLineage([
      s('A', { starts: starts('x1', 'x2') }),
      s('B', { starts: starts('y1', 'y2') })
    ])
    expect(out.size).toBe(0)
  })

  it('aligns on the first prompt even if one copy starts with a command', () => {
    const a = s('A', { starts: starts('cmd', 'u1', 'a1') })
    const b = s('B', { starts: starts('u1', 'a1', ['u2', 30]) })
    expect(sharedPrefix(a, b)).toBe(2)
  })

  it('never produces a cycle', () => {
    const out = computeLineage([
      s('A', { recorded: { parentSessionId: 'B', via: 'app' } }),
      s('B', { recorded: { parentSessionId: 'A', via: 'app' } })
    ])
    const parents = [...out.values()].filter((l) => l.parentKey)
    expect(parents.length).toBeLessThan(2)
  })
})

describe('familyTree', () => {
  it('walks up to the root and lists every descendant with its depth', () => {
    const parent: Record<string, string | undefined> = { b: 'a', c: 'a', d: 'b' }
    const children = (k: string) => Object.keys(parent).filter((x) => parent[x] === k)
    expect(familyTree('d', (k) => parent[k], children)).toEqual([
      { key: 'a', depth: 0 },
      { key: 'b', depth: 1 },
      { key: 'd', depth: 2 },
      { key: 'c', depth: 1 }
    ])
  })
})
