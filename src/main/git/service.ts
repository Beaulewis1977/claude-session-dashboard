// Git links (docs/ROADMAP.md, feature 6): which commits, branches and pull
// requests each session produced, read from git and gh, read-only.
//
// - Runs in the main process, in the background, after the startup scan;
//   git and gh run as separate processes (see ./runner), never blocking the
//   window. Long loops make room for other work (breathe()).
// - Each repo is read once for all its sessions (worktrees share one), only
//   for the time its sessions cover. Later passes compare the branch tips
//   first (one quick `for-each-ref`) and read only new commits.
// - Matching is pure (@shared/git/match), so a pass with no new commits needs
//   no git at all.
// - Results are cached in the app's cache folder (never backed up); my
//   unlinks are in metadata.json. Nothing is ever written to a repo.

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { now } from '@shared/clock'
import { parsePatch } from '@shared/git/diff'
import { labelBranches, defaultBranch } from '@shared/git/graph'
import { githubSlug, normalizeRemote, type RefTip } from '@shared/git/log'
import { matchRepo, normPath, relativeTo, repoFile, type MatchSession } from '@shared/git/match'
import { gitBadge, sessionPrs, type GhPr } from '@shared/git/prs'
import { pathMatches, type GitQuery } from '@shared/git/query'
import {
  LEVEL_RANK,
  type CommitDiff,
  type CommitInfo,
  type CommitLink,
  type CommitView,
  type GhState,
  type GitBadge,
  type GitFolderStatus,
  type GitLinkSettings,
  type GitStatus,
  type PrLink,
  type SessionGitSignals,
  type SessionGitView
} from '@shared/git/types'
import { breathe } from '../core/breathe'
import { writeFileAtomic } from '../core/json-store'
import type { Platform } from '../platform'
import type { GitInput } from '../services/sessions'
import type { GhAuth, GitBackend } from './backend'
import { placeKey, placeSession, type PlaceContext } from './place'
import { envKey, envLabel, type GitEnv } from './runner'

const CACHE_VERSION = 1
/** Commits read per repo at most (older ones aren't read; exact matches still are). */
export const MAX_COMMITS = 5000
/** Read from this long before a repo's earliest session. */
const WINDOW_SLACK_MS = 24 * 3600_000
/** A folder that wasn't a repo, or was gone, is checked again after this. */
const RECHECK_MS = 6 * 3600_000
/** The Changes tab refreshes its repo when it was checked longer ago than this. */
const FRESH_MS = 60_000
/** gh: merged or closed PRs are kept a week, the rest an hour. */
const GH_DONE_TTL = 7 * 24 * 3600_000
const GH_OPEN_TTL = 3600_000
/** gh calls per background pass (more on the next pass; a tab asks for its own). */
const GH_PER_PASS = 20
const DIFF_BYTES = 1024 * 1024
const DIFF_BYTES_ALL = 8 * 1024 * 1024
const EMPTY_SIGNALS: SessionGitSignals = { branches: [], files: [], commits: [], prs: [], spans: [], sessionUrls: [] }

interface FolderState {
  status: GitFolderStatus
  message?: string
  env?: GitEnv
  repoKey?: string
  /** The session's worktree root (or its own folder when that's gone), normalised. */
  root?: string
  cwdRel?: string
  note?: string
  at: number
}

interface RepoState {
  key: string
  env: GitEnv
  root: string
  remote?: string
  github?: string
  userEmail?: string
  emailRead?: boolean
  refs: RefTip[]
  /** The window read so far (epoch ms); undefined: not read yet. */
  since?: number
  commits: Map<string, CommitInfo>
  truncated: boolean
  checkedAt: number
  error?: string
}

interface Computed {
  repoKey?: string
  status: GitFolderStatus
  message?: string
  links: CommitLink[]
  prs: PrLink[]
  badge?: GitBadge
  /** Repo-relative (or normalised) files it edited, and its linked commits' files: for `touched:`. */
  touched: string[]
}

interface GhEntry {
  at: number
  prs: GhPr[]
}

interface CacheFile {
  version: number
  folders: [string, FolderState][]
  repos: (Omit<RepoState, 'commits'> & { commits: CommitInfo[] })[]
  gh: [string, GhEntry][]
}

