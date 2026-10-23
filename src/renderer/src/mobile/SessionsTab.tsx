import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { toast } from 'sonner'
import { ListFilter, Search, SearchX, X } from 'lucide-react'
import { api } from '@/lib/api'
import { toggleHidden, togglePinned } from '@/lib/actions'
import {
  clearedFilters,
  EMPTY_FILTERS,
  facets,
  presetRange,
  visibleSessions,
  type DateRange,
  type Filters,
  type SortKey
} from '@/lib/filters'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { phone } from '@/lib/web-api'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { SessionCard } from './SessionCard'
import { useMobile } from './state'

function useConnection(): ReturnType<typeof phone.connection> {
  const [c, setC] = useState(phone.connection)
  useEffect(() => phone.onConnection(setC), [])
  return c
}

/** Debounced full-text search on the PC (the same index as the desktop). */
function useSearch(): [string, (q: string) => void] {
  const query = useApp((s) => s.query)
  const set = useApp((s) => s.set)
  const timer = useRef<number | undefined>(undefined)
  const setQuery = (q: string): void => {
    const st = useApp.getState()
    if (q.trim() && !st.query.trim())
      set({ query: q, sortBeforeSearch: st.sort, sort: 'relevance' })
    else if (!q.trim())
      set({ query: q, hits: null, sort: st.sort === 'relevance' ? st.sortBeforeSearch : st.sort })
    else set({ query: q })
    window.clearTimeout(timer.current)
    if (!q.trim()) return
    timer.current = window.setTimeout(() => {
      void api
        .search(q.trim())
        .then((hits) => {
          if (useApp.getState().query === q) set({ hits: new Map(hits.map((h) => [h.key, h])) })
        })
        .catch(() => undefined)
    }, 220)
  }
  return [query, setQuery]
}

function Chip({
  active,
  onClick,
  children
}: {
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-8 max-w-full items-center gap-1.5 truncate rounded-full border px-3 text-[13px] font-medium transition-colors',
        active
          ? 'border-primary/40 bg-accent-soft text-primary'
          : 'border-border bg-background text-foreground/80'
      )}
    >
      {children}
    </button>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <div className="mb-2 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

const SORTS: [SortKey, string][] = [
  ['activity', 'Last activity'],
  ['started', 'Start time'],
  ['name', 'Name']
]

const DATES: [NonNullable<DateRange['preset']>, string][] = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['year', 'This year']
]

function FilterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useApp((s) => s.sessions)
  const filters = useApp((s) => s.filters)
  const sort = useApp((s) => s.sort)
  const set = useApp((s) => s.set)
  const setFilters = useApp((s) => s.setFilters)
  const f = useMemo(() => facets(sessions, filters), [sessions, filters])
  const toggle = <K extends keyof Filters>(k: K, v: Filters[K]): void =>
    setFilters({ [k]: filters[k] === v ? EMPTY_FILTERS[k] : v } as Partial<Filters>)

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Filter and sort">
        <div className="divide-y divide-border">
          <Group title="Sort by">
            {SORTS.map(([k, label]) => (
              <Chip key={k} active={sort === k} onClick={() => set({ sort: k })}>
                {label}
              </Chip>
            ))}
          </Group>
          <Group title="Show">
            <Chip
              active={filters.visibility === 'visible'}
              onClick={() => setFilters({ visibility: 'visible' })}
            >
              Visible · {f.views.visible}
            </Chip>
            <Chip
              active={filters.visibility === 'hidden'}
              onClick={() => setFilters({ visibility: 'hidden' })}
            >
              Hidden · {f.views.hidden}
            </Chip>
            <Chip
              active={filters.visibility === 'archived'}
              onClick={() => setFilters({ visibility: 'archived' })}
            >
              Archived only · {f.views.archived}
            </Chip>
            <Chip
              active={filters.visibility === 'all'}
              onClick={() => setFilters({ visibility: 'all' })}
            >
              All
            </Chip>
          </Group>
          <Group title="When">
            {DATES.map(([k, label]) => (
              <Chip
                key={k}
                active={filters.date?.preset === k}
                onClick={() =>
                  setFilters({ date: filters.date?.preset === k ? null : presetRange(k) })
                }
              >
                {label}
              </Chip>
            ))}
          </Group>
          {f.env.length > 1 && (
            <Group title="Environment">
              {f.env.map((e) => (
                <Chip
                  key={e.key}
                  active={filters.env === e.key}
                  onClick={() => toggle('env', e.key)}
                >
                  {e.label} · {e.count}
                </Chip>
              ))}
            </Group>
          )}
          <Group title="Project">
            {f.project.slice(0, 30).map((p) => (
              <Chip
                key={p.key}
                active={filters.project === p.key}
                onClick={() => toggle('project', p.key)}
              >
                {p.label} · {p.count}
              </Chip>
            ))}
          </Group>
          {f.tag.length > 0 && (
            <Group title="Tag">
              {f.tag.map((t) => (
                <Chip
                  key={t.key}
                  active={filters.tag === t.key}
                  onClick={() => toggle('tag', t.key)}
                >
                  #{t.label} · {t.count}
                </Chip>
              ))}
            </Group>
          )}
        </div>
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            className="h-11 flex-1"
            onClick={() => set({ filters: clearedFilters(EMPTY_FILTERS) })}
          >
            Clear all
          </Button>
          <Button variant="primary" className="h-11 flex-1" onClick={onClose}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function activeFilterCount(f: Filters): number {
  return (
    (f.visibility !== 'visible' ? 1 : 0) +
    (f.env ? 1 : 0) +
    (f.project ? 1 : 0) +
    (f.tag ? 1 : 0) +
    (f.date ? 1 : 0) +
    (f.source ? 1 : 0)
  )
}

