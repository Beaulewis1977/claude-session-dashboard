// Git links: no git command that writes can ever run. Every argument list
// goes through the read-only guard; only one module starts git or gh.

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GH_AUTH_ARGS,
  GIT_PREFIX,
  GuardError,
  assertReadOnlyGh,
  assertReadOnlyGit,
  gitArgs,
  ghPrListArgs
} from '@shared/git/guard'
import { createRealBackend } from '../src/main/git/backend'
import {
  childEnv,
  GH_ENV,
  GIT_ENV,
  wslGitArgs,
  type ProcessRunner,
  type RunOutput
} from '../src/main/git/runner'

const OK: RunOutput = {
  stdout: '',
  stderr: '',
  code: 0,
  truncated: false,
  timedOut: false,
  missing: false
}
const SHA = 'a'.repeat(40)
const dir = 'C:\\code\\acme'

/** Records every command the real backend builds, after the guard (as the runner does). */
function recorder(): { runner: ProcessRunner; git: string[][]; gh: string[][] } {
  const git: string[][] = []
  const gh: string[][] = []
  return {
    git,
    gh,
    runner: {
      async git(_env, args) {
        assertReadOnlyGit(args)
        git.push(args)
        return OK
      },
      async gh(args) {
        assertReadOnlyGh(args)
        gh.push(args)
        return { ...OK, stdout: '[]' }
      }
    }
  }
}

