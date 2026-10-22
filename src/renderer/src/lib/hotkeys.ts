import { useEffect, useRef } from 'react'
import { isMac } from './utils'

export interface Hotkey {
  /** e.g. "mod+k", "shift+?", "j", "arrowdown", "mod+shift+enter" */
  combo: string
  handler: (e: KeyboardEvent) => void
  /** Fire even when typing in an input. */
  allowInInput?: boolean
  when?: () => boolean
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}

export function matches(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const want = new Set(parts.slice(0, -1))
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (want.has('mod') !== mod) return false
  if (!isMac && want.has('mod') === false && e.ctrlKey) return false
  if (want.has('alt') !== e.altKey) return false
  const k = e.key.toLowerCase()
  // Shift is implied by characters like "?"; only check it for letters/named keys.
  if (key.length > 1 || /[a-z0-9]/.test(key)) {
    if (want.has('shift') !== e.shiftKey) return false
  }
  if (key === 'space') return k === ' '
  return k === key
}

/** Window-level keyboard shortcuts. The latest handlers are always used. */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys)
  useEffect(() => {
    ref.current = hotkeys
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      for (const h of ref.current) {
        if (!matches(e, h.combo)) continue
        if (!h.allowInInput && isTyping(e)) continue
        if (h.when && !h.when()) continue
        e.preventDefault()
        h.handler(e)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
