// Pure filtering / sorting for the session list.

import type { SearchHit } from '@shared/api'
import type { SessionSummary } from '@shared/types'
import { SOURCE_LABELS, type SourceLabel } from '@shared/source-label'

export type SortKey = 'activity' | 'started' | 'name' | 'relevance'
export type Visibility = 'visible' | 'hidden' | 'archived' | 'all'

export interface DateRange {
  /** yyyy-mm-dd, inclusive, local time */
  from?: string
  to?: string
  preset?: 'today' | '7d' | '30d' | 'year' | 'custom'
}

export interface Filters {
  visibility: Visibility
  env: string | null
  project: string | null
  tag: string | null
  date: DateRange | null
  /** Session source label (Terminal, VS Code, …). */
  source: string | null
}

export const EMPTY_FILTERS: Filters = {
  visibility: 'visible',
  env: null,
  project: null,
  tag: null,
  date: null,
  source: null
}

/**
 * "Clear all" in the toolbar: every filter back to its default, keeping only
 * the Visible / Hidden / Archived view chosen in the sidebar.
 */
export function clearedFilters(f: Filters): Filters {
  return { ...EMPTY_FILTERS, visibility: f.visibility }
}

export function envKey(
  s: Pick<SessionSummary, 'env' | 'distro'> & { availability?: string }
): string {
  if (s.availability === 'imported') return 'claude-ai'
  return s.env === 'wsl' ? `wsl:${s.distro ?? ''}` : 'windows'
}

export function envLabel(key: string): string {
  if (key === 'claude-ai') return 'claude.ai (imported)'
  return key === 'windows' ? 'Windows' : `WSL: ${key.slice(4)}`
}

export function projectKey(s: Pick<SessionSummary, 'cwd' | 'projectDir' | 'env'>): string {
  const p = s.cwd ?? s.projectDir
  return s.env === 'windows' ? p.toLowerCase() : p
}

function dayStart(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

export function toYmd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function presetRange(preset: NonNullable<DateRange['preset']>, now = new Date()): DateRange {
  const today = toYmd(now)
  const ago = (days: number): string =>
    toYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days))
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today }
    case '7d':
      return { preset, from: ago(6), to: today }
    case '30d':
      return { preset, from: ago(29), to: today }
    case 'year':
      return { preset, from: `${now.getFullYear()}-01-01`, to: today }
    case 'custom':
      return { preset, from: ago(6), to: today }
  }
}

export function inDateRange(iso: string | undefined, range: DateRange): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (range.from && t < dayStart(range.from)) return false
  if (range.to && t >= dayStart(range.to) + 86_400_000) return false
  return true
}

export function matchesFilters(s: SessionSummary, f: Filters, ignore?: keyof Filters): boolean {
  if (ignore !== 'visibility') {
    const hidden = s.meta.hidden === true
    if (f.visibility === 'visible' && hidden) return false
    if (f.visibility === 'hidden' && !hidden) return false
    if (f.visibility === 'archived' && s.availability !== 'archived-only') return false
  }
  // The dashboard's own Ask Claude runs only show when that source is picked.
  if (s.source === 'ask-claude' && f.source !== 'ask-claude') return false
  if (ignore !== 'source' && f.source && s.source !== f.source) return false
  if (ignore !== 'env' && f.env && envKey(s) !== f.env) return false
  if (ignore !== 'project' && f.project && projectKey(s) !== f.project) return false
  if (ignore !== 'tag' && f.tag && !(s.meta.tags ?? []).includes(f.tag)) return false
  if (ignore !== 'date' && f.date && !inDateRange(s.lastActivityAt ?? s.startedAt, f.date))
    return false
  return true
}

const time = (iso?: string): number => (iso ? Date.parse(iso) : 0)

export function sortSessions(
  list: SessionSummary[],
  sort: SortKey,
  hits?: Map<string, SearchHit> | null
): SessionSummary[] {
  const out = [...list]
  const byActivity = (a: SessionSummary, b: SessionSummary): number =>
    time(b.lastActivityAt ?? b.startedAt) - time(a.lastActivityAt ?? a.startedAt)
  if (sort === 'relevance' && hits) {
    out.sort(
      (a, b) => (hits.get(b.key)?.score ?? 0) - (hits.get(a.key)?.score ?? 0) || byActivity(a, b)
    )
  } else if (sort === 'started') {
    out.sort((a, b) => time(b.startedAt) - time(a.startedAt))
  } else if (sort === 'name') {
    out.sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
    )
  } else {
    out.sort(byActivity)
  }
  return out
}

