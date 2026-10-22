import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'

export function FindBar({
  query,
  onQuery,
  count,
  index,
  onNext,
  onPrev,
  onClose,
  focusNonce
}: {
  query: string
  onQuery: (q: string) => void
  count: number
  index: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
  focusNonce: number
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [focusNonce])
  return (
    <div
      data-find-skip
      className="absolute top-3 right-5 z-20 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg animate-in fade-in-0 slide-in-from-top-1 duration-150"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <input
          ref={ref}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (e.shiftKey) onPrev()
              else onNext()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
          placeholder="Find in session"
          aria-label="Find in session"
          spellCheck={false}
          className="h-7 w-56 rounded-md bg-transparent pr-2 pl-7 text-[13px] outline-none placeholder:text-subtle-foreground"
        />
      </div>
      <span className="min-w-[64px] px-1 text-center text-2xs text-muted-foreground tabular-nums">
        {query.trim() ? (count ? `${index + 1} of ${count}` : 'No results') : ''}
      </span>
      <Tooltip content="Previous match" shortcut="Shift+Enter">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onPrev}
          disabled={!count}
          aria-label="Previous match"
        >
          <ArrowUp />
        </Button>
      </Tooltip>
      <Tooltip content="Next match" shortcut="Enter">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onNext}
          disabled={!count}
          aria-label="Next match"
        >
          <ArrowDown />
        </Button>
      </Tooltip>
      <Tooltip content="Close" shortcut="Esc">
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close find">
          <X />
        </Button>
      </Tooltip>
    </div>
  )
}
