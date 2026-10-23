import { useEffect, useRef, useState } from 'react'
import { ArrowDownWideNarrow, CalendarDays, Check, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import {
  clearedFilters,
  envLabel,
  presetRange,
  projectKey,
  type DateRange,
  type SortKey
} from '@/lib/filters'
import { SOURCE_LABELS, type SourceLabel } from '@shared/source-label'
import { saveGroupBranches, useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip } from '@/components/ui/tooltip'

const SORT_LABELS: Record<SortKey, string> = {
  activity: 'Last activity',
  started: 'Start time',
  name: 'Name',
  relevance: 'Relevance'
}

const PRESETS: { key: NonNullable<DateRange['preset']>; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'year', label: 'This year' }
]

function dateLabel(d: DateRange): string {
  const p = PRESETS.find((x) => x.key === d.preset)
  if (p) return p.label
  const fmt = (ymd?: string): string =>
    ymd
      ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '…'
  return `${fmt(d.from)} – ${fmt(d.to)}`
}

function DateFilter() {
  const date = useApp((s) => s.filters.date)
  const setFilters = useApp((s) => s.setFilters)
  const [open, setOpen] = useState(false)
  const custom = date ?? presetRange('30d')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Filter by date">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Filter by date"
            className={cn(date && 'text-primary')}
          >
            <CalendarDays />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-64 p-1.5">
        <div className="px-1.5 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-subtle-foreground uppercase">
          Last activity
        </div>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => {
              setFilters({ date: date?.preset === p.key ? null : presetRange(p.key) })
              setOpen(false)
            }}
            className="flex h-8 w-full items-center rounded-md px-2 text-[13px] hover:bg-hover"
          >
            {p.label}
            {date?.preset === p.key && <Check className="ml-auto size-4" />}
          </button>
        ))}
        <div className="mt-1 border-t border-border px-1.5 pt-2.5 pb-1.5">
          <div className="mb-1.5 text-2xs font-medium text-muted-foreground">Custom range</div>
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="From date"
              value={custom.from ?? ''}
              max={custom.to}
              onChange={(e) =>
                setFilters({
                  date: { ...custom, preset: 'custom', from: e.target.value || undefined }
                })
              }
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus:border-ring"
            />
            <span className="text-subtle-foreground">–</span>
            <input
              type="date"
              aria-label="To date"
              value={custom.to ?? ''}
              min={custom.from}
              onChange={(e) =>
                setFilters({
                  date: { ...custom, preset: 'custom', to: e.target.value || undefined }
                })
              }
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus:border-ring"
            />
          </div>
          {date && (
            <Button
              variant="ghost"
              size="xs"
              className="mt-2 w-full"
              onClick={() => {
                setFilters({ date: null })
                setOpen(false)
              }}
            >
              Clear date filter
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 max-w-[180px] items-center gap-1 rounded-md border border-border bg-background pr-0.5 pl-2 text-2xs font-medium text-foreground/85 shadow-xs">
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="rounded p-0.5 text-subtle-foreground hover:bg-hover hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function ListToolbar({ count }: { count: number }) {
  const query = useApp((s) => s.query)
  const sort = useApp((s) => s.sort)
  const filters = useApp((s) => s.filters)
  const sessions = useApp((s) => s.sessions)
  const set = useApp((s) => s.set)
  const setFilters = useApp((s) => s.setFilters)
  const focus = useApp((s) => s.focus)
  const grouped = useApp((s) => s.groupBranches)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focus.field === 'search' && focus.nonce) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [focus])

  // Debounced full-text search in the main process.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      set({ hits: null })
      return
    }
    const t = setTimeout(() => {
      void api.search(q).then((hits) => {
        if (useApp.getState().query.trim() === q)
          set({ hits: new Map(hits.map((h) => [h.key, h])) })
      })
    }, 120)
    return () => clearTimeout(t)
  }, [query, sessions, set])

  const onQuery = (q: string): void => {
    const st = useApp.getState()
    if (q.trim() && !st.query.trim())
      set({ query: q, sortBeforeSearch: st.sort, sort: 'relevance' })
    else if (!q.trim() && st.query.trim())
      set({ query: q, sort: st.sort === 'relevance' ? st.sortBeforeSearch : st.sort })
    else set({ query: q })
  }

  const projectLabel = filters.project
    ? (sessions.find((s) => projectKey(s) === filters.project)?.projectName ?? filters.project)
    : null
  const chips = [
    filters.env && {
      k: 'env',
      label: envLabel(filters.env),
      clear: () => setFilters({ env: null })
    },
    filters.project && {
      k: 'project',
      label: projectLabel ?? '',
      clear: () => setFilters({ project: null })
    },
    filters.source && {
      k: 'source',
      label: SOURCE_LABELS[filters.source as SourceLabel] ?? filters.source,
      clear: () => setFilters({ source: null })
    },
    filters.tag && { k: 'tag', label: `#${filters.tag}`, clear: () => setFilters({ tag: null }) },
    filters.date && {
      k: 'date',
      label: dateLabel(filters.date),
      clear: () => setFilters({ date: null })
    }
  ].filter(Boolean) as { k: string; label: string; clear: () => void }[]

  return (
    <div className="shrink-0 border-b border-border px-3 pt-3 pb-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              if (query) onQuery('')
              else e.currentTarget.blur()
            } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
              document.getElementById('session-list')?.focus()
            }
          }}
          placeholder="Search names, tags and messages"
          aria-label="Search sessions"
          spellCheck={false}
          className="h-8 w-full rounded-md border border-input bg-background pr-14 pl-8 text-[13px] shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus:border-ring focus:ring-3 focus:ring-ring/20"
        />
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1">
          {query ? (
            <button
              type="button"
              onClick={() => onQuery('')}
              aria-label="Clear search"
              className="rounded p-1 text-subtle-foreground hover:bg-hover hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </div>
      </div>
      <div className="mt-2 flex min-h-6 items-center gap-1.5">
        <span className="mr-auto pl-0.5 text-2xs text-muted-foreground tabular-nums">
          {count.toLocaleString()} session{count === 1 ? '' : 's'}
        </span>
        <DateFilter />
        <DropdownMenu>
          <Tooltip content="Sort">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1 px-2 text-2xs">
                <ArrowDownWideNarrow /> {SORT_LABELS[sort]}
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent className="w-56">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => set({ sort: v as SortKey })}>
              {(query.trim()
                ? (['relevance', 'activity', 'started', 'name'] as SortKey[])
                : (['activity', 'started', 'name'] as SortKey[])
              ).map((k) => (
                <DropdownMenuRadioItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={grouped}
              onCheckedChange={(v) => {
                set({ groupBranches: v === true })
                saveGroupBranches(v === true)
              }}
            >
              Group branches under parent
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {chips.map((c) => (
            <Chip key={c.k} label={c.label} onClear={c.clear} />
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              onClick={() => set({ filters: clearedFilters(filters) })}
              className="ml-0.5 rounded px-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  )
}
