// A file's diff in the Changes tab: line numbers, added/removed colours,
// syntax highlighting (highlight.js grammars through lowlight, line by line),
// collapsible hunks, and a cut at DIFF_SHOWN lines with "Show all".

import { memo, useMemo, useState, type ReactNode } from 'react'
import { common, createLowlight } from 'lowlight'
import type { Element, ElementContent, Root } from 'hast'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DiffFile, DiffLine } from '@shared/git/types'
import { langFor } from '@/lib/git'
import { cn } from '@/lib/utils'

const lowlight = createLowlight(common)

/** Lines shown per file before "Show all". */
export const DIFF_SHOWN = 400
/** Lines longer than this aren't highlighted (minified files). */
const HIGHLIGHT_MAX = 1000

function render(nodes: ElementContent[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'text') return n.value
    if (n.type !== 'element') return null
    const el = n as Element
    const cls = el.properties?.className
    return (
      <span key={`${key}${i}`} className={Array.isArray(cls) ? cls.join(' ') : undefined}>
        {render(el.children, `${key}${i}.`)}
      </span>
    )
  })
}

function highlight(text: string, lang: string | undefined): ReactNode {
  if (!lang || !text || text.length > HIGHLIGHT_MAX || !lowlight.registered(lang)) return text
  try {
    const tree: Root = lowlight.highlight(lang, text)
    return render(tree.children as ElementContent[])
  } catch {
    return text
  }
}

const Line = memo(function Line({ line, lang }: { line: DiffLine; lang?: string }) {
  if (line.t === '\\')
    return (
      <div className="flex px-2 text-subtle-foreground italic">
        <span className="w-[5.5rem] shrink-0" />
        {line.text}
      </div>
    )
  return (
    <div
      className={cn(
        'flex',
        line.t === '+' && 'bg-[var(--hl-addition-bg)]',
        line.t === '-' && 'bg-[var(--hl-deletion-bg)]'
      )}
    >
      <span className="w-11 shrink-0 pr-2 text-right text-subtle-foreground/70 select-none">
        {line.oldNo ?? ''}
      </span>
      <span className="w-11 shrink-0 pr-2 text-right text-subtle-foreground/70 select-none">
        {line.newNo ?? ''}
      </span>
      <span
        className={cn(
          'w-4 shrink-0 select-none',
          line.t === '+' && 'text-[var(--hl-addition)]',
          line.t === '-' && 'text-[var(--hl-deletion)]'
        )}
      >
        {line.t === ' ' ? '' : line.t}
      </span>
      <span className="pr-3 whitespace-pre">{highlight(line.text, lang) || ' '}</span>
    </div>
  )
})

export function DiffView({ file }: { file: DiffFile }) {
  const lang = langFor(file.path)
  const [showAll, setShowAll] = useState(false)
  const [closed, setClosed] = useState<Set<number>>(() => new Set())
  const total = useMemo(() => file.hunks.reduce((n, h) => n + h.lines.length, 0), [file])
  if (file.status === 'binary')
    return <div className="px-3 py-2 text-xs text-muted-foreground">Binary file, not shown.</div>
  if (!file.hunks.length)
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {file.status === 'renamed' ? 'Renamed, no content changes.' : 'No line changes.'}
      </div>
    )
  // Each hunk's lines that fit in what's shown (open hunks only), in order.
  const shown: { i: number; open: boolean; lines: DiffLine[] }[] = []
  let left = showAll ? Infinity : DIFF_SHOWN
  file.hunks.forEach((h, i) => {
    if (left <= 0) return
    const open = !closed.has(i)
    const lines = open ? h.lines.slice(0, left) : []
    left -= lines.length
    shown.push({ i, open, lines })
  })
  return (
    <div className="selectable overflow-x-auto font-mono text-[12px] leading-[1.6]">
      {shown.map(({ i, open, lines }) => {
        const h = file.hunks[i]
        return (
          <div key={i}>
            <button
              type="button"
              className="flex w-full items-center gap-1 bg-secondary/70 px-2 py-0.5 text-left text-2xs text-subtle-foreground hover:bg-hover"
              onClick={() =>
                setClosed((s) => {
                  const n = new Set(s)
                  if (n.has(i)) n.delete(i)
                  else n.add(i)
                  return n
                })
              }
              aria-expanded={open}
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              <span className="truncate">{h.header}</span>
            </button>
            {lines.map((l, j) => (
              <Line key={j} line={l} lang={lang} />
            ))}
          </div>
        )
      })}
      {!showAll && total > DIFF_SHOWN && (
        <button
          type="button"
          className="w-full border-t border-code-border/70 py-1.5 text-center text-xs font-medium text-primary hover:bg-hover"
          onClick={() => setShowAll(true)}
        >
          Show all {total.toLocaleString()} lines
        </button>
      )}
    </div>
  )
}
