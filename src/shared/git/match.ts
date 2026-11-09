// Matching commits to sessions (docs/ROADMAP.md, feature 6).
//
// Strongest first:
// - exact: a `Claude-Session:` trailer naming one of the session's
//   claude.ai/code links, or the session's own `git commit` call printed the
//   SHA and the commit was made during that call (committer time between the
//   call and its result, ±1 minute). The time check also keeps a fork from
//   claiming its parent's commits (copied lines carry the fork's time).
// - high: the same commit rewritten later (rebase, cherry-pick: same subject
//   and author time), or made during an active stretch, on one of the
//   session's branches, and touching files the session edited.
// - medium: during a stretch and on the branch, or touching edited files.
// - low ("possible"): during a stretch only. Shown apart, never in badges.
// Non-exact matches need the repo's user.email (when set) as the author or
// committer, no merge commits, and a "made by" trailer of the session's own
// agent (if the commit has one). One commit claimed by several sessions: an
// exact match wins; otherwise the best level keeps it, and a tie is marked
// "also matches N sessions" one level lower.

import {
  LEVEL_RANK,
  type CommitInfo,
  type CommitLink,
  type LinkLevel,
  type LinkReason,
  type SessionGitSignals
} from './types'

/** Slack around an active stretch. */
export const SPAN_SLACK_MS = 5 * 60_000
/** Slack around a `git commit` call (clock and timestamp rounding). */
export const CALL_SLACK_MS = 60_000

export interface MatchSession {
  key: string
  sessionId: string
  provider: 'claude' | 'codex'
  /** A Codex subagent thread: its parent thread's id. */
  parentId?: string
  /** A fork or branch carrying a copy of its parent's history: the parent's id. */
  forkOf?: string
  /** When it split from its parent: commits before then are the parent's. */
  forkAt?: number
  title?: string
  /** The root of the session's own worktree (normalised, see normPath): its absolute file paths are relative to it. */
  root: string
  /** The session's folder relative to that root ('' = the root). */
  cwdRel: string
  signals: SessionGitSignals
  /** Commits I unlinked from this session (full SHAs). */
  unlinked: ReadonlySet<string>
}

export interface MatchRepo {
  /** Paths compare without case (a Windows repo). */
  caseInsensitive: boolean
  userEmail?: string
  commits: CommitInfo[]
}

// ------------------------------------------------------------------ paths

/** Forward slashes, `.`/`..` resolved, no trailing slash; `C:\x` → `c:/x`, `/mnt/c/x` → `c:/x`. */
export function normPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  const unc = s.startsWith('//')
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s)
  if (mnt) s = `${mnt[1].toLowerCase()}:${mnt[2] ?? '/'}`
  const drive = /^([a-zA-Z]):(\/.*)?$/.exec(s)
  if (drive) s = `${drive[1].toLowerCase()}:${drive[2] ?? '/'}`
  const lead = unc ? '//' : s.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const part of s.slice(lead.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..' && !/^[a-z]:$/.test(out[out.length - 1]))
        out.pop()
      else if (!lead && !/^[a-z]:$/.test(out[0] ?? '')) out.push('..')
      continue
    }
    out.push(part)
  }
  return lead + out.join('/')
}

const isAbs = (p: string): boolean => p.startsWith('/') || /^[a-z]:\//.test(p) || /^[a-z]:$/.test(p)

/** A path relative to `root` ('' for the root itself), or undefined if it's outside. Both normalised. */
export function relativeTo(path: string, root: string, ci: boolean): string | undefined {
  const p = ci ? path.toLowerCase() : path
  const r = ci ? root.toLowerCase() : root
  if (p === r) return ''
  const prefix = r.endsWith('/') ? r : `${r}/`
  return p.startsWith(prefix) ? path.slice(prefix.length) : undefined
}

/** A file a session named, as a repo-relative path (lower-cased in a case-insensitive repo), or undefined. */
export function repoFile(
  file: string,
  repo: { root: string; caseInsensitive: boolean },
  cwdRel: string
): string | undefined {
  const f = normPath(file)
  let rel: string | undefined
  if (isAbs(f)) rel = relativeTo(f, repo.root, repo.caseInsensitive)
  else {
    const joined = normPath(cwdRel ? `${cwdRel}/${f}` : f)
    rel = joined.startsWith('..') ? undefined : joined
  }
  if (!rel) return undefined
  return repo.caseInsensitive ? rel.toLowerCase() : rel
}

// --------------------------------------------------------------- matching

const SESSION_TRAILER = /^Claude-Session:\s*(\S+)/i
const CLAUDE_COAUTHOR = /^Co-Authored-By:\s*Claude\b/i
const CODEX_COAUTHOR = /^Co-Authored-By:\s*Codex\b/i

interface Candidate {
  s: MatchSession
  level: LinkLevel
  reasons: LinkReason[]
  /** For two exact "seen" claims: the earlier call is the original. */
  seenAt?: number
}

function inSpans(t: number, spans: [number, number][]): boolean {
  return spans.some(([a, b]) => t >= a - SPAN_SLACK_MS && t <= b + SPAN_SLACK_MS)
}

