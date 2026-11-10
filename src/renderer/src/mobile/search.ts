// The phone's session search: asked on the PC, and kept up to date with it.

import { useEffect, useMemo, useRef } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'

/** How soon a search is asked again after the PC's sessions change (and none is out). */
export const SEARCH_AGAIN_MS = 500

interface SearchState {
  /** This mount is shown: answers that come after it's gone are dropped. */
  alive: boolean
  /** Requests are numbered in order; an answer shows if it's newer than the one shown. */
  asked: number
  shown: number
  /** Requests not answered yet. */
  out: number
  /** The sessions changed while a request was out: asked once more after it. */
  stale: boolean
  timer?: number
}

/**
 * Debounced full-text search on the PC (the same index as the desktop). The
 * results follow the PC's data too: a search is asked again when its sessions
 * change (one made while the PC was still reading them, or before their git
 * links were worked out, would otherwise stay as it was). One such refresh at
 * a time: changes while it's out ask once more after it, so a steady stream of
 * changes still shows every answer. An answer older than the one shown, or one
 * that comes after this mount is gone, is dropped.
 */
export function useSearch(): [string, (q: string) => void] {
  const query = useApp((s) => s.query)
  const sessions = useApp((s) => s.sessions)
  const set = useApp((s) => s.set)
  const st = useRef<SearchState>({ alive: false, asked: 0, shown: 0, out: 0, stale: false })
  const seenSessions = useRef(sessions)
  const setQuery = (q: string): void => {
    const s = useApp.getState()
    if (q.trim() && !s.query.trim())
      set({ query: q, sortBeforeSearch: s.sort, sort: 'relevance' })
    else if (!q.trim())
      set({ query: q, hits: null, sort: s.sort === 'relevance' ? s.sortBeforeSearch : s.sort })
    else set({ query: q })
  }
  const ask = useMemo(() => {
    function run(q: string): void {
      const s = st.current
      const n = ++s.asked
      s.out++
      void api
        .search(q)
        .then((hits) => {
          if (!s.alive || n <= s.shown || useApp.getState().query.trim() !== q) return
          s.shown = n
          set({ hits: new Map(hits.map((h) => [h.key, h])) })
        })
        .catch(() => undefined)
        .finally(() => {
          s.out--
          if (s.alive && s.stale && s.out === 0) {
            s.stale = false
            again()
          }
        })
    }
    function again(): void {
      const s = st.current
      if (!s.alive || !useApp.getState().query.trim()) return
      if (s.out > 0) {
        s.stale = true
        return
      }
      if (s.timer !== undefined) return
      s.timer = window.setTimeout(() => {
        s.timer = undefined
        const q = useApp.getState().query.trim()
        if (s.alive && q) run(q)
      }, SEARCH_AGAIN_MS)
    }
    return { run, again }
  }, [set])
  // First, so the effects below see this mount as live.
  useEffect(() => {
    const s = st.current
    s.alive = true
    return () => {
      s.alive = false
      s.stale = false
      window.clearTimeout(s.timer)
      s.timer = undefined
    }
  }, [])
  // Whenever the query changes, however it was set (typed, or "Sessions that
  // touched this file" in a session's Changes).
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const t = window.setTimeout(() => ask.run(q), 220)
    return () => window.clearTimeout(t)
  }, [query, ask])
  // And when the sessions change (the query's own search covers the first ones).
  useEffect(() => {
    if (seenSessions.current === sessions) return
    seenSessions.current = sessions
    ask.again()
  }, [sessions, ask])
  return [query, setQuery]
}
