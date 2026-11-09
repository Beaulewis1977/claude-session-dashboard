// Which branch each commit belongs to, worked out from the commit graph the
// app read (git log), so no extra git calls are needed:
// - the default branch's own line (its first parents);
// - a merged branch: the commits a merge brought in, named by the merge's
//   message ("Merge pull request #40 from owner/branch", "Merge branch 'x'"),
//   which also gives the pull request;
// - a branch not merged yet: the commits only its tip reaches;
// - a squash merge on the default branch: "Subject (#14)" gives the pull request.

import { branchName, type RefTip } from './log'
import type { CommitInfo } from './types'

/** The repo's default branch: what `origin/HEAD` points at, else main or master. */
export function defaultBranch(refs: RefTip[]): string | undefined {
  const head = refs.find((r) => /^refs\/remotes\/[^/]+\/HEAD$/.test(r.ref) && r.symref)
  const fromHead = head?.symref ? branchName(head.symref) : undefined
  if (fromHead) return fromHead
  const names = new Set(refs.map((r) => branchName(r.ref)).filter(Boolean))
  return names.has('main') ? 'main' : names.has('master') ? 'master' : undefined
}

/** The branch a merge commit's message names, and its pull request. */
export function mergeSubject(subject: string): { branch?: string; pr?: number } | undefined {
  const pr = /^Merge pull request #(\d+) from ([^\s/]+)\/(\S+)/.exec(subject)
  if (pr) return { pr: Number(pr[1]), branch: pr[3] }
  const br = /^Merge branch '([^']+)'/.exec(subject)
  if (br) return { branch: br[1] }
  const rt = /^Merge remote-tracking branch '[^/']+\/([^']+)'/.exec(subject)
  if (rt) return { branch: rt[1] }
  return undefined
}

/** A squash merge's pull request: "Subject (#14)". */
export function squashPr(subject: string): number | undefined {
  const m = /\(#(\d{1,7})\)\s*$/.exec(subject)
  return m ? Number(m[1]) : undefined
}

/** Above this many merges, a merge's range stops at the default branch's line only (cheaper). */
export const MAX_EXACT_MERGES = 400

/** Every commit reachable from these (within the commits read). */
function reachable(commits: Map<string, CommitInfo>, from: string[]): Set<string> {
  const out = new Set<string>()
  const todo = [...from]
  while (todo.length) {
    const s = todo.pop()!
    if (out.has(s)) continue
    const c = commits.get(s)
    if (!c) continue
    out.add(s)
    todo.push(...c.parents)
  }
  return out
}

/** Sets `branches` and `pr` on each commit (in place). */
export function labelBranches(commits: Map<string, CommitInfo>, refs: RefTip[]): void {
  const add = (sha: string, name: string): void => {
    const c = commits.get(sha)
    if (c && !c.branches.includes(name)) c.branches.push(name)
  }
  const def = defaultBranch(refs)
  const defTips = def
    ? refs.filter((r) => branchName(r.ref) === def && !r.ref.endsWith('/HEAD')).map((r) => r.sha)
    : []

  // Everything the default branch reaches, and its own (first-parent) line.
  const mainline = new Set<string>()
  const firstParent = new Set<string>()
  const stack = [...defTips]
  while (stack.length) {
    const s = stack.pop()!
    if (mainline.has(s)) continue
    const c = commits.get(s)
    if (!c) continue
    mainline.add(s)
    stack.push(...c.parents)
  }
  for (const tip of defTips) {
    let s: string | undefined = tip
    while (s && commits.has(s) && !firstParent.has(s)) {
      firstParent.add(s)
      s = commits.get(s)!.parents[0]
    }
  }
  for (const s of firstParent) {
    add(s, def!)
    const c = commits.get(s)!
    if (c.parents.length <= 1) {
      const pr = squashPr(c.subject)
      if (pr !== undefined) c.pr ??= pr
    }
  }

  // Merges: the commits each brought in: reached from its other parents, and not
  // already reachable from its first parent (a stacked branch's earlier PR keeps its
  // own commits). Oldest merge first, so a commit goes to the merge that brought it.
  const merges = [...commits.values()]
    .filter((c) => c.parents.length >= 2)
    .sort((a, b) => a.ct - b.ct)
  for (const c of merges) {
    const named = mergeSubject(c.subject)
    if (named?.pr !== undefined) c.pr ??= named.pr
    if (!named?.branch) continue
    // Bounded work: with very many merges, only the default branch's line is left out.
    const before =
      merges.length <= MAX_EXACT_MERGES ? reachable(commits, [c.parents[0]]) : firstParent
    const seen = new Set<string>()
    const todo = c.parents.slice(1)
    while (todo.length) {
      const s = todo.pop()!
      if (seen.has(s) || before.has(s)) continue
      const m = commits.get(s)
      if (!m) continue
      seen.add(s)
      add(s, named.branch)
      if (named.pr !== undefined) m.pr ??= named.pr
      todo.push(...m.parents)
    }
  }

  // Branches not merged into the default branch (yet): what only their tip reaches.
  for (const r of refs) {
    const name = branchName(r.ref)
    if (!name || name === def) continue
    const seen = new Set<string>()
    const todo = [r.sha]
    while (todo.length) {
      const s = todo.pop()!
      if (seen.has(s) || mainline.has(s)) continue
      const m = commits.get(s)
      if (!m) continue
      seen.add(s)
      add(s, name)
      todo.push(...m.parents)
    }
  }
}
