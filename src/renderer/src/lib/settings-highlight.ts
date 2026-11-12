// Settings search: marks where the search's words start a word in the visible
// settings, with the CSS Custom Highlight API (the page's DOM isn't changed).
// Used by the desktop Settings page and the phone's Settings tab.

import { useEffect, type RefObject } from 'react'
import { highlightWords } from '@shared/settings-registry'

const HIGHLIGHT = 'settings-search'

/** Text as matched: lower case, curly quotes straight (same length as the original). */
function foldText(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

/**
 * Marks where the search's words start a word in the visible settings, with
 * the CSS Custom Highlight API (no change to the page's DOM). Kept up to date
 * as settings load or change while a search is on.
 */
export function useSearchHighlight(root: RefObject<HTMLElement | null>, query: string): void {
  useEffect(() => {
    const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)
      ?.highlights
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    const el = root.current
    if (!registry || !HighlightCtor || !el) return
    const words = highlightWords(query)
    if (!words.length) {
      registry.delete(HIGHLIGHT)
      return
    }
    let frame = 0
    const paint = (): void => {
      frame = 0
      const ranges: Range[] = []
      for (const item of el.querySelectorAll<HTMLElement>('[data-setting-id]')) {
        if (item.closest('[hidden]')) continue
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = foldText(n.nodeValue ?? '')
          if (!text.trim()) continue
          for (const w of words) {
            let i = text.indexOf(w)
            while (i >= 0) {
              if (i === 0 || /[^a-z0-9]/.test(text[i - 1])) {
                const r = document.createRange()
                r.setStart(n, i)
                r.setEnd(n, i + w.length)
                ranges.push(r)
              }
              i = text.indexOf(w, i + w.length)
            }
          }
        }
      }
      registry.set(HIGHLIGHT, new HighlightCtor(...ranges))
    }
    paint()
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(paint)
    })
    mo.observe(el, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden']
    })
    return () => {
      mo.disconnect()
      if (frame) cancelAnimationFrame(frame)
      registry.delete(HIGHLIGHT)
    }
  }, [root, query])
}