export function SessionsTab() {
  const sessions = useApp((s) => s.sessions)
  const filters = useApp((s) => s.filters)
  const sort = useApp((s) => s.sort)
  const hits = useApp((s) => s.hits)
  const loaded = useApp((s) => s.loaded)
  const select = useApp((s) => s.select)
  const readOnly = useMobile((s) => s.me?.readOnly) ?? false
  const [query, setQuery] = useSearch()
  const [filterOpen, setFilterOpen] = useState(false)
  const conn = useConnection()
  const items = useMemo(
    () => visibleSessions(sessions, filters, sort, hits),
    [sessions, filters, sort, hits]
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 118,
    overscan: 6,
    getItemKey: (i) => items[i].key
  })
  const nFilters = activeFilterCount(filters)

  const guard = (fn: (key: string) => Promise<void>) => (key: string) => {
    if (readOnly) toast('Read-only mode is on', { description: 'Change it on your PC.' })
    else
      void fn(key).catch((err: Error) => toast.error("Couldn't save", { description: err.message }))
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-border bg-chrome/95 px-4 pt-[calc(env(safe-area-inset-top)+10px)] pb-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-[22px] font-semibold tracking-[-0.015em]">Sessions</h1>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
              conn === 'live' ? 'bg-success/10 text-success' : 'bg-secondary text-muted-foreground'
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                conn === 'live' ? 'bg-success' : 'animate-pulse bg-subtle-foreground'
              )}
            />
            {conn === 'live' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions"
              enterKeyHint="search"
              aria-label="Search sessions"
              className="h-10 w-full rounded-xl border border-border bg-background pr-9 pl-9 text-[15px] outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-ring/30"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            className="relative size-10 shrink-0 rounded-xl p-0"
            onClick={() => setFilterOpen(true)}
            aria-label="Filter and sort"
          >
            <ListFilter className="size-[18px]" />
            {nFilters > 0 && (
              <span className="absolute -top-1 -right-1 flex size-4.5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                {nFilters}
              </span>
            )}
          </Button>
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-3">
        {!loaded ? (
          <div className="space-y-3 px-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-[106px] animate-pulse rounded-xl bg-secondary" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center px-8 pt-16 text-center text-muted-foreground">
            <SearchX className="size-8 text-subtle-foreground" />
            <div className="mt-3 text-[15px] font-medium text-foreground">No sessions match</div>
            <p className="mt-1 text-[13px]">Try another search, or clear the filters.</p>
          </div>
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={v.measureElement}
                className="absolute inset-x-0 pb-2.5"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <SessionCard
                  session={items[row.index]}
                  onOpen={select}
                  onPin={guard(togglePinned)}
                  onHide={guard(toggleHidden)}
                  readOnly={readOnly}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <FilterSheet open={filterOpen} onClose={() => setFilterOpen(false)} />
    </div>
  )
}
