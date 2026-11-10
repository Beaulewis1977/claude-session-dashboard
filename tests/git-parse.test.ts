// Git links: parsing git's output (log, refs, patches), branches from the
// commit graph, remotes, search filters, and the real read-only backend on a
// temporary repo this test makes (the test writes it; the app only reads).

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parsePatch } from '@shared/git/diff'
import {
  MAX_BRANCH_LABELS,
  defaultBranch,
  labelBranches,
  mergeSubject,
  squashPr
} from '@shared/git/graph'
import {
  branchName,
  githubSlug,
  isPartialClone,
  normalizeRemote,
  parseLog,
  parseNumstat,
  parseRefs,
  renamePaths,
  unquotePath
} from '@shared/git/log'
import { hasGitFilters, parseGitQuery, pathMatches, touchedQuery } from '@shared/git/query'
import type { CommitInfo } from '@shared/git/types'
import { createRealBackend } from '../src/main/git/backend'
import { GIT_ENV, createProcessRunner } from '../src/main/git/runner'
import { fileExists } from '../src/main/core/which'
import { wslRoots } from '../src/main/core/wsl'

const S = (n: number): string => n.toString(16).padStart(40, '0')

describe('git log output', () => {
  it('reads records, trailers and numstat (renames, binaries)', () => {
    const out =
      `\x1e${S(2)}\x1f${S(1)}\x1fbeau@example.com\x1fbeau@example.com\x1f1761051840\x1f1761051900\x1fFix it\x1fCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01AbCdEf9876\n\x1f\n\n` +
      `3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t0\tsrc/{old => new}/b.ts\n2\t0\tdocs/x.md => docs/y.md\n` +
      `\x1e${S(1)}\x1f\x1fa@x\x1fa@x\x1f1761000000\x1f1761000000\x1fFirst\x1f\x1f\n\n1\t0\t"a\\tb.txt"\n`
    const [c2, c1] = parseLog(out)
    expect(c2).toMatchObject({
      sha: S(2),
      parents: [S(1)],
      at: 1761051840_000,
      ct: 1761051900_000,
      subject: 'Fix it',
      trailers: [
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        'Claude-Session: https://claude.ai/code/session_01AbCdEf9876'
      ]
    })
    expect(c2.files).toEqual([
      { path: 'src/a.ts', add: 3, del: 1 },
      { path: 'logo.png' },
      { path: 'src/new/b.ts', from: 'src/old/b.ts', add: 0, del: 0 },
      { path: 'docs/y.md', from: 'docs/x.md', add: 2, del: 0 }
    ])
    expect(c1.parents).toEqual([])
    expect(c1.files).toEqual([{ path: 'a\tb.txt', add: 1, del: 0 }])
  })

  it('handles brace renames at the ends and quoted paths', () => {
    expect(renamePaths('{a => b}/x.ts')).toEqual({ from: 'a/x.ts', path: 'b/x.ts' })
    expect(renamePaths('src/{ => sub}/x.ts')).toEqual({ from: 'src/x.ts', path: 'src/sub/x.ts' })
    expect(unquotePath('"caf\\303\\251.md"')).toBe('café.md')
    expect(parseNumstat('not a numstat line')).toBeUndefined()
  })

  it('reads refs (annotated tags peeled, origin/HEAD) and branch names', () => {
    const refs = parseRefs(
      [
        `${S(5)}\x1f\x1frefs/heads/main\x1f`,
        `${S(6)}\x1f${S(5)}\x1frefs/tags/v1\x1f`,
        `${S(5)}\x1f\x1frefs/remotes/origin/HEAD\x1frefs/remotes/origin/main`,
        'garbage'
      ].join('\n')
    )
    expect(refs).toEqual([
      { ref: 'refs/heads/main', sha: S(5) },
      { ref: 'refs/tags/v1', sha: S(5) },
      { ref: 'refs/remotes/origin/HEAD', sha: S(5), symref: 'refs/remotes/origin/main' }
    ])
    expect(defaultBranch(refs)).toBe('main')
    expect(branchName('refs/remotes/origin/feat/x')).toBe('feat/x')
    expect(branchName('refs/tags/v1')).toBeUndefined()
  })

  it('knows GitHub remotes and compares remotes without credentials', () => {
    expect(githubSlug('https://github.com/beau/acme-web.git')).toBe('beau/acme-web')
    expect(githubSlug('git@github.com:beau/acme-web.git')).toBe('beau/acme-web')
    expect(githubSlug('ssh://git@github.com/beau/acme-web')).toBe('beau/acme-web')
    expect(githubSlug('https://user:token@github.com/beau/x.y')).toBe('beau/x.y')
    expect(githubSlug('https://gitlab.com/beau/acme')).toBeUndefined()
    expect(normalizeRemote('git@github.com:Beau/Acme.git')).toBe(
      normalizeRemote('https://github.com/beau/acme')
    )
    expect(normalizeRemote('https://u:p@example.com/beau/shop-api.git')).toBe(
      'example.com/beau/shop-api'
    )
  })
})

