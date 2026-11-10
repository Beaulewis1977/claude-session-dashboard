// The open state of a collapsible block in the transcript (tool calls, agent
// messages, results, compaction summaries).

import { useState } from 'react'

/**
 * A collapsible block's own open state: my clicks, plus "open now" each time
 * `openSignal` turns to a new non-zero value (an Ask citation pointed at it).
 * Unlike `forceOpen`, I can close it again afterwards. Adjusted during render.
 */
export function useOpenState(
  openSignal?: number
): [boolean, (update: boolean | ((v: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(0)
  if (openSignal && openSignal !== seen) {
    setSeen(openSignal)
    setOpen(true)
  }
  return [open, setOpen]
}
