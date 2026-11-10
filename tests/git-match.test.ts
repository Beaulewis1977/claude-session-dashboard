// Git links: matching commits to sessions, and the confidence of each link.

import { describe, expect, it } from 'vitest'
import { matchRepo, normPath, relativeTo, repoFile, type MatchSession } from '@shared/git/match'
import { badgeText, gitBadge, sessionPrs } from '@shared/git/prs'
import type { CommitInfo, CommitLink, SessionGitSignals } from '@shared/git/types'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 21, 13, 0)
const at = (min: number): number => T0 + min * MIN
const sha = (n: number): string => n.toString(16).padStart(40, '0')

function signals(p: Partial<SessionGitSignals> = {}): SessionGitSignals {
  return {
    branches: [],
    files: [],
    commits: [],
    prs: [],
    spans: [[at(0), at(60)]],
    sessionUrls: [],
    ...p
  }
}

function session(
  key: string,
  p: Omit<Partial<MatchSession>, 'signals'> & { signals?: Partial<SessionGitSignals> } = {}
): MatchSession {
  return {
    key,
    sessionId: key,
    provider: 'claude',
    root: 'c:/code/acme',
    cwdRel: '',
    unlinked: new Set(),
    ...p,
    signals: signals(p.signals)
  }
}

function commit(n: number, p: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: sha(n),
    parents: [sha(n - 1)],
    authorEmail: 'beau@example.com',
    committerEmail: 'beau@example.com',
    at: at(30),
    ct: at(30),
    subject: `Commit ${n}`,
    trailers: [],
    files: [{ path: 'src/a.ts', add: 1, del: 0 }],
    branches: ['fix/login'],
    ...p
  }
}

const repo = (commits: CommitInfo[], userEmail?: string) => ({
  caseInsensitive: true,
  userEmail,
  commits
})
const links = (r: Map<string, CommitLink[]>, key: string) =>
  r.get(key)!.map((l) => [l.sha, l.level])

describe('paths', () => {
  it('normalises Windows, WSL drive and relative paths', () => {
    expect(normPath('C:\\Users\\beau\\code\\x\\')).toBe('c:/Users/beau/code/x')
    expect(normPath('/mnt/c/Users/beau/./code/../x')).toBe('c:/Users/beau/x')
    expect(normPath('/home/beau/x')).toBe('/home/beau/x')
    expect(normPath('src/../lib/a.ts')).toBe('lib/a.ts')
    expect(normPath('\\\\wsl.localhost\\Ubuntu\\home\\x')).toBe('//wsl.localhost/Ubuntu/home/x')
  })

  it('makes repo-relative files from absolute or relative paths', () => {
    const win = { root: 'c:/code/acme', caseInsensitive: true }
    expect(repoFile('C:\\Code\\ACME\\src\\A.ts', win, '')).toBe('src/a.ts')
    expect(repoFile('/mnt/c/code/acme/src/b.ts', win, '')).toBe('src/b.ts')
    expect(repoFile('a.ts', win, 'src')).toBe('src/a.ts')
    expect(repoFile('../outside.ts', win, '')).toBeUndefined()
    expect(repoFile('D:\\other\\x.ts', win, '')).toBeUndefined()
    const linux = { root: '/home/beau/api', caseInsensitive: false }
    expect(repoFile('/home/beau/api/internal/X.go', linux, '')).toBe('internal/X.go')
    expect(relativeTo('/home/beau/api', '/home/beau/api', false)).toBe('')
  })
})