describe('branches from the commit graph', () => {
  function c(n: number, parents: number[], subject = `c${n}`): CommitInfo {
    return {
      sha: S(n),
      parents: parents.map(S),
      authorEmail: '',
      committerEmail: '',
      at: n,
      ct: n,
      subject,
      trailers: [],
      files: [],
      branches: []
    }
  }

  it('names merged, unmerged and default-branch commits, and their PRs', () => {
    // main: 1 - 2 ------- 5 (merge #7 from beau/feat/x) - 6 "Polish (#9)"
    // feat/x:      \ 3 - 4 /
    // wip/y: 6 - 7
    const all = [
      c(1, []),
      c(2, [1]),
      c(3, [2]),
      c(4, [3]),
      c(5, [2, 4], 'Merge pull request #7 from beau/feat/x'),
      c(6, [5], 'Polish (#9)'),
      c(7, [6])
    ]
    const map = new Map(all.map((x) => [x.sha, x]))
    labelBranches(map, [
      { ref: 'refs/remotes/origin/HEAD', sha: S(6), symref: 'refs/remotes/origin/main' },
      { ref: 'refs/remotes/origin/main', sha: S(6) },
      { ref: 'refs/heads/main', sha: S(6) },
      { ref: 'refs/heads/wip/y', sha: S(7) }
    ])
    const b = (n: number) => map.get(S(n))!
    expect(b(3).branches).toEqual(['feat/x'])
    expect(b(4)).toMatchObject({ branches: ['feat/x'], pr: 7 })
    expect(b(5)).toMatchObject({ branches: ['main'], pr: 7 })
    expect(b(6)).toMatchObject({ branches: ['main'], pr: 9 })
    expect(b(7).branches).toEqual(['wip/y'])
    expect(b(2).branches).toEqual(['main'])
  })

  it("stacked PRs: a later merge never takes an earlier PR's commits", () => {
    // main: 1 ---- 4 (merge #10 from beau/a) ---- 6 (merge #20 from beau/b)
    // a:      \ 2 /                              /
    // b:          \ 3 (on top of a) ----- 5 -----
    const all = [
      c(1, []),
      c(2, [1]),
      c(3, [2]),
      c(4, [1, 2], 'Merge pull request #10 from beau/a'),
      c(5, [3]),
      c(6, [4, 5], 'Merge pull request #20 from beau/b')
    ]
    const map = new Map(all.map((x) => [x.sha, x]))
    labelBranches(map, [{ ref: 'refs/heads/main', sha: S(6) }])
    expect(map.get(S(2))).toMatchObject({ branches: ['a'], pr: 10 })
    expect(map.get(S(3))).toMatchObject({ branches: ['b'], pr: 20 })
    expect(map.get(S(5))).toMatchObject({ branches: ['b'], pr: 20 })
  })

  it('a long stack of PRs (4,999 commits, 1,250 merges): each commit named once, quickly', () => {
    // PR k: 3 commits on top of PR k-1's, merged into main as merge k.
    const all: CommitInfo[] = [c(1, [])]
    let main = 1
    let prev = 1
    let n = 2
    const prOf = new Map<number, number>()
    for (let k = 1; n + 3 < 5000; k++) {
      for (let j = 0; j < 3; j++) {
        all.push(c(n, [prev]))
        prOf.set(n, k)
        prev = n++
      }
      all.push(c(n, [main, prev], `Merge pull request #${k} from beau/pr-${k}`))
      main = n++
    }
    expect(all.length).toBeGreaterThanOrEqual(4996)
    const map = new Map(all.map((x) => [x.sha, x]))
    const t = performance.now()
    labelBranches(map, [{ ref: 'refs/heads/main', sha: S(main) }])
    expect(performance.now() - t).toBeLessThan(1000)
    let labels = 0
    for (const x of all) labels += x.branches.length
    expect(labels).toBe(all.length)
    for (const [sha, k] of prOf)
      expect(map.get(S(sha))).toMatchObject({ branches: [`pr-${k}`], pr: k })
  })

  it('a branch merged into a branch: its commits get both names, the earlier ones only theirs', () => {
    // main: 1 ----------------------- 7 (merge #30 from beau/feature)
    // feature: \ 2 - 3 ------ 6 (merge 'sub') /
    // sub:            \ 4 - 5 /
    const all = [
      c(1, []),
      c(2, [1]),
      c(3, [2]),
      c(4, [3]),
      c(5, [4]),
      c(6, [3, 5], "Merge branch 'sub' into feature"),
      c(7, [1, 6], 'Merge pull request #30 from beau/feature')
    ]
    const map = new Map(all.map((x) => [x.sha, x]))
    labelBranches(map, [{ ref: 'refs/heads/main', sha: S(7) }])
    const b = (k: number) => map.get(S(k))!
    expect(b(2)).toMatchObject({ branches: ['feature'], pr: 30 })
    expect(b(3)).toMatchObject({ branches: ['feature'], pr: 30 })
    expect(b(4).branches.sort()).toEqual(['feature', 'sub'])
    expect(b(5)).toMatchObject({ pr: 30 })
    expect(b(6).branches).toEqual(['feature'])
  })

  it("a merge into another branch doesn't take what the default branch already merged", () => {
    // main: 1 -------- 4 (merge #10 from beau/f)
    // f:     \ 2 - 3 /   \
    // g:                  5 ----- 7 (merge 'x' into g)
    // x:       \ 6 (from f's first commit) /
    const all = [
      c(1, []),
      c(2, [1]),
      c(3, [2]),
      c(4, [1, 3], 'Merge pull request #10 from beau/f'),
      c(5, [4]),
      c(6, [2]),
      c(7, [5, 6], "Merge branch 'x' into g")
    ]
    const map = new Map(all.map((x) => [x.sha, x]))
    labelBranches(map, [
      { ref: 'refs/heads/main', sha: S(4) },
      { ref: 'refs/heads/g', sha: S(7) }
    ])
    // 2 was merged by #10 before g took x in: it's f's, not x's.
    expect(map.get(S(2))).toMatchObject({ branches: ['f'], pr: 10 })
    expect(map.get(S(6))!.branches).toContain('x')
  })

  it('a PR merged into a branch keeps its own number when a later PR merges that branch', () => {
    // main: 1 ---------------- 5 (merge #30 from beau/feature)
    // feature: \ 2 ---- 4 (merge #10 from beau/sub) /
    // sub:          \ 3 /
    const all = [
      c(1, []),
      c(2, [1]),
      c(3, [2]),
      c(4, [2, 3], 'Merge pull request #10 from beau/sub'),
      c(5, [1, 4], 'Merge pull request #30 from beau/feature')
    ]
    const map = new Map(all.map((x) => [x.sha, x]))
    labelBranches(map, [{ ref: 'refs/heads/main', sha: S(5) }])
    expect(map.get(S(4))).toMatchObject({ branches: ['feature'], pr: 10 })
    expect(map.get(S(3))!.pr).toBe(10)
    expect(map.get(S(3))!.branches.sort()).toEqual(['feature', 'sub'])
    expect(map.get(S(2))).toMatchObject({ branches: ['feature'], pr: 30 })
  })

  it('1,200 branches from one old commit merged into a branch: still quick and bounded', () => {
    // develop (not the default branch) gets 1,200 merges; every branch started at commit 2.
    const all: CommitInfo[] = [c(1, []), c(2, [1])]
    let dev = 2
    let n = 3
    for (let k = 0; k < 1200; k++) {
      all.push(c(n, [2]))
      const tip = n++
      all.push(c(n, [dev, tip], `Merge branch 'b-${k}' into develop`))
      dev = n++
    }
    const map = new Map(all.map((x) => [x.sha, x]))
    const t = performance.now()
    labelBranches(map, [
      { ref: 'refs/heads/main', sha: S(1) },
      { ref: 'refs/heads/develop', sha: S(dev) }
    ])
    expect(performance.now() - t).toBeLessThan(1500)
    let labels = 0
    for (const x of all) labels += x.branches.length
    expect(labels).toBeLessThan(all.length * 4)
    expect(map.get(S(3))!.branches).toContain('b-0')
  })

  it("many unmerged branches on one long history: a few names per commit, sessions' first", () => {
    // develop (not merged): 1,000 commits; 300 branches started at its tip.
    const all: CommitInfo[] = [c(1, [])]
    for (let k = 2; k <= 1000; k++) all.push(c(k, [k - 1]))
    const refs = [
      { ref: 'refs/heads/main', sha: S(1) },
      { ref: 'refs/heads/develop', sha: S(1000) }
    ]
    for (let k = 0; k < 300; k++) {
      all.push(c(2000 + k, [1000]))
      refs.push({ ref: `refs/heads/f-${k}`, sha: S(2000 + k) })
    }
    const map = new Map(all.map((x) => [x.sha, x]))
    const t = performance.now()
    labelBranches(map, refs, { prefer: ['f-299'] })
    expect(performance.now() - t).toBeLessThan(1000)
    const mid = map.get(S(500))!
    expect(mid.branches).toHaveLength(MAX_BRANCH_LABELS)
    // The branch a session was on, and the nearest one (develop's own tip).
    expect(mid.branches).toContain('f-299')
    expect(mid.branches).toContain('develop')
    // Each branch's own commit has its own name.
    expect(map.get(S(2150))!.branches).toEqual(['f-150'])
  })

  it('reads merge and squash subjects', () => {
    expect(mergeSubject("Merge branch 'fix/a' into main")).toEqual({ branch: 'fix/a' })
    expect(mergeSubject("Merge remote-tracking branch 'origin/fix/b'")).toEqual({ branch: 'fix/b' })
    expect(mergeSubject('Fix things')).toBeUndefined()
    expect(squashPr('Add pagination (#123)')).toBe(123)
    expect(squashPr('Add (#x)')).toBeUndefined()
  })
})