describe('the read-only guard', () => {
  it('accepts every command the app builds', async () => {
    const r = recorder()
    const b = createRealBackend(r.runner, { exists: async () => true, wslRoots: () => [] })
    const env = { kind: 'windows' as const }
    await b.version(env)
    await b.resolve(env, dir)
    await b.userEmail(env, dir)
    await b.remoteUrl(env, dir)
    await b.refs(env, dir)
    await b.log(env, dir, {
      revs: ['--branches', '--remotes', '--tags'],
      since: Date.UTC(2026, 0, 1),
      maxCount: 5000
    })
    await b.log(env, dir, { revs: [SHA], not: ['b'.repeat(40)], maxCount: 5000 })
    await b.show(env, dir, SHA, undefined, 1024)
    await b.show(env, dir, SHA, ['src/a b.ts', 'src/old.ts'], 1024)
    await b.ghAuth()
    await b.ghPrs('beau/acme-web', { head: 'fix/login-redirect' })
    await b.ghPrs('beau/acme-web', { search: 'abc1234' })
    expect(r.git.length).toBeGreaterThanOrEqual(10)
    expect(r.gh).toEqual([
      [...GH_AUTH_ARGS],
      ghPrListArgs('beau/acme-web', { head: 'fix/login-redirect' }),
      ghPrListArgs('beau/acme-web', { search: 'abc1234' })
    ])
    // Every git call starts with the safety settings.
    for (const args of r.git.filter((a) => a.includes('-C')))
      expect(args.slice(0, GIT_PREFIX.length)).toEqual(GIT_PREFIX)
  })

  const refusedGit: [string, string[]][] = [
    ...[
      'commit',
      'fetch',
      'pull',
      'push',
      'checkout',
      'switch',
      'restore',
      'reset',
      'gc',
      'prune',
      'repack',
      'maintenance',
      'merge',
      'rebase',
      'cherry-pick',
      'revert',
      'stash',
      'tag',
      'branch',
      'update-ref',
      'symbolic-ref',
      'notes',
      'replace',
      'clean',
      'add',
      'rm',
      'mv',
      'apply',
      'am',
      'init',
      'clone',
      'remote',
      'submodule',
      'reflog',
      'update-index',
      'read-tree',
      'write-tree',
      'commit-tree',
      'hash-object',
      'fast-import',
      'bundle',
      'archive',
      'lfs',
      'filter-branch',
      'status',
      'diff',
      'gui',
      'daemon'
    ].map((cmd): [string, string[]] => [cmd, gitArgs(dir, [cmd])]),
    ['config set', gitArgs(dir, ['config', 'user.email', 'x@y'])],
    ['config --unset', gitArgs(dir, ['config', '--unset', 'user.email'])],
    ['config --get of another key', gitArgs(dir, ['config', '--get', 'core.sshCommand'])],
    ['worktree add', gitArgs(dir, ['worktree', 'add', 'x'])],
    ['worktree prune', gitArgs(dir, ['worktree', 'prune'])],
    ['log --output', gitArgs(dir, ['log', '--no-ext-diff', '--no-textconv', '--output=C:\\x.txt'])],
    ['log without --no-ext-diff', gitArgs(dir, ['log', '--no-textconv', '--numstat'])],
    [
      'log with an external diff',
      gitArgs(dir, ['log', '--no-ext-diff', '--no-textconv', '--ext-diff'])
    ],
    [
      'log with a ref option value',
      gitArgs(dir, ['log', '--no-ext-diff', '--no-textconv', '--exec=sh'])
    ],
    [
      'log with a made-up format',
      gitArgs(dir, ['log', '--no-ext-diff', '--no-textconv', '--format=%H'])
    ],
    [
      'show without a commit',
      gitArgs(dir, ['show', '--format=', '--no-ext-diff', '--no-textconv'])
    ],
    [
      'show with two commits',
      gitArgs(dir, ['show', '--format=', '--no-ext-diff', '--no-textconv', SHA, SHA])
    ],
    [
      'show of a ref name',
      gitArgs(dir, ['show', '--format=', '--no-ext-diff', '--no-textconv', 'HEAD'])
    ],
    [
      'show with pathspec magic',
      gitArgs(dir, [
        'show',
        '--format=',
        '--no-ext-diff',
        '--no-textconv',
        SHA,
        '--',
        ':(exclude)x'
      ])
    ],
    ['an alias as config', ['-c', 'alias.log=!rm -rf /', '-C', dir, 'log']],
    [
      'fsmonitor turned on',
      ['-c', 'core.fsmonitor=evil.exe', '-C', dir, 'rev-parse', '--show-toplevel']
    ],
    ['another git dir', ['--git-dir=C:\\x', '-C', dir, 'rev-parse', '--show-toplevel']],
    ['exec path', ['--exec-path=C:\\x', '-C', dir, 'version']],
    ['no folder', ['--no-pager', 'rev-parse', '--show-toplevel']],
    ['a folder that looks like an option', ['-C', '--output=x', 'rev-parse', '--show-toplevel']],
    ['nothing', []]
  ]

  it.each(refusedGit)('refuses git %s', (_name, args) => {
    expect(() => assertReadOnlyGit(args)).toThrow(GuardError)
  })

  const refusedGh: [string, string[]][] = [
    ['gh api', ['api', 'repos/beau/acme/pulls']],
    ['gh api -X POST', ['api', '-X', 'POST', 'repos/beau/acme/issues']],
    ['pr create', ['pr', 'create', '--fill']],
    ['pr merge', ['pr', 'merge', '14']],
    ['pr checkout', ['pr', 'checkout', '14']],
    ['repo clone', ['repo', 'clone', 'beau/acme']],
    ['auth login', ['auth', 'login']],
    ['auth token', ['auth', 'token']],
    ['another host', ['auth', 'status', '--hostname', 'evil.example.com']],
    ['a bad repo', ghPrListArgs('beau/acme web', { head: 'x' })],
    ['a branch like an option', ghPrListArgs('beau/acme', { head: '--web' })],
    ['a branch with ..', ghPrListArgs('beau/acme', { head: 'a..b' })],
    ['a search that is not a SHA', ghPrListArgs('beau/acme', { search: 'is:open author:me' })],
    ['a big limit', ghPrListArgs('beau/acme', { head: 'x' }, 1000)],
    ['an extra flag', [...ghPrListArgs('beau/acme', { head: 'x' }), '--web']],
    [
      'other fields',
      [
        'pr',
        'list',
        '--repo',
        'beau/acme',
        '--state',
        'all',
        '--limit',
        '20',
        '--json',
        'body',
        '--head',
        'x'
      ]
    ]
  ]

  it.each(refusedGh)('refuses %s', (_name, args) => {
    expect(() => assertReadOnlyGh(args)).toThrow(GuardError)
  })
})

