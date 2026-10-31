import { useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderSearch, SearchX } from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { useApp } from '@/lib/store'
import { EMPTY_FILTERS } from '@/lib/filters'
import { pick, pickedVisible } from '@/lib/multi-select'
import { Button } from '@/components/ui/button'
import { ListToolbar } from './ListToolbar'
import { ROW_HEIGHT, SessionRow } from './SessionRow'
import { RowMenu } from './RowMenu'
import { BulkBar } from './BulkBar'

function EmptyList({ kind }: { kind: 'none' | 'filtered' | 'search' }) {
  const set = useApp((s) => s.set)
  const query = useApp((s) => s.query)
  const visibility = useApp((s) => s.filters.visibility)
  if (kind === 'none') {
    return (
      <div className="flex flex-col items-center px-8 pt-20 text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-background shadow-xs">
          <FolderSearch className="size-5 text-muted-foreground" />
        </div>
        <div className="text-sm font-medium">No Claude Code sessions found</div>
        <p className="mt-1.5 max-w-[260px] text-xs leading-relaxed text-muted-foreground">
          Sessions appear here as soon as Claude Code writes them to{' '}
          <span className="font-mono">.claude/projects</span> on Windows or in WSL. You can also add
          other folders to scan.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => set({ view: 'settings' })}
        >
          Open scan settings
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center px-8 pt-20 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-background shadow-xs">
        <SearchX className="size-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium">
        {kind === 'search' ? `No results for “${query.trim()}”` : 'No sessions match'}
      </div>
      <p className="mt-1.5 max-w-[260px] text-xs text-muted-foreground">
        {visibility === 'hidden'
          ? 'Hidden sessions show up here.'
          : visibility === 'archived'
            ? 'Sessions whose original file was cleaned up by Claude Code show up here.'
            : 'Try a different search or clear the filters.'}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        onClick={() => set({ query: '', hits: null, filters: EMPTY_FILTERS })}
      >
        Clear search and filters
      </Button>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="space-y-1 px-2 pt-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-[98px] flex-col justify-center gap-2 rounded-lg px-3">
          <div className="h-3 w-3/5 animate-pulse rounded bg-secondary" />
          <div className="h-2.5 w-4/5 animate-pulse rounded bg-secondary" />
          <div className="h-2.5 w-2/5 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  )
}

export function SessionList({
  items,
  total,
  depth,
  branchCounts
}: {
  items: SessionSummary[]
  total: number
  /** Nesting depth per key when branches are grouped under their parent. */
  depth?: Map<string, number>
  branchCounts?: Map<string, number>
}) {
  const selectedKey = useApp((s) => s.selectedKey)
  const hits = useApp((s) => s.hits)
  const loaded = useApp((s) => s.loaded)
  const scan = useApp((s) => s.scan)
  const checked = useApp((s) => s.checked)
  const select = useApp((s) => s.select)
  const requestFocus = useApp((s) => s.requestFocus)
  const parentRef = useRef<HTMLDivElement>(null)

  const keys = useMemo(() => items.map((s) => s.key), [items])
  const keysRef = useRef(keys)
  useEffect(() => {
    keysRef.current = keys
  }, [keys])
  const picked = useMemo(() => {
    const visible = new Set(pickedVisible(keys, checked))
    return items.filter((s) => visible.has(s.key))
  }, [items, keys, checked])
  const pickedKeys = useMemo(() => new Set(picked.map((s) => s.key)), [picked])

  // Click: select. Ctrl/⌘+click: add or remove. Shift+click: a range.
  // Right-click keeps a multi-selection the row is part of (for the bulk menu).
  const onSelect = useCallback(
    (key: string, e: MouseEvent) => {
      const st = useApp.getState()
      if (e.button === 2) {
        if (!st.checked.includes(key)) select(key)
        return
      }
      if (e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        e.preventDefault()
        const next = pick(
          keysRef.current,
          { selectedKey: st.selectedKey, checked: st.checked },
          key,
          e.shiftKey ? 'range' : 'toggle'
        )
        st.set(next)
        return
      }
      select(key)
    },
    [select]
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    paddingStart: 6,
    paddingEnd: 12
  })

  // Keep the selection in view.
  const index = items.findIndex((s) => s.key === selectedKey)
  useEffect(() => {
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [index, virtualizer])

  const scanning = scan.phase !== 'ready'
  const emptyKind = total === 0 ? 'none' : hits ? 'search' : 'filtered'

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <ListToolbar count={items.length} />
      {picked.length > 1 && <BulkBar picked={picked} />}
      {scanning && scan.total > 0 && (
        <div className="h-0.5 shrink-0 bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${(scan.done / scan.total) * 100}%` }}
          />
        </div>
      )}
      <div
        ref={parentRef}
        id="session-list"
        role="listbox"
        aria-label="Sessions"
        aria-activedescendant={selectedKey ? `row-${selectedKey}` : undefined}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
      >
        {!loaded || (scanning && items.length === 0) ? (
          <SkeletonRows />
        ) : items.length === 0 ? (
          <EmptyList kind={emptyKind} />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const s = items[v.index]
              return (
                <RowMenu key={s.key} session={s} picked={pickedKeys.has(s.key) ? picked : []}>
                  <div
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      height: v.size,
                      transform: `translateY(${v.start}px)`
                    }}
                  >
                    <SessionRow
                      session={s}
                      selected={s.key === selectedKey}
                      checked={pickedKeys.has(s.key)}
                      hit={hits?.get(s.key)}
                      depth={depth?.get(s.key) ?? 0}
                      branches={branchCounts?.get(s.key) ?? 0}
                      onSelect={onSelect}
                      onOpen={() => requestFocus('name')}
                    />
                  </div>
                </RowMenu>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