describe('patches', () => {
  it('reads added, deleted, renamed, binary and modified files with line numbers', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@ export',
      ' keep',
      '-old',
      '+new',
      '',
      '\\ No newline at end of file',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/old name.md b/new name.md',
      'similarity index 100%',
      'rename from old name.md',
      'rename to new name.md',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      ''
    ].join('\n')
    const files = parsePatch(patch)
    expect(files.map((f) => [f.path, f.status, f.add, f.del])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['new.ts', 'added', 1, 0],
      ['gone.ts', 'deleted', 0, 1],
      ['new name.md', 'renamed', 0, 0],
      ['logo.png', 'binary', 0, 0]
    ])
    expect(files[0].hunks[0].lines).toEqual([
      { t: ' ', text: 'keep', oldNo: 1, newNo: 1 },
      { t: '-', text: 'old', oldNo: 2 },
      { t: '+', text: 'new', newNo: 2 },
      { t: ' ', text: '', oldNo: 3, newNo: 3 },
      { t: '\\', text: 'No newline at end of file' }
    ])
    expect(files[3].from).toBe('old name.md')
  })
})

describe('very long diffs', () => {
  it('counts the lines past the limit, and keeps them when asked for the whole diff', () => {
    const body = Array.from({ length: 25 }, (_, i) => '+line ' + i).join('\n')
    const patch =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,25 @@\n' + body + '\n'
    const cut = parsePatch(patch, 20)[0]
    expect(cut.hunks[0].lines).toHaveLength(20)
    expect(cut).toMatchObject({ add: 25, cut: 5 })
    const whole = parsePatch(patch, 100)[0]
    expect(whole.hunks[0].lines).toHaveLength(25)
    expect(whole.cut).toBeUndefined()
  })
})

