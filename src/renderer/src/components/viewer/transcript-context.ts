// What a transcript's tool blocks need to know about the session they're in:
// whose transcript it is (to ask for a cut tool output in full) and which
// cut outputs hold the find query in their hidden part.

import { createContext } from 'react'

export interface TranscriptInfo {
  /** The session's key (absent: nothing was cut, nothing to ask for). */
  sessionKey?: string
  /** Blocks whose cut output holds the find query past the cut. */
  cutMatches: ReadonlySet<string>
  /** A cut output that holds a find match was loaded in full (find counts again). */
  onMatchLoaded?: () => void
}

export const TranscriptContext = createContext<TranscriptInfo>({ cutMatches: new Set() })
