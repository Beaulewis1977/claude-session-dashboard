// Git signals in a session's own file: what its tool calls committed,
// printed and edited. Shared by the Claude Code and Codex parsers, which
// feed it their events in order (see claude-signals.ts and the Codex parser).

import {
  MAX_SIGNAL_COMMITS,
  MAX_SIGNAL_FILES,
  MAX_SIGNAL_PRS,
  MAX_SIGNAL_SPANS,
  SPAN_GAP_MS,
  type SeenCommit,
  type SeenPr,
  type SessionGitSignals
} from './types'

/** `git commit`, `git -C dir commit`, `git -c k=v commit` (not `commit-tree`, not `git log … commit`). */
export const GIT_COMMIT_CMD =
  /\bgit(?:\.exe)?\s+(?:(?:-C|-c)\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*commit(?![-\w])/
/** `gh pr create`. */
export const GH_PR_CREATE = /\bgh(?:\.exe)?\s+pr\s+create\b/

/** git's own line for a new commit: `[main abc1234] Subject`, `[main (root-commit) abc1234] …`. */
const COMMIT_LINE =
  /^\[(?:detached HEAD|([^\s\]]+))(?: \(root-commit\))? ([0-9a-fA-F]{7,40})\] ?(.*)$/gm
/** A SHA at a line start: `git log --oneline -1` (`abc1234 Subject`) or `git rev-parse HEAD`. */
const LINE_SHA = /^([0-9a-f]{7,40})(?:[ \t]+(.*))?$/gm
const PR_URL =
  /https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,7})\b/g
const SESSION_TRAILER =
  /^\s*Claude-Session:\s*(https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64})/gim

/** The commits a `git commit` call's output shows. */
export function commitsInOutput(
  text: string
): { sha: string; kind: SeenCommit['kind']; branch?: string; subject?: string }[] {
  const out: { sha: string; kind: SeenCommit['kind']; branch?: string; subject?: string }[] = []
  for (const m of text.matchAll(COMMIT_LINE)) {
    out.push({
      sha: m[2].toLowerCase(),
      kind: 'commit-line',
      ...(m[1] ? { branch: m[1] } : {}),
      ...(m[3]?.trim() ? { subject: m[3].trim().slice(0, 300) } : {})
    })
    if (out.length >= 20) break
  }
  if (out.length) return out
  // No commit line (e.g. `git commit -q && git log --oneline -1`): SHAs at line starts.
  // Matched to a commit only if it was made during this very call (see match.ts).
  for (const m of text.matchAll(LINE_SHA)) {
    out.push({
      sha: m[1].toLowerCase(),
      kind: 'chained',
      ...(m[2]?.trim() ? { subject: m[2].trim().slice(0, 300) } : {})
    })
    if (out.length >= 10) break
  }
  return out
}

/** Pull request links in a `gh pr create` call's output. */
export function prsInOutput(text: string): Omit<SeenPr, 'at'>[] {
  const out: Omit<SeenPr, 'at'>[] = []
  for (const m of text.matchAll(PR_URL)) {
    out.push({ owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] })
    if (out.length >= 5) break
  }
  return out
}

/** `Claude-Session:` trailer links in a commit command. */
export function sessionTrailers(text: string): string[] {
  return [...text.matchAll(SESSION_TRAILER)].map((m) => m[1])
}

/** Active stretches: sorted times split where they're more than SPAN_GAP_MS apart. */
export function spansOf(times: number[], gap = SPAN_GAP_MS): [number, number][] {
  const t = times.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  const out: [number, number][] = []
  for (const x of t) {
    const last = out[out.length - 1]
    if (last && x - last[1] <= gap) last[1] = x
    else out.push([x, x])
  }
  // Too many: merge the closest neighbours until it fits.
  while (out.length > MAX_SIGNAL_SPANS) {
    let best = 1
    for (let i = 2; i < out.length; i++)
      if (out[i][0] - out[i - 1][1] < out[best][0] - out[best - 1][1]) best = i
    out[best - 1][1] = out[best][1]
    out.splice(best, 1)
  }
  return out
}

interface PendingCall {
  at: number
  commit: boolean
  pr: boolean
}

/**
 * Collects a session's git signals from its events, in file order. The
 * parsers call `time` for every event of the session's own (not copied
 * history), and the tool methods for its tool calls and results.
 */
export class GitSignalBuilder {
  private times: number[] = []
  private branches = new Set<string>()
  /** Each file edited, and when it was last (epoch ms; 0 = no time). */
  private files = new Map<string, number>()
  private commits = new Map<string, SeenCommit>()
  private prs = new Map<string, SeenPr>()
  /** Each link, and when it was last seen (epoch ms; 0 = no time). */
  private urls = new Map<string, number>()
  private calls = new Map<string, PendingCall>()
  head?: string
  remote?: string

  time(ms: number | undefined): void {
    if (ms !== undefined && Number.isFinite(ms)) this.times.push(ms)
  }

  branch(name: unknown): void {
    if (typeof name !== 'string') return
    const b = name.trim()
    if (b && b !== 'HEAD' && b.length <= 250 && !/\s/.test(b)) this.branches.add(b)
  }

  file(path: unknown, at?: number): void {
    if (typeof path !== 'string' || !path.trim()) return
    const p = path.trim()
    if (!this.files.has(p) && this.files.size >= MAX_SIGNAL_FILES) return
    const t = at !== undefined && Number.isFinite(at) ? at : 0
    this.files.set(p, Math.max(this.files.get(p) ?? 0, t))
  }

  sessionUrl(url: string | undefined, at?: number): void {
    if (!url || (!this.urls.has(url) && this.urls.size >= 50)) return
    const t = at !== undefined && Number.isFinite(at) ? at : 0
    this.urls.set(url, Math.max(this.urls.get(url) ?? 0, t))
  }

  /** A shell command call (Bash, PowerShell, Codex's shell tools). */
  command(id: string | undefined, command: string, at: number | undefined): void {
    const commit = GIT_COMMIT_CMD.test(command)
    const pr = GH_PR_CREATE.test(command)
    if (commit) for (const u of sessionTrailers(command)) this.sessionUrl(u, at)
    if (id && (commit || pr) && at !== undefined && this.calls.size < 5000)
      this.calls.set(id, { at, commit, pr })
  }

  /** A tool call's result. */
  result(id: string | undefined, text: string, at: number | undefined): void {
    const call = id ? this.calls.get(id) : undefined
    if (!call || !text) return
    const to = at !== undefined && Number.isFinite(at) ? Math.max(at, call.at) : call.at
    if (call.commit)
      for (const c of commitsInOutput(text)) {
        if (this.commits.size >= MAX_SIGNAL_COMMITS) break
        const key = `${c.sha}|${c.kind}`
        if (!this.commits.has(key)) this.commits.set(key, { ...c, from: call.at, to })
      }
    if (call.pr)
      for (const p of prsInOutput(text)) {
        if (this.prs.size >= MAX_SIGNAL_PRS) break
        if (!this.prs.has(p.url)) this.prs.set(p.url, { ...p, at: to })
      }
  }

  build(): SessionGitSignals {
    return {
      branches: [...this.branches],
      files: [...this.files.keys()],
      filesAt: [...this.files.values()],
      commits: [...this.commits.values()],
      prs: [...this.prs.values()],
      spans: spansOf(this.times),
      sessionUrls: [...this.urls.keys()],
      sessionUrlsAt: [...this.urls.values()],
      ...(this.head ? { head: this.head } : {}),
      ...(this.remote ? { remote: this.remote } : {})
    }
  }
}
