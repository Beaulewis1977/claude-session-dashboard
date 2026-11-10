// Fixtures mode: sample repos from fixtures/git/repos.json instead of git
// and gh, so `npm run dev -- --fixtures` shows the Changes tab anywhere.
// Nothing is ever started.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RefTip } from '@shared/git/log'
import type { GhPr } from '@shared/git/prs'
import type { CommitInfo } from '@shared/git/types'
import type { GitBackend } from './backend'
import { envKey, type GitEnv } from './runner'

interface FixtureCommit {
  sha: string
  parents: string[]
  email: string
  at: string
  subject: string
  trailers?: string[]
  files: { path: string; from?: string; add?: number; del?: number }[]
}

interface FixtureRepo {
  /** "windows" or "wsl:<distro>". */
  env: string
  root: string
  remote?: string
  userEmail?: string
  refs: RefTip[]
  commits: FixtureCommit[]
  patches?: Record<string, string>
}

interface FixtureFile {
  repos: FixtureRepo[]
  gh?: { auth?: 'ok' | 'signed-out' | 'missing'; prs?: Record<string, GhPr[]> }
}

const norm = (p: string, ci: boolean): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return ci ? s.toLowerCase() : s
}

export async function createFixturesBackend(fixturesDir: string): Promise<GitBackend> {
  let data: FixtureFile = { repos: [] }
  try {
    data = JSON.parse(await readFile(join(fixturesDir, 'git', 'repos.json'), 'utf8')) as FixtureFile
  } catch {
    // No sample repos: every folder reads as "not a repository".
  }
  const keyOf = (env: GitEnv): string => (env.kind === 'windows' ? 'windows' : `wsl:${env.distro}`)
  const repoAt = (env: GitEnv, dir: string): FixtureRepo | undefined => {
    const ci = env.kind === 'windows'
    const d = norm(dir, ci)
    return data.repos.find((r) => {
      if (r.env !== keyOf(env)) return false
      const root = norm(r.root, ci)
      return d === root || d.startsWith(`${root}/`)
    })
  }
  const commitsOf = (r: FixtureRepo): CommitInfo[] =>
    r.commits.map((c) => ({
      sha: c.sha,
      parents: c.parents,
      authorEmail: c.email,
      committerEmail: c.email,
      at: Date.parse(c.at),
      ct: Date.parse(c.at),
      subject: c.subject,
      trailers: c.trailers ?? [],
      files: c.files.map((f) => ({ ...f })),
      branches: []
    }))
  return {
    async version(env) {
      return { version: `2.51.0 (sample data, ${envKey(env)})` }
    },
    async resolve(env, dir) {
      if (/old-prototype/i.test(dir))
        return { ok: false, status: 'missing', message: 'The folder no longer exists.' }
      const r = repoAt(env, dir)
      if (!r)
        return { ok: false, status: 'not-repo', message: "This folder isn't in a git repository." }
      return { ok: true, root: r.root, commonDir: `${r.root}/.git`, gitDir: `${r.root}/.git` }
    },
    async exists(_env, dir) {
      return !/old-prototype/i.test(dir)
    },
    async partialClone(env, root) {
      return repoAt(env, root) ? false : undefined
    },
    async userEmail(env, root) {
      return repoAt(env, root)?.userEmail
    },
    async remoteUrl(env, root) {
      return repoAt(env, root)?.remote
    },
    async refs(env, root) {
      return repoAt(env, root)?.refs.map((r) => ({ ...r }))
    },
    async log(env, root, o) {
      const r = repoAt(env, root)
      if (!r) return undefined
      const commits = commitsOf(r).filter((c) => o.since === undefined || c.ct >= o.since)
      return { commits: commits.slice(0, o.maxCount), truncated: commits.length > o.maxCount }
    },
    async show(env, root, sha, paths) {
      const r = repoAt(env, root)
      const text = r?.patches?.[sha]
      if (text === undefined)
        return { text: '', truncated: false, error: 'No sample diff for this commit.' }
      if (!paths?.length) return { text, truncated: false }
      // Only the asked files' parts of the sample patch.
      const parts = text
        .split(/(?=^diff --git )/m)
        .filter((p) => paths.some((x) => p.includes(` b/${x}`)))
      return { text: parts.join(''), truncated: false }
    },
    async ghAuth() {
      return data.gh?.auth ?? 'ok'
    },
    async ghPrs(slug, by) {
      const all = data.gh?.prs?.[slug] ?? []
      return 'head' in by ? all.filter((p) => p.headRefName === by.head) : []
    }
  }
}