export interface GitServiceDeps {
  sessions: {
    gitInputs(): GitInput[]
    gitUnlinked(key: string): string[]
    setGitUnlinked(key: string, shas: string[]): boolean
    on(event: 'changed', fn: () => void): unknown
    touch(): void
  }
  backend: GitBackend
  platform: Pick<Platform, 'listRunningDistros' | 'defaultDistro' | 'wslWindowsPath'>
  dataDir: string
  settings: () => { git: GitLinkSettings; scanStoppedDistros: boolean }
}

/** A remote URL without credentials (`https://user:token@host/…` → `https://host/…`). */
export function safeRemote(url: string | undefined): string | undefined {
  return url?.replace(/^([a-z+]+:\/\/)[^@/]+@/i, '$1')
}

export class GitLinksService extends EventEmitter<{ changed: [] }> {
  private folders = new Map<string, FolderState>()
  private repos = new Map<string, RepoState>()
  private computed = new Map<string, Computed>()
  private inputs = new Map<string, GitInput>()
  private gh = new Map<string, GhEntry>()
  private ghAuth?: { state: GhAuth; at: number }
  private busy = new Set<string>()
  private running: Promise<void> = Promise.resolve()
  private pending: { force: boolean; repos?: Set<string> } | undefined
  private passScheduled = false
  private debounce: NodeJS.Timeout | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private lastRevs = new Map<string, string>()
  private started = false
  private checkedAt?: number
  private versions = new Map<string, { version?: string; error?: string }>()

  constructor(private readonly deps: GitServiceDeps) {
    super()
  }

  private get cacheFile(): string {
    return join(this.deps.dataDir, 'cache', `git-links-v${CACHE_VERSION}.json`)
  }

  private cfg(): GitLinkSettings {
    return this.deps.settings().git
  }

