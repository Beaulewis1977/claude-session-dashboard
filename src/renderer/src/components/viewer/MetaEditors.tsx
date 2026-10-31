import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { SessionSummary } from '@shared/types'
import { canUseClaudeName, titleSourceLabel } from '@shared/title'
import { applyClaudeNames } from '@/lib/actions'
import { tagColor } from '@/lib/filters'
import { cn } from '@/lib/utils'

interface Draft {
  text: string
  /** The value when editing started (a save happens only if the text differs). */
  base: string
  focused: boolean
  /** Saved, waiting for the update: shown until the value changes from this. */
  savedOver?: string
}

/**
 * Text being edited while the value can change underneath (a rename in Claude
 * Code, an edit from the phone). While the box is focused or has unsaved
 * changes, live updates don't replace the text; they show after blur or save.
 */
function useDraft(current: string) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const cancelled = useRef(false)
  // A saved draft gives way once the update arrives (adjusting state during render).
  if (draft && !draft.focused && draft.savedOver !== undefined && current !== draft.savedOver) {
    setDraft(null)
  }
  return {
    value: draft ? draft.text : current,
    editing: !!draft?.focused,
    dirty: !!draft && draft.text !== draft.base,
    begin: (): void => {
      cancelled.current = false
      setDraft((d) =>
        d
          ? { ...d, focused: true, savedOver: undefined }
          : { text: current, base: current, focused: true }
      )
    },
    change: (text: string): void =>
      setDraft((d) => ({ text, base: d?.base ?? current, focused: true })),
    /** Blur: returns the text to save, if it changed. */
    end: (clean: (t: string) => string): string | undefined => {
      if (cancelled.current || !draft) {
        setDraft(null)
        return undefined
      }
      const text = clean(draft.text)
      if (text === clean(draft.base)) {
        setDraft(null)
        return undefined
      }
      setDraft({ text, base: text, focused: false, savedOver: current })
      return text
    },
    /** Escape: drop the draft (the blur that follows saves nothing). */
    cancel: (): void => {
      cancelled.current = true
      setDraft(null)
    }
  }
}

/**
 * Inline-editable session name (wraps to several lines). It holds my dashboard
 * name while that is the title; otherwise it's empty and shows the title (the
 * Claude Code name, or the automatic one) as its placeholder. Empty = no
 * dashboard name. A rename in Claude Code while I'm typing doesn't replace my
 * draft: it's offered under the box instead.
 */
export function EditableTitle({
  session,
  onSave,
  focusNonce
}: {
  session: SessionSummary
  onSave: (name: string) => void
  focusNonce: number
}) {
  // A dashboard name that a newer rename in Claude Code replaced isn't shown.
  const own = session.titleSource === 'name' ? (session.meta.name ?? '') : ''
  const d = useDraft(own)
  // The title when editing started, to notice a rename in Claude Code meanwhile.
  const [startTitle, setStartTitle] = useState(session.title)
  const ref = useRef<HTMLTextAreaElement>(null)
  const autoTitle = session.titleSource === 'name' ? '' : session.title
  useEffect(() => {
    if (focusNonce) {
      ref.current?.focus()
      ref.current?.select()
    }
  }, [focusNonce])
  useAutoGrow(ref, d.value || autoTitle, 120)
  const renamedMeanwhile =
    d.editing && session.titleSource === 'claude-name' && session.title !== startTitle
  return (
    <>
      <textarea
        ref={ref}
        rows={1}
        value={d.value}
        onFocus={() => {
          if (!d.editing) setStartTitle(session.title)
          d.begin()
        }}
        onChange={(e) => d.change(e.target.value.replace(/\n/g, ' '))}
        onBlur={() => {
          const name = d.end((t) => t.trim())
          if (name !== undefined) onSave(name)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            d.cancel()
            requestAnimationFrame(() => ref.current?.blur())
          }
        }}
        placeholder={autoTitle || 'Name this session'}
        aria-label="Session name"
        spellCheck={false}
        className="-mx-1.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-md bg-transparent px-1.5 py-0.5 text-[19px] leading-[1.3] font-semibold tracking-[-0.015em] text-foreground outline-none transition-colors placeholder:text-foreground hover:bg-hover focus:bg-background focus:ring-2 focus:ring-ring/30 focus:placeholder:text-subtle-foreground"
      />
      {renamedMeanwhile && (
        <div
          data-testid="renamed-meanwhile"
          className="mt-1 flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground"
        >
          <span>Renamed in Claude Code to “{session.title}”.</span>
          <button
            type="button"
            // Keep the focus in the box, so the draft isn't saved first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              d.cancel()
              ref.current?.blur()
            }}
            className="font-medium text-primary hover:underline"
          >
            Use it
          </button>
          <span>or keep typing to set your own.</span>
        </div>
      )}
    </>
  )
}

/** Where the title came from, and the way back to the name given in Claude Code. */
export function TitleSourceLine({
  session,
  shortcutHint,
  onUseClaudeName = () => void applyClaudeNames([session.key])
}: {
  session: SessionSummary
  /** Mention F2 (desktop). */
  shortcutHint?: boolean
  onUseClaudeName?: () => void
}) {
  const useClaude = canUseClaudeName(session)
  // My dashboard name is still saved, but a newer rename in Claude Code wins.
  const renamedLater = session.titleSource === 'claude-name' && !!session.meta.name
  return (
    <div
      data-testid="title-source"
      className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-2xs text-subtle-foreground"
    >
      <span>{titleSourceLabel(session.titleSource)}</span>
      {renamedLater && (
        <span title={`Your dashboard name was “${session.meta.name}”`}>
          · renamed in Claude Code after your dashboard name
        </span>
      )}
      {useClaude && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onUseClaudeName}
            title={`Claude Code calls it “${session.claudeName}”`}
            className="font-medium text-primary hover:underline"
          >
            Use name from Claude Code
          </button>
        </>
      )}
      {shortcutHint && <span>· press F2 to rename</span>}
    </div>
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
  const d = useDraft(session.meta.description ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focusNonce) ref.current?.focus()
  }, [focusNonce])
  useAutoGrow(ref, d.value, 220)
  return (
    <textarea
      ref={ref}
      value={d.value}
      rows={1}
      onFocus={d.begin}
      onChange={(e) => d.change(e.target.value)}
      onBlur={() => {
        const text = d.end((t) => t.trimEnd())
        if (text !== undefined) onSave(text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          d.cancel()
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