describe('partial clone settings', () => {
  it('a promisor remote or extensions.partialClone makes one; a false promisor does not', () => {
    // `git config --null --get-regexp`: key, newline, value, NUL.
    expect(isPartialClone('')).toBe(false)
    expect(isPartialClone('extensions.partialclone\norigin\0')).toBe(true)
    expect(isPartialClone('remote.origin.promisor\ntrue\0')).toBe(true)
    // A remote named with a space, and a bare key (true).
    expect(isPartialClone('remote.Back Up.promisor\0')).toBe(true)
    expect(isPartialClone('remote.Back Up.promisor\nfalse\0remote.b.promisor\n0\0')).toBe(false)
    expect(isPartialClone('remote.b.promisor\noff\0remote.c.promisor\nyes\0')).toBe(true)
  })
})

describe('search filters', () => {
  it('reads touched: and commit: and keeps the rest as text', () => {
    expect(parseGitQuery('cookie touched:src/bridge.ts commit:ABC1234 fix')).toEqual({
      text: 'cookie fix',
      touched: ['src/bridge.ts'],
      commits: ['abc1234']
    })
    expect(parseGitQuery('touched:"My Docs\\a b.md"').touched).toEqual(['my docs/a b.md'])
    expect(hasGitFilters(parseGitQuery('commit:xyz'))).toBe(false)
    expect(touchedQuery('docs/a b.md')).toBe('touched:"docs/a b.md"')
  })

  it('matches a file by its whole path, its end, or a folder it is in', () => {
    expect(pathMatches('src/main/services/bridge.ts', 'bridge.ts')).toBe(true)
    expect(pathMatches('src/main/services/bridge.ts', 'services/bridge.ts')).toBe(true)
    expect(pathMatches('src/main/services/bridge.ts', 'src/main')).toBe(true)
    expect(pathMatches('C:\\x\\src\\Main\\a.ts', 'src/main')).toBe(true)
    expect(pathMatches('src/main/services/bridge.ts', 'ridge.ts')).toBe(false)
  })
})

