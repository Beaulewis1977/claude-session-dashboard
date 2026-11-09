// A session's pull requests: from its own `gh pr create` output, from merge
// and squash commit messages of its linked commits, and (when I turned it
// on) from the GitHub CLI by branch. Plus the card badge.

import { LEVEL_RANK, type CommitInfo, type CommitLink, type GitBadge, type PrLink, type SessionGitSignals } from './types'

/** What `gh pr list --json …` returns for one pull request (only the fields the app asks for). */
export interface GhPr {
  number: number
  title: string
  url: string
  state: string
  isDraft?: boolean
  headRefName: string
}

export function prState(p: Pick<GhPr, 'state' | 'isDraft'>): PrLink['state'] {
  const s = p.state.toUpperCase()
  if (s === 'MERGED') return 'merged'
  if (s === 'CLOSED') return 'closed'
  return p.isDraft ? 'draft' : 'open'
}

/** Only PR links of this form are ever shown or opened. */
export function isGithubPrUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,7}$/.test(url)
}

export function sessionPrs(opts: {
  signals: SessionGitSignals | undefined
  links: CommitLink[]
  commits: Map<string, CommitInfo>
  /** `owner/name` of the repo's github.com remote. */
  github?: string
  /** Branches to look PRs up by: the session's own and its linked commits' (not the default branch). */
  ghPrs?: GhPr[]
  branches?: string[]
}): PrLink[] {
  const out = new Map<number, PrLink>()
  const slug = opts.github?.toLowerCase()
  for (const p of opts.signals?.prs ?? []) {
    // Its own PRs in this repo (a session with no known repo: all of them).
    if (slug && `${p.owner}/${p.repo}`.toLowerCase() !== slug) continue
    if (isGithubPrUrl(p.url)) out.set(p.number, { number: p.number, url: p.url, via: 'session' })
  }
  if (opts.github)
    for (const l of opts.links) {
      if (LEVEL_RANK[l.level] < LEVEL_RANK.medium) continue
      const n = opts.commits.get(l.sha)?.pr
      if (n === undefined || out.has(n)) continue
      out.set(n, { number: n, url: `https://github.com/${opts.github}/pull/${n}`, via: 'merge' })
    }
  const branches = new Set(opts.branches ?? [])
  for (const g of opts.ghPrs ?? []) {
    if (!isGithubPrUrl(g.url)) continue
    const known = out.get(g.number)
    if (!known && !branches.has(g.headRefName)) continue
    out.set(g.number, {
      number: g.number,
      url: g.url,
      title: g.title,
      state: prState(g),
      branch: g.headRefName,
      via: known?.via ?? 'gh'
    })
  }
  return [...out.values()].sort((a, b) => a.number - b.number)
}

/** "3 commits · PR #14": linked commits (medium or better) and PR numbers. */
export function gitBadge(links: CommitLink[], prs: PrLink[]): GitBadge | undefined {
  const commits = links.filter((l) => LEVEL_RANK[l.level] >= LEVEL_RANK.medium).length
  if (!commits && !prs.length) return undefined
  return { commits, prs: prs.map((p) => p.number) }
}

export function badgeText(b: GitBadge): string {
  const parts: string[] = []
  if (b.commits) parts.push(`${b.commits} commit${b.commits === 1 ? '' : 's'}`)
  if (b.prs.length === 1) parts.push(`PR #${b.prs[0]}`)
  else if (b.prs.length > 1) parts.push(`${b.prs.length} PRs`)
  return parts.join(' · ')
}
