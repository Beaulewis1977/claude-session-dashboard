// Git links: parsing git's output (log, refs, patches), branches from the
// commit graph, remotes, search filters, and the real read-only backend on a
// temporary repo this test makes (the test writes it; the app only reads).

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parsePatch } from '@shared/git/diff'
import { defaultBranch, labelBranches, mergeSubject, squashPr } from '@shared/git/graph'
import {
  branchName,
  githubSlug,
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
import { createProcessRunner } from '../src/main/git/runner'
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