describe('confidence', () => {
  it('exact: the session printed the SHA during its git commit call', () => {
    const c = commit(1, { ct: at(10) + 30_000 })
    const s = session('a', {
      signals: {
        commits: [{ sha: c.sha.slice(0, 7), kind: 'commit-line', from: at(10), to: at(10) + 5000 }]
      }
    })
    const r = matchRepo(repo([c]), [s])
    expect(r.get('a')).toEqual([
      { sha: c.sha, level: 'exact', reasons: [{ kind: 'seen', how: 'commit-line' }] }
    ])
  })

  it('a chained SHA counts only if the commit was made during that call (±1 minute)', () => {
    const old = commit(1, { ct: at(-500), at: at(-500), branches: [] })
    const fresh = commit(2, { ct: at(20), branches: [] })
    const s = session('a', {
      signals: {
        commits: [
          { sha: old.sha.slice(0, 7), kind: 'chained', from: at(20), to: at(20) },
          { sha: fresh.sha.slice(0, 7), kind: 'chained', from: at(20), to: at(20) }
        ],
        files: []
      }
    })
    const r = matchRepo(repo([old, fresh]), [s])
    expect(links(r, 'a')).toEqual([[fresh.sha, 'exact']])
  })

  it('exact: a Claude-Session trailer naming one of its links', () => {
    const url = 'https://claude.ai/code/session_01AbCdEf9876'
    const c = commit(1, { at: at(500), ct: at(500), trailers: [`Claude-Session: ${url}`] })
    const r = matchRepo(repo([c]), [
      session('a', { signals: { sessionUrls: [url] } }),
      session('b')
    ])
    expect(links(r, 'a')).toEqual([[c.sha, 'exact']])
    expect(r.get('b')).toEqual([])
  })

  it('high: a rebased copy (same subject and author time, new SHA)', () => {
    const c = commit(9, { subject: 'Tidy', at: at(10), ct: at(300) })
    const s = session('a', {
      signals: {
        commits: [
          { sha: 'abcdef1', kind: 'commit-line', subject: 'Tidy', from: at(10), to: at(10) }
        ]
      }
    })
    expect(matchRepo(repo([c]), [s]).get('a')).toEqual([
      { sha: c.sha, level: 'high', reasons: [{ kind: 'rewritten' }] }
    ])
  })

  it('a rewritten copy still needs the user, no merge, the right agent and not the starting HEAD', () => {
    const seen = (c: CommitInfo) => ({
      commits: [
        {
          sha: 'abcdef1',
          kind: 'commit-line' as const,
          subject: c.subject,
          from: at(10),
          to: at(10)
        }
      ]
    })
    const base = { subject: 'Tidy', at: at(10), ct: at(300) }
    const other = commit(9, { ...base, authorEmail: 'x@y', committerEmail: 'x@y' })
    expect(
      matchRepo(repo([other], 'beau@example.com'), [session('a', { signals: seen(other) })]).get(
        'a'
      )
    ).toEqual([])
    const merge = commit(9, { ...base, parents: [sha(1), sha(2)] })
    expect(matchRepo(repo([merge]), [session('a', { signals: seen(merge) })]).get('a')).toEqual([])
    const codex = commit(9, { ...base, trailers: ['Co-authored-by: Codex <noreply@openai.com>'] })
    expect(matchRepo(repo([codex]), [session('a', { signals: seen(codex) })]).get('a')).toEqual([])
    const head = commit(9, base)
    expect(
      matchRepo(repo([head]), [
        session('a', { signals: { ...seen(head), head: head.sha.slice(0, 10) } })
      ]).get('a')
    ).toEqual([])
    // The same copy, by the repo's user: High.
    expect(
      links(
        matchRepo(repo([head], 'beau@example.com'), [session('a', { signals: seen(head) })]),
        'a'
      )
    ).toEqual([[head.sha, 'high']])
  })

  it('high: during a stretch, on its branch and touching files it edited', () => {
    const r = matchRepo(repo([commit(1)]), [
      session('a', { signals: { branches: ['fix/login'], files: ['C:\\code\\acme\\src\\a.ts'] } })
    ])
    expect(r.get('a')![0]).toMatchObject({ level: 'high' })
    expect(r.get('a')![0].reasons.map((x) => x.kind)).toEqual(['branch', 'files', 'time'])
  })

  it('medium: branch or files; low: time only; nothing outside its stretches', () => {
    const c = commit(1)
    expect(
      links(matchRepo(repo([c]), [session('a', { signals: { branches: ['fix/login'] } })]), 'a')
    ).toEqual([[c.sha, 'medium']])
    expect(
      links(matchRepo(repo([c]), [session('a', { signals: { files: ['src/a.ts'] } })]), 'a')
    ).toEqual([[c.sha, 'medium']])
    expect(links(matchRepo(repo([c]), [session('a')]), 'a')).toEqual([[c.sha, 'low']])
    const late = commit(2, { at: at(70) })
    expect(links(matchRepo(repo([late]), [session('a')]), 'a')).toEqual([])
    // Within the 5-minute slack after a stretch.
    const slack = commit(3, { at: at(64) })
    expect(links(matchRepo(repo([slack]), [session('a')]), 'a')).toEqual([[slack.sha, 'low']])
  })

  it("needs the repo's user, no merge commit, the right agent and not the starting HEAD", () => {
    const c = commit(1, { authorEmail: 'someone@else.com', committerEmail: 'someone@else.com' })
    expect(matchRepo(repo([c], 'beau@example.com'), [session('a')]).get('a')).toEqual([])
    expect(matchRepo(repo([c], 'BEAU@example.com'), [session('a')]).get('a')).toEqual([])
    const mine = commit(2)
    expect(links(matchRepo(repo([mine], 'BEAU@example.com'), [session('a')]), 'a')).toEqual([
      [mine.sha, 'low']
    ])
    const merge = commit(3, { parents: [sha(1), sha(2)] })
    expect(
      matchRepo(repo([merge]), [session('a', { signals: { branches: ['fix/login'] } })]).get('a')
    ).toEqual([])
    const byCodex = commit(4, { trailers: ['Co-authored-by: Codex <noreply@openai.com>'] })
    const r = matchRepo(repo([byCodex]), [
      session('claude'),
      session('codex', { provider: 'codex' })
    ])
    expect(r.get('claude')).toEqual([])
    expect(links(r, 'codex')).toEqual([[byCodex.sha, 'low']])
    const head = commit(5)
    expect(
      matchRepo(repo([head]), [session('a', { signals: { head: head.sha.slice(0, 12) } })]).get('a')
    ).toEqual([])
  })
})

