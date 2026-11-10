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

/**
 * Opening a thread in the Codex app while a terminal still runs it is a second
 * copy: it needs the same confirm as "Start another copy" (the phone asks too).
 */
export function needsConfirm(r: RunningCopy, a: RunningAction): boolean {
  return a === 'open-codex-app' && r.where !== 'codex-app'
}

/**
 * Run one of the "switch to it" actions (not 'another'). Resolves true if it
 * worked. Open in Codex app goes through the launcher (its duplicate check),
 * and only with `confirmed` where it would be a second copy.
 */
export async function runRunningAction(
  r: RunningCopy,
  a: RunningAction,
  confirmed = false
): Promise<boolean> {
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
      if (needsConfirm(r, a) && !confirmed) return false
      const res = await api.launch({
        key: r.key,
        fork: false,
        skipPermissions: false,
        openIn: 'codex-app',
        ...(confirmed ? { allowDuplicate: true } : {})
      })
      if (!res.ok) {
        toast.error("Couldn't open the Codex app", { description: res.error })
        return false
      }
      return true
    }
  } catch (err) {
    toast.error("Couldn't switch to it", { description: (err as Error).message })
  }
  return false
}

/** The first "switch to it" action that needs no confirm (the dialog's main button while it runs). */
export function primaryAction(r: RunningCopy): RunningAction | undefined {
  return runningAdvice(r, 'pc').actions.find((a) => a !== 'another' && !needsConfirm(r, a))
}