  // ---------------------------------------------------------------- start

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.loadCache()
    this.deps.sessions.on('changed', () => this.onSessionsChanged())
    this.schedule({ force: false })
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.cacheFile, 'utf8')) as CacheFile
      if (raw.version !== CACHE_VERSION) return
      this.folders = new Map(raw.folders)
      for (const r of raw.repos)
        this.repos.set(r.key, { ...r, commits: new Map(r.commits.map((c) => [c.sha, c])) })
      this.gh = new Map(raw.gh)
    } catch {
      // No cache yet: the first pass reads everything.
    }
  }

  private saveSoon(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => void this.flush(), 10_000)
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    const data: CacheFile = {
      version: CACHE_VERSION,
      folders: [...this.folders],
      repos: [...this.repos.values()].map((r) => ({ ...r, commits: [...r.commits.values()] })),
      gh: [...this.gh]
    }
    try {
      await writeFileAtomic(this.cacheFile, JSON.stringify(data), this.deps.dataDir)
    } catch (err) {
      console.warn('could not write the git links cache', err)
    }
  }

  /** Sessions changed: the repos of the ones that grew are checked again (after a pause). */
  private onSessionsChanged(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      const repos = new Set<string>()
      let unknown = false
      for (const i of this.deps.sessions.gitInputs()) {
        if (this.lastRevs.get(i.key) === i.rev) continue
        const fk = this.folders.get(placeKey(i))
        if (fk?.repoKey) repos.add(fk.repoKey)
        else unknown = true
      }
      if (repos.size || unknown) this.schedule({ force: false, repos: unknown ? undefined : repos })
    }, 20_000)
  }

  /** Settings changed (on/off, gh): a pass with the new settings. */
  settingsChanged(): void {
    this.ghAuth = undefined
    this.schedule({ force: false })
  }

  /** Queue a pass (one runs at a time; requests made meanwhile are merged into the next). */
  schedule(opts: { force: boolean; repos?: Set<string> }): Promise<void> {
    if (this.pending) {
      this.pending.force ||= opts.force
      if (!opts.repos || !this.pending.repos) this.pending.repos = undefined
      else for (const r of opts.repos) this.pending.repos.add(r)
    } else this.pending = { ...opts, repos: opts.repos ? new Set(opts.repos) : undefined }
    if (this.passScheduled) return this.running
    this.passScheduled = true
    this.running = this.running.then(async () => {
      this.passScheduled = false
      const p = this.pending
      this.pending = undefined
      if (p) await this.pass(p).catch((err: unknown) => console.warn('git links pass failed', err))
    })
    return this.running
  }

  // ----------------------------------------------------------------- pass

  private async context(): Promise<PlaceContext> {
    const { platform } = this.deps
    const [running, def] = await Promise.all([
      platform.listRunningDistros().catch(() => undefined),
      platform.defaultDistro?.().catch(() => undefined)
    ])
    return { platform, running, defaultDistro: def, scanStopped: this.deps.settings().scanStoppedDistros }
  }

  private async pass(opts: { force: boolean; repos?: Set<string> }): Promise<void> {
    if (!this.cfg().enabled) {
      this.computed.clear()
      this.emitChanged()
      return
    }
    const inputs = this.deps.sessions.gitInputs()
    this.inputs = new Map(inputs.map((i) => [i.key, i]))
    const ctx = await this.context()
    const t = now()

    // 1. Each session's folder: which repo (once per folder; re-checked when stale).
    const byFolder = new Map<string, GitInput[]>()
    for (const i of inputs) {
      const fk = placeKey(i)
      byFolder.set(fk, [...(byFolder.get(fk) ?? []), i])
    }
    for (const [fk, list] of byFolder) {
      const f = this.folders.get(fk)
      const stale =
        !f ||
        (opts.force && !opts.repos) ||
        (f.status !== 'ok' && t - f.at > RECHECK_MS) ||
        f.status === 'distro-stopped' ||
        (f.status === 'ok' && !!f.repoKey && !this.repos.has(f.repoKey))
      if (stale) this.folders.set(fk, await this.resolveFolder(list[0], ctx))
      await breathe()
    }

    // 2. Group by repo.
    const byRepo = new Map<string, GitInput[]>()
    for (const i of inputs) {
      const f = this.folders.get(placeKey(i))
      if (f?.status === 'ok' && f.repoKey) byRepo.set(f.repoKey, [...(byRepo.get(f.repoKey) ?? []), i])
      else this.computeWithoutRepo(i, f)
    }

    // 3. Each repo: new commits (if its tips moved), then matching.
    let ghCalls = 0
    for (const [rk, list] of byRepo) {
      const repo = this.repos.get(rk)
      if (!repo) continue
      if (!opts.repos || opts.repos.has(rk)) {
        this.busy.add(rk)
        try {
          await this.refreshRepo(repo, list, opts.force)
        } finally {
          this.busy.delete(rk)
        }
      }
      ghCalls += await this.ghLookups(repo, list, GH_PER_PASS - ghCalls)
      this.computeRepo(repo, list)
      await breathe()
    }
    for (const i of inputs) this.lastRevs.set(i.key, i.rev)
    for (const k of [...this.computed.keys()]) if (!this.inputs.has(k)) this.computed.delete(k)
    this.checkedAt = now()
    this.saveSoon()
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit('changed')
    // The session list's badges.
    this.deps.sessions.touch()
  }

  private async resolveFolder(i: GitInput, ctx: PlaceContext): Promise<FolderState> {
    const at = now()
    const pl = await placeSession(i, ctx)
    if (!pl.ok) return { status: pl.status, message: pl.message, at }
    const { backend } = this.deps
    const ci = pl.env.kind === 'windows'
    let r = await backend.resolve(pl.env, pl.dir)
    let note: string | undefined
    let ownRoot: string | undefined
    if (!r.ok && r.status === 'missing') {
      // The folder is gone (e.g. a worktree removed after merging): the repo that held it.
      const parent = await this.nearestParent(pl.env, pl.dir)
      if (parent) {
        const r2 = await backend.resolve(pl.env, parent)
        if (r2.ok && relativeTo(normPath(pl.dir), normPath(r2.root), ci) !== undefined) {
          r = r2
          ownRoot = normPath(pl.dir)
          note = "This session's folder no longer exists; its commits were looked up in the repo that held it."
        }
      }
      // A Codex session's recorded remote: another local clone of the same repo.
      const remote = normalizeRemote(i.signals?.remote)
      if (!r.ok && remote) {
        const other = [...this.repos.values()].find(
          (x) => envKey(x.env) === envKey(pl.env) && normalizeRemote(x.remote) === remote
        )
        if (other) {
          const r3 = await backend.resolve(other.env, other.root)
          if (r3.ok) {
            r = r3
            ownRoot = normPath(pl.dir)
            note = "This session's folder no longer exists; its commits were looked up in another clone of the same repo."
          }
        }
      }
    }
    if (!r.ok) return { status: r.status, message: r.message, env: pl.env, at }
    const common = normPath(r.commonDir)
    const repoKey = `${envKey(pl.env)}|${ci ? common.toLowerCase() : common}`
    if (!this.repos.has(repoKey))
      this.repos.set(repoKey, { key: repoKey, env: pl.env, root: r.root, refs: [], commits: new Map(), truncated: false, checkedAt: 0 })
    const root = ownRoot ?? normPath(r.root)
    const cwdRel = ownRoot ? '' : (relativeTo(normPath(pl.dir), root, ci) ?? '')
    return { status: 'ok', env: pl.env, repoKey, root, cwdRel, ...(note ? { note } : {}), at }
  }

  private async nearestParent(env: GitEnv, dir: string): Promise<string | undefined> {
    const sep = env.kind === 'windows' ? /[\\/]+/ : /\/+/
    const parts = dir.split(sep).filter(Boolean)
    for (let n = parts.length - 1; n >= 1 && parts.length - n <= 8; n--) {
      const p =
        env.kind === 'windows'
          ? (dir.startsWith('\\\\') ? '\\\\' : '') + parts.slice(0, n).join('\\') + (n === 1 && !dir.startsWith('\\\\') ? '\\' : '')
          : '/' + parts.slice(0, n).join('/')
      if (await this.deps.backend.exists(env, p)) return p
    }
    return undefined
  }

  private async refreshRepo(repo: RepoState, sessions: GitInput[], force: boolean): Promise<void> {
    const { backend } = this.deps
    const starts = sessions.map((s) => s.signals?.spans[0]?.[0]).filter((x): x is number => x !== undefined)
    const need = (starts.length ? Math.min(...starts) : now()) - WINDOW_SLACK_MS
    const refs = await backend.refs(repo.env, repo.root)
    if (!refs) {
      repo.error = "Couldn't read this repo's branches."
      return
    }
    repo.error = undefined
    if (repo.remote === undefined || force) {
      repo.remote = await backend.remoteUrl(repo.env, repo.root)
      repo.github = githubSlug(repo.remote)
    }
    if (!repo.emailRead || force) {
      repo.userEmail = await backend.userEmail(repo.env, repo.root)
      repo.emailRead = true
    }
    const tips = [...new Set(refs.map((r) => r.sha))]
    const old = new Set(repo.refs.map((r) => r.sha))
    const widen = repo.since === undefined || need < repo.since
    const same = tips.length === old.size && tips.every((s) => old.has(s))
    repo.checkedAt = now()
    if (!widen && same && !force) {
      repo.refs = refs
      return
    }
    if (!widen && !force && old.size && tips.length + old.size <= 400) {
      const fresh = tips.filter((s) => !old.has(s))
      if (fresh.length) {
        const res = await backend.log(repo.env, repo.root, { revs: fresh, not: [...old], maxCount: MAX_COMMITS })
        if (!res) {
          repo.error = "Couldn't read this repo's new commits."
          return
        }
        for (const c of res.commits) repo.commits.set(c.sha, c)
        repo.truncated ||= res.truncated
      }
    } else {
      const res = await backend.log(repo.env, repo.root, {
        revs: ['--branches', '--remotes', '--tags'],
        since: need,
        maxCount: MAX_COMMITS
      })
      if (!res) {
        repo.error = "Couldn't read this repo's history."
        return
      }
      repo.commits = new Map(res.commits.map((c) => [c.sha, c]))
      repo.since = need
      repo.truncated = res.truncated
    }
    repo.refs = refs
    for (const c of repo.commits.values()) {
      c.branches = []
      delete c.pr
    }
    labelBranches(repo.commits, refs)
  }

  private matchSessions(repo: RepoState, list: GitInput[]): MatchSession[] {
    return list.map((i) => {
      const f = this.folders.get(placeKey(i))
      return {
        key: i.key,
        sessionId: i.sessionId,
        provider: i.provider,
        ...(i.parentId ? { parentId: i.parentId } : {}),
        ...(i.title ? { title: i.title } : {}),
        root: f?.root ?? normPath(repo.root),
        cwdRel: f?.cwdRel ?? '',
        signals: i.signals ?? EMPTY_SIGNALS,
        unlinked: new Set(this.deps.sessions.gitUnlinked(i.key))
      }
    })
  }

  /** Branches whose PRs are looked up for a session: its own and its commits' (not the default branch). */
  private prBranches(repo: RepoState, i: GitInput, links: CommitLink[]): string[] {
    const def = defaultBranch(repo.refs)
    const out = new Set<string>()
    const linked = links.filter((l) => LEVEL_RANK[l.level] >= LEVEL_RANK.medium)
    if (linked.length || i.signals?.prs.length) for (const b of i.signals?.branches ?? []) out.add(b)
    for (const l of linked) for (const b of repo.commits.get(l.sha)?.branches ?? []) out.add(b)
    out.delete(def ?? '')
    return [...out].slice(0, 20)
  }

  /** Cached gh answers: PRs by branch, and PRs found by a linked commit's SHA. */
  private ghPrsFor(slug: string | undefined, branches: string[], shas: string[]): GhPr[] {
    if (!slug) return []
    const out: GhPr[] = []
    for (const b of branches) out.push(...(this.gh.get(`${slug}#${b}`)?.prs ?? []))
    for (const sha of shas) out.push(...(this.gh.get(`${slug}@${sha}`)?.prs ?? []))
    return out
  }

  private computeRepo(repo: RepoState, list: GitInput[]): void {
    const commits = [...repo.commits.values()]
    const links = matchRepo(
      { caseInsensitive: repo.env.kind === 'windows', ...(repo.userEmail ? { userEmail: repo.userEmail } : {}), commits },
      this.matchSessions(repo, list)
    )
    for (const i of list) {
      const own = links.get(i.key) ?? []
      const branches = this.prBranches(repo, i, own)
      const exact = own.filter((l) => l.level === 'exact').map((l) => l.sha)
      const gh = this.ghOn() ? this.ghPrsFor(repo.github, branches, exact) : []
      // A PR found by one of its exact commits is the session's whatever its branch.
      for (const sha of exact)
        for (const p of this.gh.get(`${repo.github}@${sha}`)?.prs ?? []) branches.push(p.headRefName)
      const prs = sessionPrs({
        signals: i.signals,
        links: own,
        commits: repo.commits,
        github: repo.github,
        ghPrs: gh,
        branches
      })
      const f = this.folders.get(placeKey(i))
      const touched = new Set<string>()
      for (const file of i.signals?.files ?? []) {
        const rel = f?.root !== undefined ? repoFile(file, { root: f.root, caseInsensitive: repo.env.kind === 'windows' }, f.cwdRel ?? '') : undefined
        touched.add(rel ?? normPath(file))
      }
      for (const l of own)
        if (LEVEL_RANK[l.level] >= LEVEL_RANK.medium)
          for (const cf of repo.commits.get(l.sha)?.files ?? []) touched.add(cf.path)
      this.computed.set(i.key, {
        repoKey: repo.key,
        status: 'ok',
        links: own,
        prs,
        badge: gitBadge(own, prs),
        touched: [...touched]
      })
    }
  }

  private computeWithoutRepo(i: GitInput, f: FolderState | undefined): void {
    const prs = sessionPrs({ signals: i.signals, links: [], commits: new Map() })
    this.computed.set(i.key, {
      status: f?.status ?? 'no-folder',
      ...(f?.message ? { message: f.message } : {}),
      links: [],
      prs,
      badge: prs.length ? { commits: 0, prs: prs.map((p) => p.number) } : undefined,
      touched: (i.signals?.files ?? []).map((x) => normPath(x))
    })
  }

  // ------------------------------------------------------------------- gh

  private ghOn(): boolean {
    return this.cfg().gh === 'on' && this.ghAuth?.state === 'ok'
  }

  private async ensureGhAuth(): Promise<GhAuth | undefined> {
    if (this.cfg().gh !== 'on') return undefined
    if (!this.ghAuth || now() - this.ghAuth.at > 6 * 3600_000)
      this.ghAuth = { state: await this.deps.backend.ghAuth(), at: now() }
    return this.ghAuth.state
  }

  private ghFresh(key: string): boolean {
    const e = this.gh.get(key)
    if (!e) return false
    const done = e.prs.length > 0 && e.prs.every((p) => /^(MERGED|CLOSED)$/i.test(p.state))
    return now() - e.at < (done ? GH_DONE_TTL : GH_OPEN_TTL)
  }

  /** Looks up PRs for a repo's session branches not cached yet; returns the gh calls made. */
  private async ghLookups(repo: RepoState, list: GitInput[], budget: number, onlyKey?: string): Promise<number> {
    if (budget <= 0 || !repo.github || (await this.ensureGhAuth()) !== 'ok') return 0
    let calls = 0
    const wanted = new Set<string>()
    for (const i of list) {
      if (onlyKey && i.key !== onlyKey) continue
      for (const b of this.prBranches(repo, i, this.computed.get(i.key)?.links ?? [])) wanted.add(b)
    }
    for (const b of wanted) {
      if (calls >= budget) break
      const key = `${repo.github}#${b}`
      if (this.ghFresh(key)) continue
      const prs = await this.deps.backend.ghPrs(repo.github, { head: b })
      calls++
      if (prs) this.gh.set(key, { at: now(), prs })
    }
    return calls
  }

  /** PRs of a session's exact commits that no PR covers yet (a squash merge's branch may be gone). */
  private async ghShaLookups(repo: RepoState, key: string, budget: number): Promise<number> {
    if (!repo.github || this.ghAuth?.state !== 'ok') return 0
    const c = this.computed.get(key)
    if (!c) return 0
    const covered = new Set(c.prs.map((p) => p.number))
    let calls = 0
    for (const l of c.links) {
      if (calls >= budget) break
      if (l.level !== 'exact') continue
      const ci = repo.commits.get(l.sha)
      if (ci?.pr !== undefined && covered.has(ci.pr)) continue
      const k = `${repo.github}@${l.sha}`
      if (this.ghFresh(k) || this.gh.has(k)) continue
      const prs = await this.deps.backend.ghPrs(repo.github, { search: l.sha })
      calls++
      if (prs) this.gh.set(k, { at: now(), prs })
    }
    return calls
  }

  // ------------------------------------------------------------ the UI

  private ghState(repo: RepoState | undefined): GhState {
    const c = this.cfg().gh
    if (c !== 'on') return c
    if (repo && !repo.github) return 'not-github'
    if (this.ghAuth?.state === 'missing') return 'missing'
    if (this.ghAuth?.state === 'signed-out') return 'signed-out'
    return 'on'
  }

  private commitView(c: CommitInfo, link: CommitLink): CommitView {
    let add = 0
    let del = 0
    for (const f of c.files) {
      add += f.add ?? 0
      del += f.del ?? 0
    }
    return {
      ...link,
      subject: c.subject,
      at: new Date(c.at).toISOString(),
      parents: c.parents.length,
      branches: c.branches,
      files: c.files,
      ...(c.moreFiles ? { moreFiles: c.moreFiles } : {}),
      add,
      del,
      ...(c.pr !== undefined ? { pr: c.pr } : {})
    }
  }

  /** The Changes tab of one session (refreshing its repo in the background when it's stale). */
  view(key: string, opts: { refresh?: boolean } = {}): SessionGitView | null {
    const enabled = this.cfg().enabled
    const i = this.inputs.get(key) ?? this.deps.sessions.gitInputs().find((x) => x.key === key)
    if (!i) return null
    const c = this.computed.get(key)
    const f = this.folders.get(placeKey(i))
    const repo = c?.repoKey ? this.repos.get(c.repoKey) : undefined
    if (enabled && opts.refresh !== false) this.refreshForTab(key, repo)
    const sig = i.signals ?? EMPTY_SIGNALS
    const views: CommitView[] = []
    const possible: CommitView[] = []
    for (const l of c?.links ?? []) {
      const ci = repo?.commits.get(l.sha)
      if (!ci) continue
      ;(LEVEL_RANK[l.level] >= LEVEL_RANK.medium ? views : possible).push(this.commitView(ci, l))
    }
    const unlinked: CommitView[] = []
    for (const sha of this.deps.sessions.gitUnlinked(key)) {
      const ci = repo?.commits.get(sha)
      if (ci) unlinked.push(this.commitView(ci, { sha, level: 'low', reasons: [] }))
    }
    // No repo to look in: the commits its own output showed, as it showed them.
    if (!repo) {
      const seen = new Map<string, CommitView>()
      for (const s of sig.commits) {
        if (s.kind !== 'commit-line' || seen.has(s.sha)) continue
        seen.set(s.sha, {
          sha: s.sha,
          level: 'high',
          reasons: [{ kind: 'seen', how: s.kind }],
          subject: s.subject ?? '',
          at: new Date(s.from).toISOString(),
          parents: 1,
          branches: s.branch ? [s.branch] : [],
          files: [],
          add: 0,
          del: 0,
          unknown: true
        })
      }
      views.push(...seen.values())
    }
    const byTime = (a: CommitView, b: CommitView): number => Date.parse(b.at) - Date.parse(a.at)
    views.sort(byTime)
    possible.sort(byTime)
    const committed = new Set<string>()
    for (const v of views) for (const cf of v.files) committed.add(repo?.env.kind === 'windows' ? cf.path.toLowerCase() : cf.path)
    const uncommitted: string[] = []
    if (repo && f?.root !== undefined) {
      for (const file of sig.files) {
        const rel = repoFile(file, { root: f.root, caseInsensitive: repo.env.kind === 'windows' }, f.cwdRel ?? '')
        if (rel && !committed.has(rel)) uncommitted.push(rel)
      }
    }
    return {
      key,
      enabled,
      status: !enabled ? 'ok' : c ? c.status : 'pending',
      ...(c?.message ? { message: c.message } : {}),
      ...(repo
        ? {
            repo: {
              root: repo.root,
              env: envLabel(repo.env),
              ...(repo.remote ? { remote: safeRemote(repo.remote) } : {}),
              ...(repo.github ? { github: repo.github } : {}),
              ...(f?.note ? { note: f.note } : {}),
              ...(repo.truncated ? { truncated: true } : {})
            }
          }
        : {}),
      branches: sig.branches,
      commits: views,
      possible,
      unlinked,
      prs: c?.prs ?? [],
      uncommitted: [...new Set(uncommitted)].slice(0, 500),
      gh: this.ghState(repo),
      ...(repo?.checkedAt ? { checkedAt: new Date(repo.checkedAt).toISOString() } : {}),
      busy: !!(c?.repoKey && this.busy.has(c.repoKey)) || (!c && enabled)
    }
  }

  private tabRefresh = new Map<string, number>()

  private refreshForTab(key: string, repo: RepoState | undefined): void {
    const last = this.tabRefresh.get(key) ?? 0
    if (now() - last < FRESH_MS) return
    this.tabRefresh.set(key, now())
    if (!repo) {
      if (!this.computed.has(key)) void this.schedule({ force: false })
      return
    }
    if (now() - repo.checkedAt > FRESH_MS) void this.schedule({ force: false, repos: new Set([repo.key]) })
    // Its own PR lookups, not waiting for a background pass.
    if (this.cfg().gh === 'on' && repo.github) {
      const list = [...this.inputs.values()].filter((x) => this.computed.get(x.key)?.repoKey === repo.key)
      void this.ghLookups(repo, list, 5, key)
        .then(async (n) => n + (await this.ghShaLookups(repo, key, 3)))
        .then((n) => {
        if (!n) return
        this.computeRepo(repo, list)
        this.saveSoon()
        this.emitChanged()
      })
    }
  }

  /** A commit's diff (whole, or one file), only for a commit shown in this session's tab. */
  async diff(key: string, sha: string, path?: string, all = false): Promise<CommitDiff> {
    const c = this.computed.get(key)
    const repo = c?.repoKey ? this.repos.get(c.repoKey) : undefined
    const unlinked = this.deps.sessions.gitUnlinked(key)
    const ci = repo?.commits.get(sha)
    const shown = !!c && (c.links.some((l) => l.sha === sha) || unlinked.includes(sha))
    if (!repo || !ci || !shown) return { sha, files: [], truncated: false, bytes: 0, error: "This commit isn't linked to this session." }
    let paths: string[] | undefined
    if (path !== undefined) {
      const file = ci.files.find((x) => x.path === path)
      if (!file) return { sha, files: [], truncated: false, bytes: 0, error: "This file isn't part of the commit." }
      paths = file.from ? [file.from, file.path] : [file.path]
    }
    const r = await this.deps.backend.show(repo.env, repo.root, sha, paths, all ? DIFF_BYTES_ALL : DIFF_BYTES)
    if (r.error) return { sha, files: [], truncated: false, bytes: 0, error: r.error }
    return { sha, files: parsePatch(r.text), truncated: r.truncated, bytes: Buffer.byteLength(r.text) }
  }

  unlink(key: string, sha: string): SessionGitView | null {
    const cur = this.deps.sessions.gitUnlinked(key)
    if (!cur.includes(sha)) this.deps.sessions.setGitUnlinked(key, [...cur, sha])
    this.recompute(key)
    return this.view(key, { refresh: false })
  }

  relink(key: string, sha: string): SessionGitView | null {
    this.deps.sessions.setGitUnlinked(
      key,
      this.deps.sessions.gitUnlinked(key).filter((x) => x !== sha)
    )
    this.recompute(key)
    return this.view(key, { refresh: false })
  }

  /** Matching again for the repo of one session (no git: an unlink moves a commit to the next best session). */
  private recompute(key: string): void {
    const rk = this.computed.get(key)?.repoKey
    const repo = rk ? this.repos.get(rk) : undefined
    if (!repo) return
    const list = [...this.inputs.values()].filter((x) => this.computed.get(x.key)?.repoKey === rk)
    this.computeRepo(repo, list)
    this.emitChanged()
  }

  refresh(key?: string): Promise<void> {
    if (!key) return this.schedule({ force: true })
    const rk = this.computed.get(key)?.repoKey
    const i = this.inputs.get(key)
    if (i) this.folders.delete(placeKey(i))
    this.tabRefresh.delete(key)
    this.ghAuth = undefined
    return this.schedule({ force: true, repos: rk ? new Set([rk]) : undefined })
  }

  badge(key: string): GitBadge | undefined {
    return this.cfg().enabled ? this.computed.get(key)?.badge : undefined
  }

  /** Sessions a `touched:` / `commit:` filter matches (every filter must match). */
  filter(q: GitQuery): Set<string> {
    const out = new Set<string>()
    for (const [key, c] of this.computed) {
      const ok =
        q.touched.every((p) => c.touched.some((f) => pathMatches(f, p))) &&
        q.commits.every((sha) => {
          if (c.links.some((l) => LEVEL_RANK[l.level] >= LEVEL_RANK.medium && l.sha.startsWith(sha))) return true
          const sig = this.inputs.get(key)?.signals
          return !!sig?.commits.some((s) => s.kind === 'commit-line' && (s.sha.startsWith(sha) || sha.startsWith(s.sha)))
        })
      if (ok) out.add(key)
    }
    return out
  }

  async status(): Promise<GitStatus> {
    const envs = new Map<string, GitEnv>([['windows', { kind: 'windows' }]])
    for (const r of this.repos.values()) envs.set(envKey(r.env), r.env)
    const git: GitStatus['git'] = []
    for (const [k, env] of envs) {
      if (!this.versions.has(k) || this.versions.get(k)?.error)
        this.versions.set(k, await this.deps.backend.version(env))
      git.push({ env: envLabel(env), ...this.versions.get(k) })
    }
    if (this.cfg().gh === 'on') await this.ensureGhAuth()
    const linked = [...this.computed.values()].filter((c) => c.badge?.commits).length
    return {
      enabled: this.cfg().enabled,
      gh: this.ghState(undefined),
      git,
      repos: [...this.repos.values()].filter((r) => r.commits.size || r.refs.length).length,
      linkedSessions: linked,
      busy: this.busy.size > 0 || this.passScheduled,
      ...(this.checkedAt ? { checkedAt: new Date(this.checkedAt).toISOString() } : {})
    }
  }
}