// ------------------------------------------------------- real git, read-only

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.runIf(hasGit())('the real backend on a temporary repo', () => {
  let root: string
  let repo: string
  const backend = () =>
    createRealBackend(createProcessRunner({ cwd: tmpdir() }), { exists: fileExists, wslRoots })
  const env = { kind: 'windows' as const }
  const git = (args: string[], at?: string): string => {
    const date = at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}
    return execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        ...date,
        GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1'
      },
      encoding: 'utf8'
    })
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'csd-git-'))
    repo = join(root, 'my repo')
    await mkdir(repo)
    await writeFile(
      join(root, 'gitconfig'),
      '[user]\n\tname = Sample\n\temail = sample@example.com\n[init]\n\tdefaultBranch = main\n'
    )
    git(['init', '-q'])
    git(['config', 'user.email', 'sample@example.com'])
    git(['config', 'user.name', 'Sample'])
    git(['remote', 'add', 'origin', 'https://github.com/sample/my-repo.git'])
    await writeFile(join(repo, 'a.ts'), 'one\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'First'], '2026-10-20T10:00:00Z')
    git(['switch', '-q', '-c', 'feat/x'])
    await writeFile(join(repo, 'a.ts'), 'one\ntwo\n')
    await writeFile(join(repo, 'with space.md'), 'hi\n')
    git(['add', '.'])
    git(
      [
        'commit',
        '-q',
        '-m',
        'Add two\n\nClaude-Session: https://claude.ai/code/session_01AbCdEf9876'
      ],
      '2026-10-21T13:04:00Z'
    )
    git(['mv', 'with space.md', 'renamed.md'])
    git(['commit', '-q', '-m', 'Rename'], '2026-10-21T13:05:00Z')
    git(['switch', '-q', 'main'])
    git(
      ['merge', '-q', '--no-ff', 'feat/x', '-m', 'Merge pull request #7 from sample/feat/x'],
      '2026-10-22T09:00:00Z'
    )
    git(['switch', '-q', '-c', 'wip/y'])
    await writeFile(join(repo, 'b.ts'), 'b\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Wip'], '2026-10-22T10:00:00Z')
    git(['switch', '-q', 'main'])
    git(['tag', '-a', 'v1', '-m', 'v1'])
    git(['worktree', 'add', '-q', join(root, 'wt'), 'wip/y'])
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  it('finds the repo from a worktree too (one shared git folder)', async () => {
    const b = backend()
    const main = await b.resolve(env, repo)
    const wt = await b.resolve(env, join(root, 'wt'))
    expect(main.ok && wt.ok).toBe(true)
    if (!main.ok || !wt.ok) return
    expect(wt.commonDir.replace(/\\/g, '/').toLowerCase()).toBe(
      main.commonDir.replace(/\\/g, '/').toLowerCase()
    )
    expect(wt.root).not.toBe(main.root)
    expect(await b.resolve(env, join(root, 'nope'))).toMatchObject({ ok: false, status: 'missing' })
    expect(await b.resolve(env, tmpdir())).toMatchObject({ ok: false })
  })

  it('reads remote, user, refs and the history, and names branches and PRs', async () => {
    const b = backend()
    const r = await b.resolve(env, repo)
    if (!r.ok) throw new Error(r.message)
    expect(await b.remoteUrl(env, r.root)).toBe('https://github.com/sample/my-repo.git')
    expect(await b.userEmail(env, r.root)).toBe('sample@example.com')
    const refs = (await b.refs(env, r.root))!
    expect(refs.map((x) => x.ref).sort()).toEqual([
      'refs/heads/feat/x',
      'refs/heads/main',
      'refs/heads/wip/y',
      'refs/tags/v1'
    ])
    const res = (await b.log(env, r.root, {
      revs: ['--branches', '--remotes', '--tags'],
      since: Date.parse('2026-10-01T00:00:00Z'),
      maxCount: 100
    }))!
    expect(res.truncated).toBe(false)
    const map = new Map(res.commits.map((c) => [c.sha, c]))
    labelBranches(map, refs)
    const by = (s: string) => res.commits.find((c) => c.subject === s)!
    expect(by('Add two')).toMatchObject({
      branches: ['feat/x'],
      pr: 7,
      trailers: ['Claude-Session: https://claude.ai/code/session_01AbCdEf9876'],
      at: Date.parse('2026-10-21T13:04:00Z')
    })
    expect(
      by('Add two')
        .files.map((f) => f.path)
        .sort()
    ).toEqual(['a.ts', 'with space.md'])
    expect(by('Rename').files).toEqual([
      { path: 'renamed.md', from: 'with space.md', add: 0, del: 0 }
    ])
    expect(by('Wip').branches).toEqual(['wip/y'])
    expect(by('First').branches).toEqual(['main'])
    // Only what's new since the tips read before.
    const old = refs.filter((x) => x.ref !== 'refs/heads/wip/y').map((x) => x.sha)
    const inc = (await b.log(env, r.root, { revs: [by('Wip').sha], not: old, maxCount: 100 }))!
    expect(inc.commits.map((c) => c.subject)).toEqual(['Wip'])
  })

  it("shows a commit's patch, whole or for one file", async () => {
    const b = backend()
    const r = await b.resolve(env, repo)
    if (!r.ok) throw new Error(r.message)
    const sha = git(['rev-parse', 'feat/x~1']).trim()
    const whole = await b.show(env, r.root, sha, undefined, 1024 * 1024)
    expect(
      parsePatch(whole.text)
        .map((f) => f.path)
        .sort()
    ).toEqual(['a.ts', 'with space.md'])
    const one = await b.show(env, r.root, sha, ['with space.md'], 1024 * 1024)
    expect(parsePatch(one.text).map((f) => [f.path, f.status])).toEqual([
      ['with space.md', 'added']
    ])
    const cut = await b.show(env, r.root, sha, undefined, 40)
    expect(cut.truncated).toBe(true)
  })

  it("shows what a merge brought in (first parent), whatever the repo's diff prefixes", async () => {
    git(['switch', '-q', '-c', 'side'])
    await writeFile(join(repo, 'm.txt'), 'side\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Side'], '2026-10-23T10:00:00Z')
    git(['switch', '-q', 'main'])
    await writeFile(join(repo, 'm.txt'), 'main\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Main'], '2026-10-23T10:01:00Z')
    try {
      git(['merge', '-q', 'side', '-m', 'Merge branch side'], '2026-10-23T10:02:00Z')
    } catch {
      // The conflict, resolved by hand below.
    }
    await writeFile(join(repo, 'm.txt'), 'resolved\n')
    git(['add', '.'])
    git(['commit', '-q', '--no-edit'], '2026-10-23T10:03:00Z')
    git(['config', 'diff.srcPrefix', 'old/'])
    git(['config', 'diff.dstPrefix', 'new/'])
    try {
      const b = backend()
      const r = await b.resolve(env, repo)
      if (!r.ok) throw new Error(r.message)
      const res = (await b.log(env, r.root, { revs: ['--branches'], maxCount: 5 }))!
      const merge = res.commits.find(
        (x) => x.parents.length === 2 && x.subject.startsWith('Merge branch')
      )!
      expect(merge.files.map((f) => f.path)).toEqual(['m.txt'])
      const d = parsePatch((await b.show(env, r.root, merge.sha, undefined, 1024 * 1024)).text)
      expect(d.map((f) => [f.path, f.add, f.del])).toEqual([['m.txt', 1, 1]])
      const one = parsePatch((await b.show(env, r.root, merge.sha, ['m.txt'], 1024 * 1024)).text)
      expect(one.map((f) => f.path)).toEqual(['m.txt'])
    } finally {
      git(['config', '--unset', 'diff.srcPrefix'])
      git(['config', '--unset', 'diff.dstPrefix'])
    }
  })

  it('never changed the repo (same refs, no new objects in the index lock)', async () => {
    const before = git(['for-each-ref'])
    const b = backend()
    const r = await b.resolve(env, repo)
    if (r.ok) await b.log(env, r.root, { revs: ['--branches'], maxCount: 10 })
    expect(git(['for-each-ref'])).toBe(before)
    expect(git(['status', '--porcelain'])).toBe('')
  })
})