function commitOwner(c: CommitInfo): 'claude' | 'codex' | undefined {
  if (c.trailers.some((t) => CLAUDE_COAUTHOR.test(t))) return 'claude'
  if (c.trailers.some((t) => CODEX_COAUTHOR.test(t))) return 'codex'
  return undefined
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A session's claim on a commit, or undefined. Exported for tests. */
export function candidate(
  s: MatchSession,
  c: CommitInfo,
  repo: MatchRepo,
  files: Set<string>
): Candidate | undefined {
  if (s.unlinked.has(c.sha)) return undefined
  // A fork's copy of its parent's history: what was made before the split is the parent's.
  if (s.forkAt !== undefined && c.ct < s.forkAt && c.at < s.forkAt) return undefined
  const sig = s.signals
  // A Claude-Session trailer naming one of its links.
  for (const t of c.trailers) {
    const url = SESSION_TRAILER.exec(t)?.[1]
    if (url && sig.sessionUrls.includes(url))
      return { s, level: 'exact', reasons: [{ kind: 'trailer', url }] }
  }
  // Its own `git commit` call printed this SHA, and the commit was made during that call.
  let rewritten = false
  for (const seen of sig.commits) {
    const during = (t: number): boolean =>
      t >= seen.from - CALL_SLACK_MS && t <= seen.to + CALL_SLACK_MS
    if (c.sha.startsWith(seen.sha) && during(c.ct))
      return { s, level: 'exact', reasons: [{ kind: 'seen', how: seen.kind }], seenAt: seen.from }
    if (seen.subject && seen.subject === c.subject && during(c.at) && !c.sha.startsWith(seen.sha))
      rewritten = true
  }
  if (rewritten) return { s, level: 'high', reasons: [{ kind: 'rewritten' }] }

  if (c.parents.length > 1) return undefined
  if (
    repo.userEmail &&
    !sameEmail(c.authorEmail, repo.userEmail) &&
    !sameEmail(c.committerEmail, repo.userEmail)
  )
    return undefined
  const owner = commitOwner(c)
  if (owner && owner !== s.provider) return undefined
  if (sig.head && c.sha.startsWith(sig.head)) return undefined
  if (!inSpans(c.at, sig.spans)) return undefined

  const reasons: LinkReason[] = []
  const branch = c.branches.find((b) => sig.branches.includes(b))
  if (branch) reasons.push({ kind: 'branch', branch })
  let overlap = 0
  if (files.size)
    for (const f of c.files) {
      const p = repo.caseInsensitive ? f.path.toLowerCase() : f.path
      if (files.has(p)) overlap++
    }
  if (overlap)
    reasons.push({ kind: 'files', count: overlap, of: c.files.length + (c.moreFiles ?? 0) })
  reasons.push({ kind: 'time' })
  const level: LinkLevel = branch && overlap ? 'high' : branch || overlap ? 'medium' : 'low'
  return { s, level, reasons }
}

const DEMOTE: Record<LinkLevel, LinkLevel> = {
  exact: 'exact',
  high: 'medium',
  medium: 'low',
  low: 'low'
}

/**
 * Links per session key, for every session given (an empty list when none).
 * Unlinked commits are left out (they're listed apart by the caller).
 */
export function matchRepo(repo: MatchRepo, sessions: MatchSession[]): Map<string, CommitLink[]> {
  const out = new Map<string, CommitLink[]>(sessions.map((s) => [s.key, []]))
  const fileSets = new Map<string, Set<string>>()
  for (const s of sessions) {
    const set = new Set<string>()
    for (const f of s.signals.files) {
      const r = repoFile(f, { root: s.root, caseInsensitive: repo.caseInsensitive }, s.cwdRel)
      if (r) set.add(r)
    }
    fileSets.set(s.key, set)
  }
  const byId = new Map(sessions.map((s) => [s.sessionId, s]))

  for (const c of repo.commits) {
    let cands: Candidate[] = []
    for (const s of sessions) {
      const cand = candidate(s, c, repo, fileSets.get(s.key)!)
      if (cand) cands.push(cand)
    }
    if (!cands.length) continue
    const best = Math.max(...cands.map((x) => LEVEL_RANK[x.level]))
    cands = cands.filter((x) => LEVEL_RANK[x.level] === best)
    // A subagent or fork gives way to its parent at the same level (they share
    // folder and time; a fork's copy of the history looks like its own).
    const ids = new Set(cands.map((x) => x.s.sessionId))
    const own = cands.filter(
      (x) => !(x.s.parentId && ids.has(x.s.parentId)) && !(x.s.forkOf && ids.has(x.s.forkOf))
    )
    if (own.length) cands = own
    if (best === LEVEL_RANK.exact) {
      // Two "seen" claims (a copy that wasn't recognised): the earlier call is the original.
      const trailer = cands.filter((x) => x.reasons[0]?.kind === 'trailer')
      if (trailer.length) cands = trailer
      else {
        const first = Math.min(...cands.map((x) => x.seenAt ?? Infinity))
        cands = [cands.find((x) => (x.seenAt ?? Infinity) === first)!]
      }
    } else {
      if (cands.length > 1)
        cands = cands.map((x) => ({
          ...x,
          level: DEMOTE[x.level],
          reasons: [...x.reasons, { kind: 'shared', others: cands.length - 1 }]
        }))
    }
    for (const x of cands)
      out.get(x.s.key)!.push({ sha: c.sha, level: x.level, reasons: x.reasons })
  }

  // A subagent's exact or high commits also show on its parent thread.
  for (const s of sessions) {
    const parent = s.parentId ? byId.get(s.parentId) : undefined
    if (!parent) continue
    const mine = out.get(parent.key)!
    for (const l of out.get(s.key)!) {
      if (LEVEL_RANK[l.level] < LEVEL_RANK.high || parent.unlinked.has(l.sha)) continue
      if (mine.some((m) => m.sha === l.sha)) continue
      mine.push({
        sha: l.sha,
        level: l.level,
        reasons: [...l.reasons, { kind: 'subagent', ...(s.title ? { title: s.title } : {}) }]
      })
    }
  }
  return out
}
