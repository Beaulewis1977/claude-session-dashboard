import { useCallback, useEffect, useState, type RefObject } from 'react'

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS

// Injected at runtime: the CSS minifier doesn't understand ::highlight() and drops it.
if (supported && !document.getElementById('find-highlight-style')) {
  const style = document.createElement('style')
  style.id = 'find-highlight-style'
  style.textContent = `
    ::highlight(find) { background-color: var(--find); color: inherit; }
    ::highlight(find-current) { background-color: var(--find-current); color: inherit; }
  `
  document.head.appendChild(style)
}

function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.toLowerCase()
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('[data-find-skip]')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? ''
    let i = text.indexOf(q)
    while (i !== -1) {
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + q.length)
      ranges.push(r)
      if (ranges.length >= 5000) return ranges
      i = text.indexOf(q, i + q.length)
    }
  }
  return ranges
}

/**
 * Find-in-session using the CSS Custom Highlight API: no DOM mutation, so it
 * works on top of rendered markdown and highlighted code.
 */
export function useFind(
  rootRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  query: string,
  version: unknown
) {
  const [ranges, setRanges] = useState<Range[]>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!supported) return
    const q = query.trim()
    const root = rootRef.current
    if (!q || q.length < 1 || !root) {
      CSS.highlights.delete('find')
      CSS.highlights.delete('find-current')
      setRanges([])
      return
    }
    // Wait a frame so force-expanded blocks are rendered.
    const raf = requestAnimationFrame(() => {
      const r = collectRanges(root, q)
      setRanges(r)
      setIndex(0)
      CSS.highlights.set('find', new Highlight(...r))
    })
    return () => cancelAnimationFrame(raf)
  }, [query, rootRef, version])

  useEffect(() => {
    if (!supported) return
    const r = ranges[index]
    if (!r) {
      CSS.highlights.delete('find-current')
      return
    }
    CSS.highlights.set('find-current', new Highlight(r))
    const scroller = scrollRef.current
    const el = r.startContainer.parentElement
    if (scroller && el) {
      el.scrollIntoView({ block: 'center' })
      // Fine-tune using the range itself (the element may be large).
      const rect = r.getBoundingClientRect()
      const box = scroller.getBoundingClientRect()
      if (rect.top < box.top + 40 || rect.bottom > box.bottom - 40) {
        scroller.scrollTop += rect.top - box.top - box.height / 2
      }
    }
  }, [ranges, index, scrollRef])

  useEffect(
    () => () => {
      if (!supported) return
      CSS.highlights.delete('find')
      CSS.highlights.delete('find-current')
    },
    []
  )

  const next = useCallback(
    () => setIndex((i) => (ranges.length ? (i + 1) % ranges.length : 0)),
    [ranges.length]
  )
  const prev = useCallback(
    () => setIndex((i) => (ranges.length ? (i - 1 + ranges.length) % ranges.length : 0)),
    [ranges.length]
  )
  return { count: ranges.length, index, next, prev, supported }
}
