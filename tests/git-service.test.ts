// Git links: the service (folders → repos, incremental reads, the cache,
// unlinking, the Changes view, gh, search filters) with a fake backend.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
