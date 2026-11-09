// The git and gh calls the git links service makes, all read-only (see
// @shared/git/guard and ./runner). Fixtures mode swaps in ./fixtures.

import { posix, win32 } from 'node:path'
import { DIFF_MERGES, GH_AUTH_ARGS, gitArgs, ghPrListArgs } from '@shared/git/guard'
import {
  LOG_FORMAT,
  REF_FORMAT,
  parseLog,
  parseRefs,
  parseRevParse,
  type RefTip
} from '@shared/git/log'
import type { GhPr } from '@shared/git/prs'
import type { CommitInfo, GitFolderStatus } from '@shared/git/types'
import type { GitEnv, ProcessRunner, RunOutput } from './runner'

export type ResolveResult =
  | { ok: true; root: string; commonDir: string; gitDir: string }
  | {
      ok: false
      status: Exclude<GitFolderStatus, 'ok' | 'no-folder' | 'distro-stopped'>
      message: string
    }

export interface LogOptions {
  /** Revisions: `--branches --remotes --tags HEAD`, or the tips to read from. */
  revs: string[]
  /** Tips read before (only what's new since is read). */
  not?: string[]
  /** Only commits after this time (epoch ms). */
  since?: number
  maxCount: number
}

export interface LogResult {
  commits: CommitInfo[]
  /** Stopped at maxCount or the size cap. */
  truncated: boolean
}

export interface ShowResult {
  text: string
  truncated: boolean
  error?: string
}

export type GhAuth = 'ok' | 'signed-out' | 'missing'

export interface GitBackend {
  version(env: GitEnv): Promise<{ version?: string; error?: string }>
  resolve(env: GitEnv, dir: string): Promise<ResolveResult>
  /** Does this folder exist? (WSL: asked through its \\wsl.localhost path; undefined = can't tell.) */
  exists(env: GitEnv, dir: string): Promise<boolean | undefined>
  userEmail(env: GitEnv, root: string): Promise<string | undefined>
  remoteUrl(env: GitEnv, root: string): Promise<string | undefined>
  refs(env: GitEnv, root: string): Promise<RefTip[] | undefined>
  log(env: GitEnv, root: string, opts: LogOptions): Promise<LogResult | undefined>
  show(
    env: GitEnv,
    root: string,
    sha: string,
    paths: string[] | undefined,
    maxBytes: number
  ): Promise<ShowResult>
  ghAuth(): Promise<GhAuth>
  ghPrs(slug: string, by: { head: string } | { search: string }): Promise<GhPr[] | undefined>
}

const LOG_MAX_BYTES = 64 * 1024 * 1024

/** Why git refused or failed, from its message. */
export function classifyGitError(r: RunOutput): Extract<ResolveResult, { ok: false }> {
  const msg = (r.stderr || r.stdout).trim()
  if (r.missing) return { ok: false, status: 'no-git', message: "Git wasn't found." }
  if (/env: '?git'?: No such file|git: (?:command )?not found/i.test(msg))
    return { ok: false, status: 'no-git', message: "Git isn't installed in this WSL distro." }
  if (/dubious ownership|safe\.directory/i.test(msg))
    return {
      ok: false,
      status: 'untrusted',
      message:
        "Git doesn't trust this folder (it belongs to another user). The app won't override that; you can add it to safe.directory yourself."
    }
  if (/cannot change to|No such file or directory|does not exist/i.test(msg))
    return { ok: false, status: 'missing', message: 'The folder no longer exists.' }
  if (/not a git repository|must be run in a work tree/i.test(msg))
    return { ok: false, status: 'not-repo', message: "This folder isn't in a git repository." }
  if (r.timedOut) return { ok: false, status: 'error', message: 'Git took too long to answer.' }
  return { ok: false, status: 'error', message: msg.split('\n')[0]?.slice(0, 300) || 'Git failed.' }
}

