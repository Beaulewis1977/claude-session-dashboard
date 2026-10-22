import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { tagColor } from '@/lib/filters'
import { cn } from '@/lib/utils'

/** Inline-editable session name (wraps to several lines). Empty = use the automatic title. */
export function EditableTitle({
  session,
  onSave,
  focusNonce
}: {
  session: SessionSummary
  onSave: (name: string) => void
  focusNonce: number
}) {
  const [value, setValue] = useState(session.meta.name ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const autoTitle = session.titleSource === 'name' ? '' : session.title
  useEffect(() => {
    if (focusNonce) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [focusNonce])
  useAutoGrow(ref, value || autoTitle, 120)
  const commit = (): void => {
    if (value.trim() !== (session.meta.name ?? '')) onSave(value.trim())
  }
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setValue(session.meta.name ?? '')
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      placeholder={autoTitle || 'Name this session'}
      aria-label="Session name"
      spellCheck={false}
      className="-mx-1.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-md bg-transparent px-1.5 py-0.5 text-[19px] leading-[1.3] font-semibold tracking-[-0.015em] text-foreground outline-none transition-colors placeholder:text-foreground hover:bg-hover focus:bg-background focus:ring-2 focus:ring-ring/30 focus:placeholder:text-subtle-foreground"
    />
  )
}

/** Grow a textarea with its content, up to `max` pixels. */
function useAutoGrow(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  max: number
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      el.style.height = '0px'
      el.style.height = `${Math.min(el.scrollHeight, max)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, value, max])
}

export function DescriptionEditor({
  session,
  onSave,
  focusNonce
}: {
  session: SessionSummary
  onSave: (d: string) => void
  focusNonce: number
}) {
  const [value, setValue] = useState(session.meta.description ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focusNonce) ref.current?.focus()
  }, [focusNonce])
  useAutoGrow(ref, value, 220)
  const commit = (): void => {
    if (value.trimEnd() !== (session.meta.description ?? '')) onSave(value.trimEnd())
  }
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setValue(session.meta.description ?? '')
          requestAnimationFrame(() => ref.current?.blur())
        }
      }}
      placeholder="Add a description…"
      aria-label="Session description"
      className="-mx-1.5 block w-[calc(100%+12px)] resize-none rounded-md bg-transparent px-1.5 py-1 text-[13px] leading-relaxed text-muted-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:bg-hover focus:bg-background focus:text-foreground focus:ring-2 focus:ring-ring/30"
    />
  )
}

export function TagChip({
  tag,
  onRemove,
  className
}: {
  tag: string
  onRemove?: () => void
  className?: string
}) {
  return (
    <span
      className={cn(
        'group/tag inline-flex h-5 items-center gap-1 rounded-[5px] bg-secondary pr-1 pl-1.5 text-2xs font-medium text-foreground/85',
        !onRemove && 'pr-1.5',
        className
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tagColor(tag) }} />
      {tag}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag}`}
          onClick={onRemove}
          className="ml-0.5 rounded-sm p-px text-subtle-foreground opacity-60 hover:bg-hover hover:text-foreground hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

export function TagEditor({
  tags,
  allTags,
  onChange,
  focusNonce
}: {
  tags: string[]
  allTags: string[]
  onChange: (tags: string[]) => void
  focusNonce: number
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [active, setActive] = useState(-1)
  const ref = useRef<HTMLInputElement>(null)
  // Open the input when a focus request arrives (adjusting state during render).
  const [seenNonce, setSeenNonce] = useState(focusNonce)
  if (focusNonce !== seenNonce) {
    setSeenNonce(focusNonce)
    if (focusNonce) setAdding(true)
  }
  useEffect(() => {
    if (adding) ref.current?.focus()
  }, [adding])

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    return allTags.filter((t) => !tags.includes(t) && (!q || t.includes(q))).slice(0, 6)
  }, [allTags, tags, draft])

  const add = (t: string): void => {
    const tag = t.trim().replace(/\s+/g, '-').toLowerCase()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
    setActive(-1)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <TagChip key={t} tag={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />
      ))}
      {adding ? (
        <div className="relative">
          <input
            ref={ref}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setActive(-1)
            }}
            onBlur={() => {
              if (draft.trim()) add(draft)
              setAdding(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && suggestions.length) {
                // Tab completes the highlighted (or first) suggestion.
                e.preventDefault()
                add(suggestions[Math.max(active, 0)])
              } else if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                if (active >= 0 && suggestions[active]) add(suggestions[active])
                else if (draft.trim()) add(draft)
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, suggestions.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, -1))
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDraft('')
                setAdding(false)
              } else if (e.key === 'Backspace' && !draft && tags.length) {
                onChange(tags.slice(0, -1))
              }
            }}
            placeholder="tag name"
            aria-label="Add tag"
            spellCheck={false}
            className="h-5 w-28 rounded-[5px] border border-ring/50 bg-background px-1.5 text-2xs outline-none ring-2 ring-ring/20"
          />
          {suggestions.length > 0 && (
            <div className="absolute top-6 left-0 z-30 w-44 rounded-lg border border-border bg-popover p-1 shadow-lg">
              {suggestions.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(s)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs',
                    i === active ? 'bg-hover text-foreground' : 'text-muted-foreground'
                  )}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: tagColor(s) }}
                  />
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-5 items-center gap-1 rounded-[5px] border border-dashed border-border-strong px-1.5 text-2xs font-medium text-muted-foreground transition-colors hover:border-solid hover:bg-hover hover:text-foreground"
        >
          <Plus className="size-3" />
          {tags.length ? 'Tag' : 'Add tag'}
        </button>
      )}
    </div>
  )
}
