// While a search is on: some very long sessions are searched only by their
// first part (see CODEX_SEARCH_LIMIT), so a word further on finds nothing. The
// session's own viewer says so too, but a session that doesn't match never
// shows up to say it: this note is in the search results.

import { Info } from 'lucide-react'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'

function usePartialSearchCount(): number {
  return useApp((s) => s.sessions.reduce((n, x) => n + (x.searchPartial ? 1 : 0), 0))
}

export function PartialSearchNote({ className }: { className?: string }) {
  const query = useApp((s) => s.query)
  const partial = usePartialSearchCount()
  if (!query.trim() || !partial) return null
  return (
    <div
      className={cn('flex items-start gap-1.5 text-2xs text-muted-foreground', className)}
      title="Very long sessions are indexed up to their first 1,000,000 characters (prompts and answers first). Open one and use Find in session to search all of it."
    >
      <Info className="mt-px size-3 shrink-0" />
      <span>
        {partial.toLocaleString()} very long session{partial === 1 ? ' is' : 's are'} searched only
        by {partial === 1 ? 'its' : 'their'} first part; Find in session searches all of it.
      </span>
    </div>
  )
}