export function visibleSessions(
  sessions: SessionSummary[],
  filters: Filters,
  sort: SortKey,
  hits: Map<string, SearchHit> | null
): SessionSummary[] {
  const filtered = sessions.filter((s) => matchesFilters(s, filters) && (!hits || hits.has(s.key)))
  return sortSessions(filtered, sort, hits)
}

export interface Facet {
  key: string
  label: string
  count: number
  detail?: string
}

/** Counts for the sidebar, honouring every filter except the facet's own. */
export function facets(sessions: SessionSummary[], filters: Filters) {
  const env = new Map<string, Facet>()
  const project = new Map<string, Facet>()
  const tag = new Map<string, Facet>()
  const source = new Map<string, Facet>()
  const views = { visible: 0, hidden: 0, archived: 0 }
  for (const s of sessions) {
    if (
      matchesFilters(
        s,
        { ...filters, source: s.source === 'ask-claude' ? 'ask-claude' : filters.source },
        'source'
      )
    ) {
      const f = source.get(s.source) ?? {
        key: s.source,
        label: SOURCE_LABELS[s.source as SourceLabel] ?? s.source,
        count: 0
      }
      f.count++
      source.set(s.source, f)
    }
    if (s.source === 'ask-claude') continue
    if (s.meta.hidden) views.hidden++
    else views.visible++
    if (s.availability === 'archived-only') views.archived++
    if (matchesFilters(s, filters, 'env')) {
      const k = envKey(s)
      const f = env.get(k) ?? { key: k, label: envLabel(k), count: 0 }
      f.count++
      env.set(k, f)
    }
    if (matchesFilters(s, filters, 'project')) {
      const k = projectKey(s)
      const f = project.get(k) ?? { key: k, label: s.projectName, count: 0, detail: s.cwd }
      f.count++
      project.set(k, f)
    }
    if (matchesFilters(s, filters, 'tag')) {
      for (const t of s.meta.tags ?? []) {
        const f = tag.get(t) ?? { key: t, label: t, count: 0 }
        f.count++
        tag.set(t, f)
      }
    }
  }
  const byCount = (a: Facet, b: Facet): number =>
    b.count - a.count || a.label.localeCompare(b.label)
  return {
    views,
    env: [...env.values()].sort((a, b) =>
      a.key === 'windows' ? -1 : b.key === 'windows' ? 1 : byCount(a, b)
    ),
    project: [...project.values()].sort(byCount),
    tag: [...tag.values()].sort(byCount),
    // The dashboard's own runs go last.
    source: [...source.values()].sort((a, b) =>
      a.key === 'ask-claude' ? 1 : b.key === 'ask-claude' ? -1 : byCount(a, b)
    )
  }
}

/** A stable color for a tag name. */
const TAG_COLORS = [
  '#e5484d',
  '#f76b15',
  '#ffc53d',
  '#46a758',
  '#12a594',
  '#0090ff',
  '#6e56cf',
  '#d6409f',
  '#8e8c99'
]
export function tagColor(tag: string): string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]
}

/**
 * Put branches right under their parent (when the parent is in the list too).
 * A family sits where its highest-ranked member would be.
 */
export function groupBranches(list: SessionSummary[]): {
  items: SessionSummary[]
  depth: Map<string, number>
} {
  const index = new Map(list.map((s, i) => [s.key, i]))
  const children = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of list) {
    const p = s.lineage?.parentKey
    if (p && p !== s.key && index.has(p)) {
      const c = children.get(p) ?? []
      c.push(s)
      children.set(p, c)
    } else roots.push(s)
  }
  const rank = new Map<string, number>()
  const rankOf = (s: SessionSummary, seen: Set<string>): number => {
    const cached = rank.get(s.key)
    if (cached !== undefined) return cached
    seen.add(s.key)
    let r = index.get(s.key)!
    for (const c of children.get(s.key) ?? [])
      if (!seen.has(c.key)) r = Math.min(r, rankOf(c, seen))
    rank.set(s.key, r)
    return r
  }
  const items: SessionSummary[] = []
  const depth = new Map<string, number>()
  const walk = (s: SessionSummary, d: number): void => {
    if (depth.has(s.key)) return
    depth.set(s.key, d)
    items.push(s)
    for (const c of children.get(s.key) ?? []) walk(c, d + 1)
  }
  for (const r of [...roots].sort((a, b) => rankOf(a, new Set()) - rankOf(b, new Set()))) walk(r, 0)
  // Anything left over (only possible with a broken parent loop) keeps its place at the end.
  for (const s of list) walk(s, 0)
  return { items, depth }
}

/** Number of direct branches of each session. */
export function branchCounts(sessions: SessionSummary[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sessions) {
    const p = s.lineage?.parentKey
    if (p) out.set(p, (out.get(p) ?? 0) + 1)
  }
  return out
}
