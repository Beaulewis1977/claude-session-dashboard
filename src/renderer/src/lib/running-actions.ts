// The desktop's "Already running" actions: Focus terminal, Open in Claude app
// (its Remote Control link), Open in Codex app.

import { toast } from 'sonner'
import { runningAdvice, type RunningAction, type RunningCopy } from '@shared/running'
import { api } from './api'

export const ACTION_LABEL: Record<RunningAction, string> = {
  focus: 'Focus terminal',
  'open-remote': 'Open in Claude app',
  'open-codex-app': 'Open in Codex app',
  another: 'Start another copy…'
}

/** Run one of the "switch to it" actions (not 'another'). Resolves true if it worked. */
export async function runRunningAction(r: RunningCopy, a: RunningAction): Promise<boolean> {
  try {
    if (a === 'focus') {
      const res = await api.focusTerminal(r.key)
      if (!res.ok) {
        toast.error("Couldn't bring its terminal forward", { description: res.error })
        return false
      }
      return true
    }
    if (a === 'open-remote' && r.remoteUrl) {
      await api.openExternal(r.remoteUrl)
      return true
    }
    if (a === 'open-codex-app') {
      await api.openInAgentApp(r.key)
      return true
    }
  } catch (err) {
    toast.error("Couldn't switch to it", { description: (err as Error).message })
  }
  return false
}

/** The first "switch to it" action (the dialog's main button while it runs). */
export function primaryAction(r: RunningCopy): RunningAction | undefined {
  return runningAdvice(r, 'pc').actions.find((a) => a !== 'another')
}
