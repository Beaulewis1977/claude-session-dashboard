// Git links: the service (folders → repos, incremental reads, the cache,
// unlinking, the Changes view, gh, search filters) with a fake backend.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setClockOffset } from '@shared/clock'
import type { RefTip } from '@shared/git/log'
import { parseGitQuery } from '@shared/git/query'
import type { CommitInfo, GitLinkSettings, SessionGitSignals } from '@shared/git/types'
import type { GitBackend, LogOptions } from '../src/main/git/backend'
import { placeSession } from '../src/main/git/place'
import type { GitEnv } from '../src/main/git/runner'
import { GitLinksService, safeRemote } from '../src/main/git/service'
import { phoneGitView } from '../src/main/mobile/rpc'
import type { GitInput } from '../src/main/services/sessions'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 21, 13, 0)
const at = (m: number): number => T0 + m * MIN
const S = (n: number): string => n.toString(16).padStart(40, '0')

function sig(p: Partial<SessionGitSignals> = {}): SessionGitSignals {
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

function input(key: string, p: Partial<GitInput> = {}): GitInput {
  return {
    key,
    sessionId: key,
    provider: 'claude',
    env: 'windows',
    cwd: 'C:\\code\\acme',
    signals: sig(),
    rev: '1',
    ...p
  }
}

function commit(n: number, p: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: S(n),
    parents: n > 1 ? [S(n - 1)] : [],
    authorEmail: 'beau@example.com',
    committerEmail: 'beau@example.com',
    at: at(30),
    ct: at(30),
    subject: `Commit ${n}`,
    trailers: [],
    files: [{ path: 'src/a.ts', add: 2, del: 1 }],
    branches: [],
    ...p
  }
}

interface Repo {
  env: string
  root: string
  commonDir: string
  folders: string[]
  remote?: string
  email?: string
  /** A partial clone (a promisor remote). */
  partial?: boolean
  refs: RefTip[]
  commits: CommitInfo[]
}

