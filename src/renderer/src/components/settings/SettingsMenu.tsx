// The sidebar while Settings is open: "← Back to sessions", the settings
// search, and a menu of the page's sections (and the sub-headings of the big
// ones). The section in view is highlighted (scroll-spy), and an amber dot
// says when something in a section needs attention.

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowLeft, Search, X } from 'lucide-react'
import { SECTIONS, type SectionId } from '@shared/settings-registry'
import { useApp } from '@/lib/store'
import { cn, MOD } from '@/lib/utils'
import { settingsUi, useMatchCounts, useSettingsUi } from '@/lib/settings-ui'
import { useSettingsAttention, type Attention } from '@/lib/settings-attention'
import { Tooltip } from '../ui/tooltip'
import { openSettingsTarget } from '@/lib/settings-actions'
import { SectionIcon } from './page'

/** The settings search (in the menu, or on the page while the sidebar is hidden). */
export function SettingsSearchField({ className }: { className?: string }) {
  const query = useSettingsUi((s) => s.query)
  const focusToken = useSettingsUi((s) => s.focusSearch)
  const { total } = useMatchCounts()
  const ref = useRef<HTMLInputElement>(null)
  const searching = query.trim() !== ''

  useEffect(() => {
    const el = ref.current
    // Only the field that's on screen (the menu's is inert while the sidebar is hidden).
    if (!focusToken || !el || el.closest('[inert]') || !el.offsetParent) return
    el.focus()
    el.select()
  }, [focusToken])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (query) settingsUi.setQuery('')
    else ref.current?.blur()
  }

  return (
    <div role="search" className={className}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground"
          aria-hidden
        />
        <input
          ref={ref}
          type="search"
          value={query}
          onChange={(e) => settingsUi.setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-describedby="settings-search-count"
          aria-keyshortcuts={`${MOD === '⌘' ? 'Meta' : 'Control'}+F`}
          spellCheck={false}
          className="h-7 w-full rounded-md border border-border bg-background pr-7 pl-7 text-[12.5px] outline-none placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:hidden"
          data-settings-search
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              settingsUi.setQuery('')
              ref.current?.focus()
            }}
            aria-label="Clear the search"
            className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <div
        id="settings-search-count"
        aria-live="polite"
        className={cn('mt-1 px-0.5 text-2xs text-muted-foreground', !searching && 'sr-only')}
        data-settings-count
      >
        {searching
          ? total === 0
            ? 'No results'
            : `${total} result${total === 1 ? '' : 's'}`
          : 'Type to filter the settings'}
      </div>
    </div>
  )
}

function AttentionDot({ items, section }: { items: Attention[]; section: string }) {
  const first = items[0]
  return (
    <Tooltip
      side="right"
      content={
        <span className="block space-y-1">
          {items.map((a, i) => (
            <span key={i} className="block">
              {a.message}
            </span>
          ))}
          <span className="block text-muted-foreground">Click to go there.</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={() => openSettingsTarget(first.target)}
        aria-label={`Needs attention: ${items.map((a) => a.message).join(' ')}`}
        className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        data-attention={section}
      >
        <span className="size-2 rounded-full bg-warning shadow-[0_0_0_2px_var(--chrome)]" />
      </button>
    </Tooltip>
  )
}

/** Up / Down / Home / End move between the menu's items (one tab stop for the list). */
function onMenuKeys(e: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not([hidden])')
  ].filter((b) => !b.closest('[hidden]'))
  if (!items.length) return
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : e.key === 'ArrowDown'
          ? Math.min(items.length - 1, i + 1)
          : Math.max(0, i < 0 ? 0 : i - 1)
  e.preventDefault()
  items[next].focus()
}

export function SettingsMenu() {
  const set = useApp((s) => s.set)
  const open = useApp((s) => s.view === 'settings')
  const active = useSettingsUi((s) => s.active)
  const query = useSettingsUi((s) => s.query)
  const { bySection, bySub } = useMatchCounts()
  const attention = useSettingsAttention(open)
  const searching = query.trim() !== ''
  const navRef = useRef<HTMLElement>(null)
  const activeId = active.sub ?? active.section
  // One tab stop: the item in view (or the first one listed).
  const listed = SECTIONS.flatMap((s) =>
    bySection[s.id]
      ? [s.id as string, ...(s.subsections ?? []).filter((u) => bySub[u.id]).map((u) => u.id)]
      : []
  )
  const tabbable = listed.includes(activeId)
    ? activeId
    : listed.includes(active.section)
      ? active.section
      : listed[0]

  // Keep the item in view highlighted, scrolled into the menu.
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>(`[data-menu-item="${activeId}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  return (
    <div className="flex h-full flex-col bg-chrome" aria-label="Settings menu">
      <div className="shrink-0 space-y-2 px-2 pt-2 pb-2">
        <button
          type="button"
          onClick={() => set({ view: 'sessions' })}
          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground/75 hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          data-back-to-sessions
        >
          <ArrowLeft className="size-[15px] text-muted-foreground" aria-hidden /> Back to sessions
        </button>
        <SettingsSearchField className="px-0.5" />
      </div>
      <nav
        ref={navRef}
        aria-label="Settings sections"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onKeyDown={onMenuKeys}
      >
        <ul className="space-y-px">
          {SECTIONS.map((s) => {
            const count = bySection[s.id] ?? 0
            // Sections with nothing on the page (e.g. Git without a git) and, during a search,
            // sections without matches aren't listed.
            if (!count) return null
            const subs = (s.subsections ?? []).filter((u) => (bySub[u.id] ?? 0) > 0)
            const isActive = active.section === s.id
            const att = attention[s.id as SectionId]
            return (
              <li key={s.id}>
                <div className="relative">
                  <button
                    type="button"
                    data-menu-item={s.id}
                    tabIndex={tabbable === s.id ? 0 : -1}
                    aria-current={isActive && !active.sub ? 'location' : undefined}
                    onClick={() => openSettingsTarget(s.id)}
                    className={cn(
                      'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 pr-7 text-left text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                      isActive
                        ? 'bg-selected font-medium text-foreground'
                        : 'text-foreground/75 hover:bg-hover hover:text-foreground'
                    )}
                  >
                    <SectionIcon id={s.id} className="size-[15px] shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {searching && (
                      <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">
                        {count}
                      </span>
                    )}
                  </button>
                  {att && att.length > 0 && <AttentionDot items={att} section={s.id} />}
                </div>
                {subs.length > 0 && (
                  <ul className="mt-px mb-1 space-y-px" aria-label={`${s.title} sub-sections`}>
                    {subs.map((u) => {
                      const subActive = isActive && active.sub === u.id
                      return (
                        <li key={u.id}>
                          <button
                            type="button"
                            data-menu-item={u.id}
                            tabIndex={tabbable === u.id ? 0 : -1}
                            aria-current={subActive ? 'location' : undefined}
                            onClick={() => openSettingsTarget(u.id)}
                            className={cn(
                              'relative flex h-6 w-full min-w-0 items-center rounded-md pr-2 pl-[30px] text-left text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
                              subActive
                                ? 'font-medium text-foreground'
                                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                            )}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                'absolute top-1 bottom-1 left-[15px] w-px rounded-full',
                                subActive ? 'w-[2px] bg-primary' : 'bg-border-strong'
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">{u.title}</span>
                            {searching && (
                              <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">
                                {bySub[u.id]}
                              </span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