describe('sessions sharing a commit', () => {
  it('the best level keeps it; a tie is marked and goes one level down', () => {
    const c = commit(1)
    const r = matchRepo(repo([c]), [
      session('a', { signals: { branches: ['fix/login'], files: ['src/a.ts'] } }),
      session('b', { signals: { branches: ['fix/login'] } }),
      session('c')
    ])
    expect(links(r, 'a')).toEqual([[c.sha, 'high']])
    expect(r.get('b')).toEqual([])
    expect(r.get('c')).toEqual([])
    const tie = matchRepo(repo([c]), [
      session('a', { signals: { branches: ['fix/login'] } }),
      session('b', { signals: { branches: ['fix/login'] } })
    ])
    expect(links(tie, 'a')).toEqual([[c.sha, 'low']])
    expect(tie.get('b')![0].reasons).toContainEqual({ kind: 'shared', others: 1 })
  })

  it('an exact match wins; two "seen" claims go to the earlier call (the original)', () => {
    const c = commit(1, { ct: at(10) })
    const seen = (from: number) => ({
      commits: [{ sha: c.sha.slice(0, 7), kind: 'commit-line' as const, from, to: at(10) }]
    })
    const r = matchRepo(repo([c]), [
      session('fork', { signals: seen(at(10)) }),
      session('orig', { signals: seen(at(9.5)) }),
      session('other', { signals: { branches: ['fix/login'], files: ['src/a.ts'] } })
    ])
    expect(links(r, 'orig')).toEqual([[c.sha, 'exact']])
    expect(r.get('fork')).toEqual([])
    expect(r.get('other')).toEqual([])
  })

  it('a subagent gives way to its parent thread; its exact commits also show on the parent', () => {
    const shared = commit(1)
    const own = commit(2, { ct: at(40), at: at(40) })
    const r = matchRepo(repo([shared, own]), [
      session('parent', { provider: 'codex', signals: { branches: ['fix/login'] } }),
      session('sub', {
        provider: 'codex',
        parentId: 'parent',
        title: 'worker',
        signals: {
          branches: ['fix/login'],
          commits: [{ sha: own.sha.slice(0, 8), kind: 'commit-line', from: at(40), to: at(40) }]
        }
      })
    ])
    expect(links(r, 'sub')).toEqual([[own.sha, 'exact']])
    expect(links(r, 'parent')).toEqual([
      [shared.sha, 'medium'],
      [own.sha, 'exact']
    ])
    expect(r.get('parent')![1].reasons).toContainEqual({ kind: 'subagent', title: 'worker' })
  })

  it("a fork's copy of its parent's history doesn't claim the parent's commits", () => {
    const before = commit(1, { at: at(10), ct: at(10) })
    const after = commit(2, { at: at(40), ct: at(40) })
    const seen = {
      commits: [
        { sha: before.sha.slice(0, 7), kind: 'commit-line' as const, from: at(10), to: at(10) }
      ]
    }
    const r = matchRepo(repo([before, after]), [
      session('parent', { signals: { ...seen, branches: ['fix/login'] } }),
      // Split at minute 30: its copy shows the same commit line and the same branch.
      session('fork', {
        forkOf: 'parent',
        forkAt: at(30),
        signals: { ...seen, branches: ['fix/login'], files: ['src/a.ts'] }
      })
    ])
    expect(links(r, 'parent')).toEqual([[before.sha, 'exact']])
    expect(links(r, 'fork')).toEqual([[after.sha, 'high']])
    // Split point unknown: it gives way to its parent at the same level.
    const tie = matchRepo(repo([after]), [
      session('parent', { signals: { branches: ['fix/login'] } }),
      session('fork', { forkOf: 'parent', signals: { branches: ['fix/login'] } })
    ])
    expect(links(tie, 'parent')).toEqual([[after.sha, 'medium']])
    expect(tie.get('fork')).toEqual([])
  })

  it('an unlinked commit is left out, and another session can take it', () => {
    const c = commit(1)
    const r = matchRepo(repo([c]), [
      session('a', {
        unlinked: new Set([c.sha]),
        signals: { branches: ['fix/login'], files: ['src/a.ts'] }
      }),
      session('b')
    ])
    expect(r.get('a')).toEqual([])
    expect(links(r, 'b')).toEqual([[c.sha, 'low']])
  })

  it('worktrees: each session relative to its own worktree root', () => {
    const c = commit(1, { files: [{ path: 'src/a.ts', add: 1, del: 0 }] })
    const r = matchRepo(repo([c]), [
      session('wt', {
        root: 'c:/code/acme/.claude/worktrees/x',
        signals: { files: ['C:\\code\\acme\\.claude\\worktrees\\x\\src\\a.ts'] }
      })
    ])
    expect(links(r, 'wt')).toEqual([[c.sha, 'medium']])
  })
})