function fakeBackend(repos: Repo[]) {
  const calls: { op: string; env: string; arg?: unknown }[] = []
  const key = (e: GitEnv): string =>
    e.kind === 'windows' ? 'windows' : `wsl:${e.distro}${e.user ? `:${e.user}` : ''}`
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  // Like git: the repo of any folder inside its work tree.
  const find = (e: GitEnv, dir: string) =>
    repos.find(
      (r) =>
        r.env === key(e) &&
        (r.folders.some((f) => norm(f) === norm(dir)) || norm(dir).startsWith(`${norm(r.root)}/`))
    )
  const byRoot = (e: GitEnv, root: string) => repos.find((r) => r.env === key(e) && r.root === root)
  const backend: GitBackend = {
    async version() {
      return { version: '2.51.0' }
    },
    async resolve(e, dir) {
      calls.push({ op: 'resolve', env: key(e), arg: dir })
      if (/gone/.test(dir))
        return { ok: false, status: 'missing', message: 'The folder no longer exists.' }
      const r = find(e, dir)
      if (r) return { ok: true, root: r.root, commonDir: r.commonDir, gitDir: r.commonDir }
      return { ok: false, status: 'not-repo', message: 'Not a repo' }
    },
    async exists(_e, dir) {
      return !/gone/.test(dir)
    },
    async userEmail(e, root) {
      return byRoot(e, root)?.email
    },
    async remoteUrl(e, root) {
      return byRoot(e, root)?.remote
    },
    async partialClone(e, root) {
      calls.push({ op: 'partialClone', env: key(e), arg: root })
      return !!byRoot(e, root)?.partial
    },
    async refs(e, root) {
      calls.push({ op: 'refs', env: key(e), arg: root })
      return byRoot(e, root)?.refs.map((x) => ({ ...x }))
    },
    async log(e, root, o: LogOptions) {
      calls.push({ op: 'log', env: key(e), arg: o })
      const r = byRoot(e, root)
      if (!r) return undefined
      const skip = new Set(o.not ?? [])
      return {
        commits: r.commits.filter((c) => !skip.has(c.sha)).map((c) => ({ ...c, branches: [] })),
        truncated: false
      }
    },
    async show(_e, _root, sha, paths) {
      calls.push({ op: 'show', env: 'windows', arg: { sha, paths } })
      return {
        text: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n`,
        truncated: false
      }
    },
    async ghAuth() {
      calls.push({ op: 'ghAuth', env: '' })
      return 'ok'
    },
    async ghPrs(slug, by) {
      calls.push({ op: 'ghPrs', env: '', arg: { slug, by } })
      return 'head' in by && by.head === 'fix/login'
        ? [
            {
              number: 14,
              title: 'Fix login',
              url: 'https://github.com/beau/acme/pull/14',
              state: 'OPEN',
              headRefName: 'fix/login'
            }
          ]
        : []
    }
  }
  return { backend, calls, count: (op: string) => calls.filter((c) => c.op === op).length }
}

let dataDir: string
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'csd-git-svc-'))
})
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
})

function service(
  inputs: GitInput[],
  backend: GitBackend,
  opts: { git?: Partial<GitLinkSettings>; running?: string[] } = {}
) {
  const unlinked = new Map<string, string[]>()
  let touched = 0
  const settings: GitLinkSettings = { enabled: true, gh: 'ask', ...opts.git }
  const svc = new GitLinksService({
    sessions: {
      gitInputs: () => inputs,
      gitUnlinked: (k) => unlinked.get(k) ?? [],
      setGitUnlinked: (k, shas) => {
        unlinked.set(k, shas)
        return true
      },
      on: () => undefined,
      touch: () => {
        touched++
      }
    },
    backend,
    platform: {
      listRunningDistros: async () => opts.running ?? ['Ubuntu'],
      defaultDistro: async () => 'Ubuntu',
      wslWindowsPath: async (_d, p) =>
        p.startsWith('/mnt/c/') ? `C:\\${p.slice(7).replace(/\//g, '\\')}` : undefined
    },
    dataDir,
    settings: () => ({ git: settings, scanStoppedDistros: false })
  })
  return { svc, settings, unlinked, touched: () => touched }
}

const ACME: Repo = {
  env: 'windows',
  root: 'C:/code/acme',
  commonDir: 'C:/code/acme/.git',
  folders: ['C:\\code\\acme', 'C:\\code\\acme\\.claude\\worktrees\\x', 'C:\\code\\acme\\src'],
  remote: 'https://beau:secret@github.com/beau/acme.git',
  email: 'beau@example.com',
  refs: [
    { ref: 'refs/heads/main', sha: S(3) },
    { ref: 'refs/heads/fix/login', sha: S(2) }
  ],
  commits: [
    commit(1, { at: at(-5000), ct: at(-5000) }),
    commit(2, { subject: 'Fix login' }),
    commit(3, {
      parents: [S(1)],
      at: at(45),
      ct: at(45),
      files: [{ path: 'README.md', add: 1, del: 0 }]
    })
  ]
}

describe('the git links service', () => {
  it('reads each repo once for all its sessions (worktrees included) and links commits', async () => {
    const f = fakeBackend([ACME])
    const { svc } = service(
      [
        input('a', {
          signals: sig({ branches: ['fix/login'], files: ['C:\\code\\acme\\src\\a.ts'] })
        }),
        input('wt', { cwd: 'C:\\code\\acme\\.claude\\worktrees\\x' }),
        input('none', { cwd: 'C:\\elsewhere' })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect(f.count('log')).toBe(1)
    expect(svc.badge('a')).toEqual({ commits: 1, prs: [] })
    const v = svc.view('a', { refresh: false })!
    expect(v.commits.map((c) => [c.subject, c.level])).toEqual([['Fix login', 'high']])
    expect(v.commits[0].branches).toEqual(['fix/login'])
    // The main-branch commit at minute 45 is a time-only match for both sessions in the repo.
    expect(v.possible.map((c) => c.subject)).toEqual(['Commit 3'])
    // The remote never shows its credentials.
    expect(v.repo).toMatchObject({
      github: 'beau/acme',
      remote: 'https://github.com/beau/acme.git'
    })
    expect(phoneGitView(v).repo?.remote).toBeUndefined()
    expect(svc.view('none', { refresh: false })).toMatchObject({ status: 'not-repo', commits: [] })
  })

  it('later passes read only new commits, and none when the tips are the same', async () => {
    const repo: Repo = { ...ACME, refs: [...ACME.refs], commits: [...ACME.commits] }
    const f = fakeBackend([repo])
    const { svc } = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], f.backend)
    await svc.start()
    await svc.schedule({ force: false })
    expect(f.count('log')).toBe(1)
    const refs = f.count('refs')
    await svc.schedule({ force: false })
    expect(f.count('log')).toBe(1)
    expect(f.count('refs')).toBe(refs + 1)
    repo.commits.push(commit(4, { parents: [S(2)], at: at(50), ct: at(50), subject: 'More' }))
    repo.refs = [repo.refs[0], { ref: 'refs/heads/fix/login', sha: S(4) }]
    await svc.schedule({ force: false })
    const last = f.calls.filter((c) => c.op === 'log').pop()!.arg as LogOptions
    expect(last.revs).toEqual([S(4)])
    expect(last.not?.sort()).toEqual([S(2), S(3)].sort())
    expect(
      svc
        .view('a', { refresh: false })!
        .commits.map((c) => c.subject)
        .sort()
    ).toEqual(['Fix login', 'More'])
  })

  it('keeps its results in the cache: a new start reads no history again', async () => {
    const f = fakeBackend([ACME])
    const first = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], f.backend)
    await first.svc.start()
    await first.svc.schedule({ force: false })
    await first.svc.flush()
    const g = fakeBackend([ACME])
    const second = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], g.backend)
    await second.svc.start()
    await second.svc.schedule({ force: false })
    expect(g.count('log')).toBe(0)
    expect(g.count('resolve')).toBe(0)
    expect(second.svc.badge('a')).toEqual({ commits: 1, prs: [] })
  })

  it('unlink moves a commit to the next best session; link again brings it back', async () => {
    const f = fakeBackend([ACME])
    const { svc, unlinked } = service(
      [
        input('a', { signals: sig({ branches: ['fix/login'], files: ['src/a.ts'] }) }),
        input('b', { signals: sig({ files: ['src/a.ts'] }) })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect(svc.view('a', { refresh: false })!.commits.map((c) => c.sha)).toEqual([S(2)])
    expect(svc.view('b', { refresh: false })!.commits).toEqual([])
    const v = svc.unlink('a', S(2))!
    expect(unlinked.get('a')).toEqual([S(2)])
    expect(v.commits).toEqual([])
    expect(v.unlinked.map((c) => c.sha)).toEqual([S(2)])
    expect(svc.view('b', { refresh: false })!.commits.map((c) => c.sha)).toEqual([S(2)])
    svc.relink('a', S(2))
    expect(svc.view('a', { refresh: false })!.commits.map((c) => c.sha)).toEqual([S(2)])
    expect(f.count('log')).toBe(1)
  })

  it('a gone folder is looked up in the repo that held it', async () => {
    const f = fakeBackend([ACME])
    const { svc } = service(
      [
        input('w', {
          cwd: 'C:\\code\\acme\\.claude\\worktrees\\gone',
          signals: sig({ files: ['C:\\code\\acme\\.claude\\worktrees\\gone\\src\\a.ts'] })
        })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    const v = svc.view('w', { refresh: false })!
    expect(v.repo?.note).toMatch(/no longer exists/)
    expect(v.commits.map((c) => c.subject)).toEqual(['Fix login'])
  })

  it("shows the commits a session's own output showed when there's no repo", async () => {
    const f = fakeBackend([])
    const { svc } = service(
      [
        input('x', {
          cwd: 'C:\\nowhere',
          signals: sig({
            commits: [
              {
                sha: 'abc1234',
                kind: 'commit-line',
                subject: 'Did it',
                branch: 'main',
                from: at(1),
                to: at(1)
              }
            ],
            prs: [
              {
                owner: 'beau',
                repo: 'acme',
                number: 3,
                url: 'https://github.com/beau/acme/pull/3',
                at: at(2)
              }
            ]
          })
        })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    const v = svc.view('x', { refresh: false })!
    expect(v.status).toBe('not-repo')
    expect(v.commits).toMatchObject([{ sha: 'abc1234', subject: 'Did it', unknown: true }])
    expect(v.prs.map((p) => p.number)).toEqual([3])
    expect(svc.badge('x')).toEqual({ commits: 0, prs: [3] })
  })

  it("gives diffs only for this session's commits and their own files", async () => {
    const f = fakeBackend([ACME])
    const { svc } = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], f.backend)
    await svc.start()
    await svc.schedule({ force: false })
    const d = await svc.diff('a', S(2), 'src/a.ts')
    expect(d.files.map((x) => [x.path, x.add, x.del])).toEqual([['src/a.ts', 1, 1]])
    expect((await svc.diff('a', S(1))).error).toMatch(/isn't linked/)
    expect((await svc.diff('a', S(2), '../../secret')).error).toMatch(/isn't part/)
    expect(f.count('show')).toBe(1)
  })

  it('asks gh nothing until PR lookups are turned on', async () => {
    const f = fakeBackend([ACME])
    const s = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], f.backend)
    await s.svc.start()
    await s.svc.schedule({ force: false })
    expect(f.count('ghAuth') + f.count('ghPrs')).toBe(0)
    expect(s.svc.view('a', { refresh: false })!.gh).toBe('ask')
    s.settings.gh = 'on'
    s.svc.settingsChanged()
    await s.svc.schedule({ force: false })
    expect(f.count('ghAuth')).toBe(1)
    expect(f.calls.filter((c) => c.op === 'ghPrs').map((c) => c.arg)).toEqual([
      { slug: 'beau/acme', by: { head: 'fix/login' } }
    ])
    const v = s.svc.view('a', { refresh: false })!
    expect(v.gh).toBe('on')
    expect(v.prs).toMatchObject([{ number: 14, state: 'open', via: 'gh' }])
    expect(s.svc.badge('a')).toEqual({ commits: 1, prs: [14] })
    // Cached: not asked again on the next pass.
    await s.svc.schedule({ force: false })
    expect(f.count('ghPrs')).toBe(1)
  })

  it("never asks a stopped distro's git (it would start it); keeps what was read", async () => {
    const API: Repo = {
      env: 'wsl:Ubuntu:beau',
      root: '/home/beau/api',
      commonDir: '/home/beau/api/.git',
      folders: ['/home/beau/api'],
      refs: [{ ref: 'refs/heads/main', sha: S(1) }],
      commits: [commit(1)]
    }
    const f = fakeBackend([API])
    const s = service(
      [input('w', { env: 'wsl', distro: 'Ubuntu', sourceUser: 'beau', cwd: '/home/beau/api' })],
      f.backend
    )
    await s.svc.start()
    await s.svc.schedule({ force: false })
    expect(f.count('log')).toBe(1)
    await s.svc.flush()
    // Ubuntu stops: a new start reads nothing from it, but still shows what it read.
    const g = fakeBackend([API])
    const t = service(
      [input('w', { env: 'wsl', distro: 'Ubuntu', sourceUser: 'beau', cwd: '/home/beau/api' })],
      g.backend,
      {
        running: []
      }
    )
    await t.svc.start()
    await t.svc.schedule({ force: false })
    expect(g.calls).toEqual([])
    expect(t.svc.view('w', { refresh: false })!.possible.map((c) => c.sha)).toEqual([S(1)])
    expect((await t.svc.diff('w', S(1))).error).toMatch(/isn't running/)
    expect((await t.svc.status()).git).toContainEqual({
      env: 'WSL: Ubuntu',
      error: "Not running (its git isn't asked)."
    })
    expect(g.calls.filter((c) => c.env.startsWith('wsl'))).toEqual([])
  })

  it("a fork's replayed parent output doesn't give it the parent's PRs or commits, however late", async () => {
    const pr = {
      owner: 'beau',
      repo: 'acme',
      number: 3,
      url: 'https://github.com/beau/acme/pull/3',
      at: at(2)
    }
    const mine = {
      owner: 'beau',
      repo: 'acme',
      number: 4,
      url: 'https://github.com/beau/acme/pull/4',
      at: at(9)
    }
    const seen = {
      sha: 'abc1234',
      kind: 'commit-line' as const,
      subject: 'x',
      from: at(1),
      to: at(1)
    }
    const f = fakeBackend([])
    const { svc } = service(
      [
        input('p', {
          cwd: 'C:\\nowhere',
          provider: 'codex',
          signals: sig({ prs: [pr], commits: [seen] })
        }),
        // The replay was written seconds after the fork started, so it looks like its own.
        input('f', {
          cwd: 'C:\\nowhere',
          provider: 'codex',
          forkOf: 'p',
          forkAt: at(5),
          signals: sig({ prs: [pr, mine], commits: [seen] })
        })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect(svc.view('f', { refresh: false })!.prs.map((x) => x.number)).toEqual([4])
    expect(svc.view('f', { refresh: false })!.commits).toEqual([])
    expect(svc.view('p', { refresh: false })!.prs.map((x) => x.number)).toEqual([3])
    expect([...svc.filter(parseGitQuery('commit:abc1234'))]).toEqual(['p'])
  })

  it('a partial clone is never read past its settings (and says why); its diffs are refused', async () => {
    const repo: Repo = { ...ACME, partial: true }
    const f = fakeBackend([repo])
    const { svc } = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], f.backend)
    await svc.start()
    await svc.schedule({ force: false })
    expect(f.count('partialClone')).toBeGreaterThan(0)
    expect(f.count('refs') + f.count('log') + f.count('show')).toBe(0)
    const v = svc.view('a', { refresh: false })!
    expect(v.repo?.error).toMatch(/partial clone/)
    expect(v.commits).toEqual([])

    // Read while it was a full clone, then made partial: its diffs aren't shown.
    const later: Repo = { ...ACME }
    const g = fakeBackend([later])
    const s2 = service([input('a', { signals: sig({ branches: ['fix/login'] }) })], g.backend)
    await s2.svc.start()
    await s2.svc.schedule({ force: false })
    const sha = s2.svc.view('a', { refresh: false })!.commits[0].sha
    later.partial = true
    const d = await s2.svc.diff('a', sha)
    expect(d.error).toMatch(/partial clone/)
    expect(g.count('show')).toBe(0)
  })

  it("a copy is its ancestor's even when the parent in between has nothing of its own", async () => {
    const gpPr = {
      owner: 'beau',
      repo: 'acme',
      number: 3,
      url: 'https://github.com/beau/acme/pull/3',
      at: at(2)
    }
    const gpSeen = { sha: 'abc1234', kind: 'commit-line' as const, from: at(1), to: at(1) }
    const mine = { ...gpPr, number: 4, url: 'https://github.com/beau/acme/pull/4', at: at(30) }
    const f = fakeBackend([])
    const codex = { cwd: 'C:\\nowhere', provider: 'codex' as const }
    const { svc } = service(
      [
        input('gp', { ...codex, signals: sig({ prs: [gpPr], commits: [gpSeen] }) }),
        // Its own copy of the grandparent was recognised: nothing left.
        input('p', { ...codex, forkOf: 'gp', forkAt: at(5), signals: sig() }),
        // Its copy (of the parent's copy) wasn't, and was stamped after its own start.
        input('c', {
          ...codex,
          forkOf: 'p',
          forkAt: at(10),
          signals: sig({
            prs: [{ ...gpPr, at: at(11) }, mine],
            commits: [{ ...gpSeen, from: at(11), to: at(11) }]
          })
        })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect(svc.view('c', { refresh: false })!.prs.map((x) => x.number)).toEqual([4])
    expect([...svc.filter(parseGitQuery('commit:abc1234'))]).toEqual(['gp'])
  })

  it("a fork's copied PR doesn't bring the parent's PR back through its branch (gh)", async () => {
    const pr14 = {
      owner: 'beau',
      repo: 'acme',
      number: 14,
      url: 'https://github.com/beau/acme/pull/14',
      at: at(40)
    }
    const f = fakeBackend([ACME])
    const { svc } = service(
      [
        input('p', { signals: sig({ branches: ['fix/login'], prs: [pr14] }) }),
        // No commits of its own (nothing in its stretch); only the parent's PR in its copy.
        input('f', {
          forkOf: 'p',
          forkAt: at(90),
          signals: sig({
            branches: ['fix/login'],
            prs: [{ ...pr14, at: at(95) }],
            spans: [[at(90), at(120)]]
          })
        })
      ],
      f.backend,
      { git: { gh: 'on' } }
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect(svc.view('p', { refresh: false })!.prs.map((x) => x.number)).toEqual([14])
    expect(svc.view('f', { refresh: false })!.commits).toEqual([])
    expect(svc.view('f', { refresh: false })!.prs).toEqual([])
    expect(svc.badge('f')).toBeUndefined()
  })

  it("a Claude fork's copied edits (the parent's times) aren't its own, with or without the parent", async () => {
    const dir = 'C:\\code\\acme\\src\\'
    const parent = input('p', {
      signals: sig({ files: [`${dir}parent-only.ts`, `${dir}both.ts`], filesAt: [at(10), at(12)] })
    })
    const fork = input('f', {
      forkOf: 'p',
      forkAt: at(20),
      signals: sig({
        // Edited in the copy only; in the copy and again after the split; only after it.
        files: [`${dir}parent-only.ts`, `${dir}both.ts`, `${dir}mine.ts`],
        filesAt: [at(10), at(26), at(25)]
      })
    })
    for (const list of [[parent, fork], [fork]]) {
      const { svc } = service(list, fakeBackend([ACME]).backend)
      await svc.start()
      await svc.schedule({ force: false })
      const touched = (p: string) => [...svc.filter(parseGitQuery(`touched:${p}`))].sort()
      expect(touched('parent-only.ts')).toEqual(list.length === 2 ? ['p'] : [])
      expect(touched('mine.ts')).toEqual(['f'])
      expect(touched('both.ts')).toEqual(list.length === 2 ? ['f', 'p'] : ['f'])
      expect(svc.view('f', { refresh: false })!.uncommitted.sort()).toEqual([
        'src/both.ts',
        'src/mine.ts'
      ])
    }
  })

  it('a removed worktree: the repo is read through another of its worktrees', async () => {
    let wtGone = false
    const f = fakeBackend([ACME])
    const wtRoot = 'C:/code/acme/.claude/worktrees/x'
    const base = f.backend
    const backend: GitBackend = {
      ...base,
      async resolve(e, dir) {
        if (/worktrees/.test(dir)) {
          if (wtGone) return { ok: false, status: 'missing', message: 'gone' }
          return {
            ok: true,
            root: wtRoot,
            commonDir: ACME.commonDir,
            gitDir: `${ACME.commonDir}/worktrees/x`
          }
        }
        return base.resolve(e, dir)
      },
      async partialClone(e, root) {
        if (root === wtRoot) return wtGone ? undefined : false
        return base.partialClone(e, root)
      },
      async refs(e, root) {
        if (root === wtRoot) return wtGone ? undefined : ACME.refs.map((x) => ({ ...x }))
        return base.refs(e, root)
      },
      async log(e, root, o) {
        if (root === wtRoot && wtGone) return undefined
        return base.log(e, root === wtRoot ? ACME.root : root, o)
      }
    }
    const { svc } = service(
      [
        input('wt', {
          cwd: 'C:\\code\\acme\\.claude\\worktrees\\x',
          signals: sig({ branches: ['fix/login'] })
        }),
        input('main', { signals: sig({ branches: ['fix/login'] }) })
      ],
      backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    wtGone = true
    await svc.refresh()
    const v = svc.view('main', { refresh: false })!
    expect(v.repo?.root).toBe(ACME.root)
    expect(v.commits.length + v.possible.length).toBeGreaterThan(0)
    const refsAfter = f.calls.filter((c) => c.op === 'refs').pop()!
    expect(refsAfter.arg).toBe(ACME.root)
  })

  it('a PR looked up by SHA before it existed is looked up again later', async () => {
    const c = ACME.commits[1]
    let prs: { number: number; title: string; url: string; state: string; headRefName: string }[] =
      []
    const f = fakeBackend([ACME])
    const searches: string[] = []
    const backend: GitBackend = {
      ...f.backend,
      async ghPrs(slug, by) {
        if ('search' in by) {
          searches.push(by.search)
          return prs
        }
        return f.backend.ghPrs(slug, by)
      }
    }
    const s = service(
      [
        input('a', {
          signals: sig({
            commits: [{ sha: c.sha.slice(0, 7), kind: 'commit-line', from: at(30), to: at(30) }]
          })
        })
      ],
      backend,
      { git: { gh: 'on' } }
    )
    await s.svc.start()
    await s.svc.schedule({ force: false })
    s.svc.view('a')
    await new Promise((r) => setTimeout(r, 50))
    expect(searches).toEqual([c.sha])
    prs = [
      {
        number: 30,
        title: 'Later',
        url: 'https://github.com/beau/acme/pull/30',
        state: 'OPEN',
        headRefName: 'x'
      }
    ]
    setClockOffset(2 * 3600_000)
    try {
      s.svc.view('a')
      await new Promise((r) => setTimeout(r, 50))
      expect(searches).toEqual([c.sha, c.sha])
      expect(s.svc.view('a', { refresh: false })!.prs.map((x) => x.number)).toContain(30)
    } finally {
      setClockOffset(0)
    }
  })

  it('does nothing when git links are off', async () => {
    const f = fakeBackend([ACME])
    const { svc } = service([input('a')], f.backend, { git: { enabled: false } })
    await svc.start()
    await svc.schedule({ force: false })
    expect(f.calls).toEqual([])
    expect(svc.badge('a')).toBeUndefined()
    expect(svc.view('a')!.enabled).toBe(false)
  })

  it('finds sessions by touched: and commit:', async () => {
    const f = fakeBackend([ACME])
    const { svc } = service(
      [
        input('a', {
          signals: sig({ branches: ['fix/login'], files: ['C:\\code\\acme\\src\\b.ts'] })
        }),
        input('b', { cwd: 'C:\\elsewhere', signals: sig({ files: ['C:\\elsewhere\\notes.md'] }) })
      ],
      f.backend
    )
    await svc.start()
    await svc.schedule({ force: false })
    expect([...svc.filter(parseGitQuery('touched:src/a.ts'))]).toEqual(['a'])
    expect([...svc.filter(parseGitQuery('touched:b.ts'))]).toEqual(['a'])
    expect([...svc.filter(parseGitQuery('touched:notes.md'))]).toEqual(['b'])
    expect([...svc.filter(parseGitQuery(`commit:${S(2).slice(0, 10)}`))]).toEqual(['a'])
    expect([...svc.filter(parseGitQuery('touched:a.ts commit:ffff'))]).toEqual([])
  })
})

describe('where a session’s git runs', () => {
  const ctx = {
    platform: {
      wslWindowsPath: async (_d: string, p: string) =>
        p.startsWith('/mnt/c/') ? `C:\\${p.slice(7).replace(/\//g, '\\')}` : undefined
    },
    running: ['Ubuntu'],
    defaultDistro: 'Ubuntu',
    scanStopped: false
  }
  it('Windows folders: Windows git', async () => {
    expect(await placeSession({ env: 'windows', cwd: 'C:\\code\\my app' }, ctx)).toEqual({
      ok: true,
      env: { kind: 'windows' },
      dir: 'C:\\code\\my app'
    })
  })
  it('WSL folders: the distro’s own git, as the home’s user', async () => {
    expect(
      await placeSession(
        { env: 'wsl', distro: 'Ubuntu', sourceUser: 'beau', cwd: '/home/beau/api' },
        ctx
      )
    ).toEqual({
      ok: true,
      env: { kind: 'wsl', distro: 'Ubuntu', user: 'beau' },
      dir: '/home/beau/api'
    })
    expect(
      await placeSession({ env: 'windows', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\beau\\x' }, ctx)
    ).toEqual({
      ok: true,
      env: { kind: 'wsl', distro: 'Ubuntu' },
      dir: '/home/beau/x'
    })
  })
  it('a Windows drive seen from WSL: mapped by the distro, then Windows git', async () => {
    expect(
      await placeSession({ env: 'wsl', distro: 'Ubuntu', cwd: '/mnt/c/code/acme' }, ctx)
    ).toEqual({
      ok: true,
      env: { kind: 'windows' },
      dir: 'C:\\code\\acme'
    })
  })
  it('a Linux folder in a Windows Codex home: the default distro', async () => {
    expect(await placeSession({ env: 'windows', cwd: '/home/beau/x' }, ctx)).toMatchObject({
      ok: true,
      env: { kind: 'wsl', distro: 'Ubuntu' }
    })
  })
  it('never starts a stopped distro; no folder, no git', async () => {
    expect(
      await placeSession({ env: 'wsl', distro: 'Debian', cwd: '/home/beau/x' }, ctx)
    ).toMatchObject({ ok: false, status: 'distro-stopped' })
    expect(await placeSession({ env: 'windows' }, ctx)).toMatchObject({
      ok: false,
      status: 'no-folder'
    })
  })
  it('strips credentials from a remote URL', () => {
    expect(safeRemote('https://user:tok@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(safeRemote('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
  })
})

describe('the phone and settings', () => {
  it('a phone can read git links, nothing more', async () => {
    const { RPC, phoneSettingsPatch } = await import('../src/main/mobile/rpc')
    const git = Object.entries(RPC).filter(([, m]) => m.channel.startsWith('git:'))
    expect(git.map(([name, m]) => [name, m.channel, m.kind])).toEqual([
      ['getGitLinks', 'git:session', 'read']
    ])
    expect(phoneSettingsPatch({ gitLinks: { enabled: false, gh: 'on' } })).toEqual({})
  })

  it('cleans the git settings (on and ask by default)', async () => {
    const { sanitizeGitSettings } = await import('@shared/git/types')
    expect(sanitizeGitSettings(undefined)).toEqual({ enabled: true, gh: 'ask' })
    expect(sanitizeGitSettings({ enabled: false, gh: 'on' })).toEqual({ enabled: false, gh: 'on' })
    expect(sanitizeGitSettings({ enabled: 'no', gh: 'yes' })).toEqual({ enabled: true, gh: 'ask' })
  })
})
