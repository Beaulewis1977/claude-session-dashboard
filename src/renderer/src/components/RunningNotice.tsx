// "Already running on this PC" in the launch dialog: the session (or a fork /
// continuation of it) is open already. Switching to it comes first; another
// copy only after a confirm (two copies of one session write into one file).

import { useState } from 'react'
import { AppWindow, Copy, MonitorUp, Smartphone } from 'lucide-react'
import { runningAdvice, type RunningAction, type RunningCopy } from '@shared/running'
import { ACTION_LABEL, runRunningAction } from '@/lib/running-actions'
import { Button } from './ui/button'

export function RunningNotice({
  running,
  onDone,
  onAnother
}: {
  running: RunningCopy
  /** A switch action worked (the dialog closes). */
  onDone: () => void
  /** "Start another copy" was confirmed. */
  onAnother: () => void
}) {
  const advice = runningAdvice(running, 'pc')
  const [confirming, setConfirming] = useState(false)
  const icon = (a: RunningAction) =>
    a === 'focus' ? (
      <MonitorUp />
    ) : a === 'open-remote' ? (
      <Smartphone />
    ) : a === 'open-codex-app' ? (
      <AppWindow />
    ) : (
      <Copy />
    )
  return (
    <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-xs">
      <div className="font-medium text-foreground">{advice.title}</div>
      <div className="leading-relaxed text-muted-foreground">
        {running.title && running.relation !== 'self' && (
          <span className="font-medium text-foreground">“{running.title}”. </span>
        )}
        {advice.body}
      </div>
      {!confirming ? (
        <div className="flex flex-wrap gap-2">
          {advice.actions.map((a) =>
            a === 'another' ? (
              <Button key={a} variant="ghost" size="xs" onClick={() => setConfirming(true)}>
                {icon(a)} {ACTION_LABEL[a]}
              </Button>
            ) : (
              <Button
                key={a}
                variant="outline"
                size="xs"
                onClick={() => void runRunningAction(running, a).then((ok) => ok && onDone())}
              >
                {icon(a)} {ACTION_LABEL[a]}
              </Button>
            )
          )}
        </div>
      ) : (
        <div className="space-y-2 border-t border-warning/30 pt-2">
          <div className="text-foreground">
            Start a second copy anyway? Both write into the same session file and can get out of
            step.
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="xs" onClick={onAnother}>
              <Copy /> Start another copy
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