describe('pull requests and the badge', () => {
  it("takes the session's own PRs in this repo, merge PRs of linked commits, and gh by branch", () => {
    const c = commit(1, { pr: 40 })
    const own = {
      owner: 'beau',
      repo: 'acme',
      number: 14,
      url: 'https://github.com/beau/acme/pull/14',
      at: at(5)
    }
    const elsewhere = {
      ...own,
      repo: 'other',
      number: 3,
      url: 'https://github.com/beau/other/pull/3'
    }
    const prs = sessionPrs({
      signals: signals({ prs: [own, elsewhere] }),
      links: [{ sha: c.sha, level: 'high', reasons: [] }],
      commits: new Map([[c.sha, c]]),
      github: 'beau/acme',
      ghPrs: [
        { number: 14, title: 'Fix login', url: own.url, state: 'MERGED', headRefName: 'fix/login' },
        {
          number: 99,
          title: 'Unrelated',
          url: 'https://github.com/beau/acme/pull/99',
          state: 'OPEN',
          headRefName: 'other'
        },
        {
          number: 41,
          title: 'By branch',
          url: 'https://github.com/beau/acme/pull/41',
          state: 'OPEN',
          isDraft: true,
          headRefName: 'fix/login'
        }
      ],
      branches: ['fix/login']
    })
    expect(prs.map((p) => [p.number, p.via, p.state])).toEqual([
      [14, 'session', 'merged'],
      [40, 'merge', undefined],
      [41, 'gh', 'draft']
    ])
  })

  it('counts commits of medium or better', () => {
    const l = (level: CommitLink['level']): CommitLink => ({ sha: sha(1), level, reasons: [] })
    expect(gitBadge([l('exact'), l('medium'), l('low')], [])).toEqual({ commits: 2, prs: [] })
    expect(gitBadge([l('low')], [])).toBeUndefined()
    expect(badgeText({ commits: 3, prs: [14] })).toBe('3 commits · PR #14')
    expect(badgeText({ commits: 1, prs: [1, 2] })).toBe('1 commit · 2 PRs')
  })
})
