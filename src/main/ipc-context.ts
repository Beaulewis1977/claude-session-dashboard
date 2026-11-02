// IPC for context size estimates (the session stats on the desktop and the phone).

import { handle } from './ipc-guard'
import type { ContextCost } from './services/context-cost'
import type { Launcher } from './services/launcher'
import type { SessionService } from './services/sessions'

export function registerContextIpc(deps: {
  sessions: SessionService
  launcher: Launcher
  cost: ContextCost
}): void {
  handle('context:estimate', async (_e, key: unknown) => {
    if (typeof key !== 'string' || !key || key.length > 300) throw new Error('Bad session')
    const s = deps.sessions.get(key)
    if (!s) return null
    // As Resume would launch it now: the session's model choice and default billing.
    return (
      (await deps.cost.estimate(s, {
        billingAccountId: deps.cost.defaultBilling(s),
        modelChoice: deps.launcher.modelChoice(s).model
      })) ?? null
    )
  })
}
