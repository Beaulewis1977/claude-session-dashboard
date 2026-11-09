// The phone's session search: asked on the PC, and kept up to date with it.

import { useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'

/** How often a search is asked again at most while the PC's sessions keep changing. */
export const SEARCH_AGAIN_MS = 500

/**
 * Debounced full-text search on the PC (the same index as the desktop). The
 * results follow the PC's data too: a search is asked again when its sessions
 * change (one made while the PC was still reading them, or before their git
 * links were worked out, would otherwise stay as it was). Only the newest
 * answer counts.
 */
export function useSearch(): [string, (q: string) => void] {
  const query = useApp((s) => s.query)
  const sessions = useApp((s) => s.sessions)
  const set = useApp((s) => s.set)
  const asked = useRef(0)
  const again = useRef<number | undefined>(undefined)
  const setQuery = (q: string): void => {
    const st = useApp.getState()
    if (q.trim() && !st.query.trim())
      set({ query: q, sortBeforeSearch: st.sort, sort: 'relevance' })
    else if (!q.trim())
      set({ query: q, hits: null, sort: st.sort === 'relevance' ? st.sortBeforeSearch : st.sort })
    else set({ query: q })
  }
  const run = useCallback(
    (q: string): void => {
      const n = ++asked.current
      void api
        .search(q)
        .then((hits) => {
          if (n === asked.current && useApp.getState().query.trim() === q)
            set({ hits: new Map(hits.map((h) => [h.key, h])) })
        })
        .catch(() => undefined)
    },
    [set]
  )
  // Whenever the query changes, however it was set (typed, or "Sessions that
  // touched this file" in a session's Changes).
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const t = window.setTimeout(() => run(q), 220)
    return () => window.clearTimeout(t)
  }, [query, run])
  // And when the sessions change (not postponed by changes that keep coming).
  useEffect(() => {
    if (again.current !== undefined || !useApp.getState().query.trim()) return
    again.current = window.setTimeout(() => {
      again.current = undefined
      const q = useApp.getState().query.trim()
      if (q) run(q)
    }, SEARCH_AGAIN_MS)
  }, [sessions, run])
  useEffect(
    () => () => {
      window.clearTimeout(again.current)
      again.current = undefined
    },
    []
  )
  return [query, setQuery]
}
