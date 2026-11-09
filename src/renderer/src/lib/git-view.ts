// Git links in the renderer: a session's Changes data, and searches set from it.

import { useEffect, useState } from 'react'
import { touchedQuery } from '@shared/git/query'
import type { SessionGitView } from '@shared/git/types'
import { api } from './api'
import { useApp } from './store'

function setSearch(query: string): void {
  const st = useApp.getState()
  if (!st.query.trim()) st.set({ query, sortBeforeSearch: st.sort, sort: 'relevance' })
  else st.set({ query })
}

/** Show the sessions that touched a file (sets the list's search). */
export function searchTouched(path: string): void {
  setSearch(touchedQuery(path))
}

/** Show the sessions linked to a commit. */
export function searchCommit(sha: string): void {
  setSearch(`commit:${sha.slice(0, 12)}`)
}

/** A session's git view, reloaded when git links or the session change. */
export function useGitView(key: string, version: string): SessionGitView | null | undefined {
  const [view, setView] = useState<SessionGitView | null | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    void api
      .getGitView(key)
      .then((v) => !cancelled && setView(v))
      .catch(() => !cancelled && setView(null))
    return () => {
      cancelled = true
    }
  }, [key, version, nonce])
  useEffect(() => api.onGitChanged(() => setNonce((n) => n + 1)), [])
  return view
}
