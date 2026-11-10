// A citation from Ask opens the viewer at its message (or the Changes tab at
// its commit): once that part of the session is on screen, scroll to it and
// flash it. Desktop viewer and phone session screen alike.

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useApp } from './store'

/** How long to wait for the transcript or the git links to show it (frames, ~5 s). */
const MAX_FRAMES = 300

function target(ids: string[], sha?: string): Element | null {
  if (sha) return document.querySelector(`[data-sha="${CSS.escape(sha)}"]`)
  for (const id of ids) {
    const el = document.querySelector(`[data-msg-ids~="${CSS.escape(id)}"]`)
    if (el) return el
  }
  return null
}

export function useFocusMessage(key: string, ready: boolean, tab: 'conversation' | 'changes'): void {
  const focus = useApp((s) => s.focusMessage)
  useEffect(() => {
    if (!focus || focus.key !== key || !ready) return
    if ((focus.sha ? 'changes' : 'conversation') !== tab) return
    if (!focus.sha && !focus.ids.length) {
      useApp.getState().set({ focusMessage: null })
      return
    }
    let frames = 0
    let raf = 0
    const find = (): void => {
      const el = target(focus.ids, focus.sha)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        // Turns above it take their real height once near the screen: aim again.
        requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'center' })))
        window.setTimeout(() => el.scrollIntoView({ block: 'center' }), 200)
        el.classList.add('cite-flash')
        window.setTimeout(() => el.classList.remove('cite-flash'), 2400)
        useApp.getState().set({ focusMessage: null })
        return
      }
      if (++frames < MAX_FRAMES) raf = requestAnimationFrame(find)
      else {
        useApp.getState().set({ focusMessage: null })
        toast.message(
          focus.sha
            ? "That commit isn't in this session's Changes now."
            : "That message isn't in this session now (it may have been compacted or changed)."
        )
      }
    }
    raf = requestAnimationFrame(find)
    return () => cancelAnimationFrame(raf)
  }, [focus, key, ready, tab])
}