describe.runIf(hasGit())('partial clones', () => {
  let root: string
  let server: string
  let partial: string
  let head: string
  const run = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  /** Objects in the clone (loose and packed). */
  const objects = (dir: string): number =>
    run(dir, ['count-objects', '-v'])
      .split('\n')
      .filter((l) => /^(count|in-pack):/.test(l))
      .reduce((n, l) => n + Number(l.split(':')[1]), 0)
  const backend = () =>
    createRealBackend(createProcessRunner({ cwd: tmpdir() }), { exists: fileExists, wslRoots })
  const env = { kind: 'windows' as const }
  /** As a git that doesn't know GIT_NO_LAZY_FETCH (upstream 2.43 and older). */
  async function withoutNoLazyFetch(fn: () => Promise<void>): Promise<void> {
    const saved = GIT_ENV.GIT_NO_LAZY_FETCH
    delete GIT_ENV.GIT_NO_LAZY_FETCH
    try {
      await fn()
    } finally {
      GIT_ENV.GIT_NO_LAZY_FETCH = saved
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'csd-partial-'))
    await writeFile(
      join(root, 'gitconfig'),
      '[user]\n\tname = Sample\n\temail = sample@example.com\n[init]\n\tdefaultBranch = main\n'
    )
    server = join(root, 'server')
    await mkdir(server)
    run(server, ['init', '-q'])
    for (const f of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(server, `${f}.txt`), `${f}\n`)
    run(server, ['add', '.'])
    run(server, ['commit', '-q', '-m', 'One'])
    await writeFile(join(server, 'a.txt'), 'a\nmore\n')
    run(server, ['commit', '-q', '-am', 'Two'])
    run(server, ['config', 'uploadpack.allowFilter', 'true'])
    run(server, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    // A blobless clone: commits and trees only; every file's content stays on the "server".
    run(root, [
      'clone',
      '-q',
      '--no-checkout',
      '--filter=blob:none',
      pathToFileURL(server).href,
      'partial'
    ])
    partial = join(root, 'partial')
    head = run(partial, ['rev-parse', 'HEAD']).trim()
  })

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  it('are told apart from their settings, before any object is read', async () => {
    const b = backend()
    expect(await b.partialClone(env, partial)).toBe(true)
    expect(await b.partialClone(env, server)).toBe(false)
    run(server, ['config', 'remote.backup.promisor', 'false'])
    try {
      expect(await b.partialClone(env, server)).toBe(false)
      run(server, ['config', 'remote.Back Up.promisor', 'true'])
      expect(await b.partialClone(env, server)).toBe(true)
    } finally {
      run(server, ['config', '--unset', 'remote.backup.promisor'])
      run(server, ['config', '--unset', 'remote.Back Up.promisor'])
    }
    expect(await b.partialClone(env, join(root, 'gone'))).toBeUndefined()
  })

  it("a read fails instead of fetching what's missing, also with a git that ignores GIT_NO_LAZY_FETCH", async () => {
    const b = backend()
    const before = objects(partial)
    const read = async (): Promise<void> => {
      await b.log(env, partial, { revs: ['--branches'], maxCount: 10 })
      const shown = await b.show(env, partial, head, undefined, 1024 * 1024)
      expect(shown.text).not.toContain('+more')
      expect(objects(partial)).toBe(before)
    }
    await read()
    await withoutNoLazyFetch(read)
  })

  it("a remote helper the repo's own config picks never runs, whatever its name", async () => {
    // remote.origin.vcs picks the helper, and alias.remote-<name> would run as it.
    const marker = join(partial, 'pwned')
    const b = backend()
    const before = objects(partial)
    try {
      for (const name of ['none', '', '_']) {
        run(partial, ['config', 'remote.origin.vcs', name])
        try {
          run(partial, ['config', `alias.remote-${name}`, '!touch pwned; false'])
        } catch {
          // No such alias can exist (git refuses the name).
        }
        await withoutNoLazyFetch(async () => {
          await b.show(env, partial, head, undefined, 1024 * 1024)
        })
        expect(await fileExists(marker), `helper "${name}"`).toBe(false)
        expect(objects(partial)).toBe(before)
      }
      // The same read without the app's settings runs it: the checks above mean something.
      run(partial, ['config', 'remote.origin.vcs', 'none'])
      try {
        run(partial, ['cat-file', '-p', run(server, ['rev-parse', 'HEAD:b.txt']).trim()])
      } catch {
        // The "helper" ran and failed.
      }
      expect(await fileExists(marker)).toBe(true)
    } finally {
      run(partial, ['config', '--unset', 'remote.origin.vcs'])
      for (const name of ['none', ''])
        try {
          run(partial, ['config', '--unset', `alias.remote-${name}`])
        } catch {
          // Wasn't set.
        }
      await rm(marker, { force: true })
    }
    // And without the helper settings, a plain read fetches (the clone really is partial).
    run(partial, ['cat-file', '-p', run(server, ['rev-parse', 'HEAD:c.txt']).trim()])
    expect(objects(partial)).toBeGreaterThan(before)
  })
})