describe('the processes', () => {
  it("drops the app's own GIT_* and gh host variables", () => {
    const env = childEnv(
      {
        PATH: 'x',
        GIT_DIR: 'C:\\elsewhere',
        git_work_tree: 'y',
        GH_HOST: 'evil',
        GH_REPO: 'a/b',
        GH_TOKEN: 't'
      },
      GIT_ENV
    )
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.git_work_tree).toBeUndefined()
    expect(env.GH_HOST).toBeUndefined()
    expect(env.GH_REPO).toBeUndefined()
    expect(env.GH_TOKEN).toBe('t')
    expect(env).toMatchObject({
      PATH: 'x',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      // A partial clone never fetches (and writes) a missing object for a read, also
      // with a git that ignores GIT_NO_LAZY_FETCH: no transport is allowed.
      GIT_NO_LAZY_FETCH: '1',
      GIT_ALLOW_PROTOCOL: 'none'
    })
    // No automatic maintenance or gc on any call.
    expect(GIT_PREFIX).toEqual(expect.arrayContaining(['maintenance.auto=false', 'gc.auto=0']))
    expect(GH_ENV.GH_NO_UPDATE_NOTIFIER).toBe('1')
  })

  it("runs a WSL repo's git through wsl.exe without a shell, as the home's user", () => {
    expect(
      wslGitArgs({ kind: 'wsl', distro: 'Ubuntu-24.04', user: 'beau' }, ['--no-pager', 'version'])
    ).toEqual([
      '-d',
      'Ubuntu-24.04',
      '-u',
      'beau',
      '-e',
      'env',
      'GIT_OPTIONAL_LOCKS=0',
      'GIT_TERMINAL_PROMPT=0',
      'GIT_LITERAL_PATHSPECS=1',
      'GIT_NO_LAZY_FETCH=1',
      'GIT_ALLOW_PROTOCOL=none',
      'LC_ALL=C',
      'git',
      '--no-pager',
      'version'
    ])
    expect(() => wslGitArgs({ kind: 'wsl', distro: 'Ubuntu; rm -rf /' }, [])).toThrow()
    expect(() => wslGitArgs({ kind: 'wsl', distro: 'Ubuntu', user: '-u root' }, [])).toThrow()
  })
})

describe('only one module starts git or gh', () => {
  async function files(root: string): Promise<string[]> {
    const out: string[] = []
    for (const e of await readdir(root, { withFileTypes: true })) {
      const p = join(root, e.name)
      if (e.isDirectory()) out.push(...(await files(p)))
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('no other module that can start processes names git or gh', async () => {
    const src = join(__dirname, '..', 'src')
    const offenders: string[] = []
    let starters = 0
    for (const f of await files(src)) {
      const rel = relative(src, f).replace(/\\/g, '/')
      if (rel === 'main/git/runner.ts') continue
      const text = await readFile(f, 'utf8')
      if (!/from ['"](?:node:)?child_process['"]/.test(text)) continue
      starters++
      // Git Bash's path is found from git.exe's (Claude Code runs status lines with it); git itself isn't run.
      const rest = text.replace(/findOnPath\('git', \['\.exe'\]\)/g, '')
      if (/['"`](?:git|gh)(?:\.exe)?['"`]/.test(rest)) offenders.push(rel)
    }
    expect(starters).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  it('the runner checks every git and gh call with the guard', async () => {
    const runner = await readFile(join(__dirname, '..', 'src', 'main', 'git', 'runner.ts'), 'utf8')
    expect(runner).toMatch(/async git\(env, args, o = \{\}\) \{\s+assertReadOnlyGit\(args\)/)
    expect(runner).toMatch(/async gh\(args, o = \{\}\) \{\s+assertReadOnlyGh\(args\)/)
    expect(runner).not.toMatch(/shell:\s*true/)
  })
})
