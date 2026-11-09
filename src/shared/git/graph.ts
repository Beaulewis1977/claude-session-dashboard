// Which branch each commit belongs to, worked out from the commit graph the
// app read (git log), so no extra git calls are needed:
// - the default branch's own line (its first parents);
// - a merged branch: the commits a merge brought in, named by the merge's
//   message ("Merge pull request #40 from owner/branch", "Merge branch 'x'"),
//   which also gives the pull request;
// - a branch not merged yet: the commits only its tip reaches;
// - a squash merge on the default branch: "Subject (#14)" gives the pull request.
// The work stays bounded whatever the graph (thousands of merges, stacked or
// long-lived branches): see labelBranches.

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

/** At most this many names per commit from branches not merged yet. */
export const MAX_BRANCH_LABELS = 8

/** Commit visits for merges off the default branch, per commit read (plus a fixed part). */
const SIDE_MERGE_BUDGET = 20

/** The commits, parents before children (each once; safe on any graph). */
function topoOrder(commits: Map<string, CommitInfo>): CommitInfo[] {
  const out: CommitInfo[] = []
  const seen = new Set<string>()
  for (const first of commits.keys()) {
    if (seen.has(first)) continue
    seen.add(first)
    const stack: { c: CommitInfo; next: number }[] = [{ c: commits.get(first)!, next: 0 }]
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.next < top.c.parents.length) {
        const p = top.c.parents[top.next++]
        const pc = commits.get(p)
        if (pc && !seen.has(p)) {
          seen.add(p)
          stack.push({ c: pc, next: 0 })
        }
      } else {
        stack.pop()
        out.push(top.c)
      }
    }
  }
  return out
}

/** A max-heap of positions in the topological order (the newest commit first). */
class MaxHeap {
  private a: number[] = []
  get size(): number {
    return this.a.length
  }
  push(x: number): void {
    const a = this.a
    let i = a.push(x) - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p] >= x) break
      a[i] = a[p]
      i = p
    }
    a[i] = x
  }
  pop(): number {
    const a = this.a
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= a.length) break
        const m = l + 1 < a.length && a[l + 1] > a[l] ? l + 1 : l
        if (a[m] <= last) break
        a[i] = a[m]
        i = m
      }
      a[i] = last
    }
    return top
  }
}

/**
 * Sets `branches` and `pr` on each commit (in place). `prefer`: branch names
 * sessions were on; among branches not merged yet they're named first.
 *
 * Bounded work:
 * - merges on the default branch's line, oldest first: each takes what its other
 *   parents reach that neither the line nor an earlier merge holds, so every
 *   commit is visited once (stacked PRs keep their own commits);
 * - other merges (into a branch, or inside one) add their branch's name to what
 *   their other parents reach and their first parent doesn't, walking both sides
 *   newest first only until nothing is left that just the other side reaches (about
 *   the size of that branch), within a total budget;
 * - branches not merged yet: at most MAX_BRANCH_LABELS names per commit, the
 *   nearest branches first, and a branch stops where a commit is full.
 */
export function labelBranches(
  commits: Map<string, CommitInfo>,
  refs: RefTip[],
  opts: { prefer?: Iterable<string> } = {}
): void {
  const add = (c: CommitInfo, name: string): void => {
    if (!c.branches.includes(name)) c.branches.push(name)
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
    const c = commits.get(s)!
    add(c, def!)
    if (c.parents.length <= 1) {
      const pr = squashPr(c.subject)
      if (pr !== undefined) c.pr ??= pr
    }
  }

  const order = topoOrder(commits)
  const pos = new Map(order.map((c, i) => [c.sha, i]))
  const n = order.length

  // 1. Merges on the default branch's line, oldest first.
  const taken = new Uint8Array(n)
  for (const s of firstParent) taken[pos.get(s)!] = 1
  for (let i = 0; i < n; i++) {
    const c = order[i]
    if (c.parents.length < 2 || !firstParent.has(c.sha)) continue
    const named = mergeSubject(c.subject)
    if (named?.pr !== undefined) c.pr ??= named.pr
    const todo = c.parents.slice(1)
    while (todo.length) {
      const j = pos.get(todo.pop()!)
      if (j === undefined || taken[j]) continue
      taken[j] = 1
      const m = order[j]
      if (named?.branch) {
        add(m, named.branch)
        if (named.pr !== undefined) m.pr ??= named.pr
      }
      todo.push(...m.parents)
    }
  }

  // 2. Other merges. Both sides stop at the default branch's line.
  let budget = SIDE_MERGE_BUDGET * n + 100_000
  const mark = new Int32Array(n)
  const side = new Uint8Array(n) // 1: its first parent reaches it, 2: only another parent
  for (let i = 0; i < n && budget > 0; i++) {
    const c = order[i]
    if (c.parents.length < 2 || firstParent.has(c.sha)) continue
    const named = mergeSubject(c.subject)
    if (named?.pr !== undefined) c.pr ??= named.pr
    if (!named?.branch) continue
    const heap = new MaxHeap()
    let only = 0 // in the heap, reached by another parent only
    const reach = (sha: string, from: 1 | 2): void => {
      const j = pos.get(sha)
      if (j === undefined || firstParent.has(sha)) return
      if (mark[j] !== i + 1) {
        mark[j] = i + 1
        side[j] = from
        heap.push(j)
        if (from === 2) only++
      } else if (from === 1 && side[j] === 2) {
        side[j] = 1
        only--
      }
    }
    reach(c.parents[0], 1)
    for (const p of c.parents.slice(1)) reach(p, 2)
    while (heap.size && only > 0 && budget > 0) {
      const j = heap.pop()
      budget--
      const from = side[j] as 1 | 2
      const m = order[j]
      if (from === 2) {
        only--
        add(m, named.branch)
        if (named.pr !== undefined) m.pr ??= named.pr
      }
      for (const p of m.parents) reach(p, from)
    }
  }

  // 3. Branches not merged into the default branch (yet): what only their tips
  // reach. The ones sessions were on first, then the others, each pass nearest first.
  const tips = new Map<string, string[]>()
  for (const r of refs) {
    const name = branchName(r.ref)
    if (!name || name === def) continue
    const list = tips.get(name)
    if (list) list.push(r.sha)
    else tips.set(name, [r.sha])
  }
  const prefer = new Set(opts.prefer ?? [])
  const added = new Map<string, number>()
  const walk = (names: string[]): void => {
    const seen = new Set<string>()
    let front: [string, string][] = []
    for (const name of names) for (const t of tips.get(name)!) front.push([name, t])
    while (front.length) {
      const next: [string, string][] = []
      for (const [name, s] of front) {
        if (mainline.has(s)) continue
        const k = `${name}\n${s}`
        if (seen.has(k)) continue
        seen.add(k)
        const m = commits.get(s)
        if (!m) continue
        if (!m.branches.includes(name)) {
          const used = added.get(s) ?? 0
          if (used >= MAX_BRANCH_LABELS) continue
          m.branches.push(name)
          added.set(s, used + 1)
        }
        for (const p of m.parents) next.push([name, p])
      }
      front = next
    }
  }
  const names = [...tips.keys()]
  walk(names.filter((x) => prefer.has(x)))
  walk(names.filter((x) => !prefer.has(x)))
}