export function createRealBackend(
  runner: ProcessRunner,
  fs: { exists(p: string): Promise<boolean>; wslRoots(distro: string): string[] }
): GitBackend {
  const git = (
    env: GitEnv,
    dir: string,
    sub: string[],
    opts?: { timeoutMs?: number; maxBytes?: number }
  ) => runner.git(env, gitArgs(dir, sub), opts)
  const ok = (r: RunOutput): boolean => r.code === 0 && !r.timedOut && !r.missing

  return {
    async version(env) {
      const r = await runner.git(env, ['--no-pager', 'version'], { timeoutMs: 20_000 })
      if (ok(r)) return { version: r.stdout.trim().replace(/^git version\s*/, '') }
      return { error: classifyGitError(r).message }
    },
    async resolve(env, dir) {
      const r = await git(
        env,
        dir,
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
        { timeoutMs: 20_000 }
      )
      if (ok(r)) {
        const p = parseRevParse(r.stdout)
        if (p) return { ok: true, ...p }
      }
      // git before 2.31 has no --path-format: relative folders are then resolved here.
      if (/path-format/i.test(r.stderr)) {
        const r2 = await git(
          env,
          dir,
          ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'],
          { timeoutMs: 20_000 }
        )
        const p = ok(r2) ? parseRevParse(r2.stdout) : undefined
        if (p) {
          const path = env.kind === 'windows' ? win32 : posix
          return {
            ok: true,
            root: p.root,
            commonDir: path.resolve(dir, p.commonDir),
            gitDir: path.resolve(dir, p.gitDir)
          }
        }
        return classifyGitError(r2)
      }
      return classifyGitError(r)
    },
    async exists(env, dir) {
      if (env.kind === 'windows') return fs.exists(dir)
      for (const root of fs.wslRoots(env.distro)) {
        if (!(await fs.exists(root))) continue
        return fs.exists(root + dir.replace(/\//g, '\\'))
      }
      return undefined
    },
    async userEmail(env, root) {
      const r = await git(env, root, ['config', '--get', 'user.email'], { timeoutMs: 15_000 })
      return ok(r) ? r.stdout.trim() || undefined : undefined
    },
    async remoteUrl(env, root) {
      const r = await git(env, root, ['config', '--get', 'remote.origin.url'], {
        timeoutMs: 15_000
      })
      if (ok(r) && r.stdout.trim()) return r.stdout.trim()
      const all = await git(env, root, ['config', '--get-regexp', '^remote\\..*\\.url$'], {
        timeoutMs: 15_000
      })
      const first = ok(all) ? all.stdout.split('\n')[0]?.trim().split(/\s+/)[1] : undefined
      return first || undefined
    },
    async refs(env, root) {
      const r = await git(
        env,
        root,
        ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'],
        { timeoutMs: 30_000 }
      )
      return ok(r) ? parseRefs(r.stdout) : undefined
    },
    async log(env, root, o) {
      const args = [
        'log',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-M',
        '--date-order',
        DIFF_MERGES,
        `--format=${LOG_FORMAT}`,
        `--max-count=${o.maxCount}`,
        ...(o.since !== undefined
          ? [`--since=${new Date(o.since).toISOString().replace(/\.\d{3}Z$/, 'Z')}`]
          : []),
        ...(o.not?.length ? ['--ignore-missing'] : []),
        ...o.revs,
        ...(o.not?.length ? ['--not', ...o.not] : [])
      ]
      let r = await git(env, root, args, { timeoutMs: 120_000, maxBytes: LOG_MAX_BYTES })
      // git before 2.31 has no --diff-merges (its merges then list no files).
      if (!ok(r) && !r.stdout && /diff-merges/.test(r.stderr))
        r = await git(
          env,
          root,
          args.filter((a) => a !== DIFF_MERGES),
          { timeoutMs: 120_000, maxBytes: LOG_MAX_BYTES }
        )
      if (!(ok(r) || (r.truncated && r.stdout))) return undefined
      const commits = parseLog(r.stdout)
      // A cut record at the end is dropped by the parser; the rest is kept.
      return { commits, truncated: r.truncated || commits.length >= o.maxCount }
    },
    async show(env, root, sha, paths, maxBytes) {
      // The prefixes the parser expects, whatever diff.srcPrefix / noprefix say; a
      // merge compared with its first parent (a combined diff isn't readable here).
      const args = [
        'show',
        '--format=',
        '--patch',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        DIFF_MERGES,
        '--src-prefix=a/',
        '--dst-prefix=b/',
        sha,
        ...(paths?.length ? ['--', ...paths] : [])
      ]
      let r = await git(env, root, args, { timeoutMs: 60_000, maxBytes })
      if (!ok(r) && !r.stdout && /diff-merges/.test(r.stderr))
        r = await git(
          env,
          root,
          args.filter((a) => a !== DIFF_MERGES),
          { timeoutMs: 60_000, maxBytes }
        )
      if (ok(r) || (r.truncated && r.stdout)) return { text: r.stdout, truncated: r.truncated }
      return { text: '', truncated: false, error: classifyGitError(r).message }
    },
    async ghAuth() {
      const r = await runner.gh([...GH_AUTH_ARGS], { timeoutMs: 30_000, maxBytes: 64 * 1024 })
      if (r.missing) return 'missing'
      return r.code === 0 ? 'ok' : 'signed-out'
    },
    async ghPrs(slug, by) {
      const r = await runner.gh(ghPrListArgs(slug, by), {
        timeoutMs: 45_000,
        maxBytes: 4 * 1024 * 1024
      })
      if (!ok(r)) return undefined
      try {
        const v = JSON.parse(r.stdout) as unknown
        if (!Array.isArray(v)) return undefined
        return v
          .filter(
            (p): p is GhPr =>
              !!p &&
              typeof p === 'object' &&
              typeof (p as GhPr).number === 'number' &&
              typeof (p as GhPr).url === 'string' &&
              typeof (p as GhPr).headRefName === 'string'
          )
          .map((p) => ({
            number: p.number,
            title: String(p.title ?? '').slice(0, 300),
            url: p.url,
            state: String(p.state ?? ''),
            isDraft: p.isDraft === true,
            headRefName: p.headRefName
          }))
      } catch {
        return undefined
      }
    }
  }
}
