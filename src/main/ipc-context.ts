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
  handle('context:estimate', async (_e, key: unknown, opts: unknown) => {
    if (typeof key !== 'string' || !key || key.length > 300) throw new Error('Bad session')
    const s = deps.sessions.get(key)
    if (!s) return null
    // A phone's launches always run on the subscription (Remote Control); the
    // desktop's follow the session's default billing.
    const phone = !!opts && typeof opts === 'object' && (opts as { phone?: unknown }).phone === true
    return (
      (await deps.cost.estimate(s, {
        billingAccountId: phone ? undefined : deps.cost.defaultBilling(s),
        modelChoice: deps.launcher.modelChoice(s).model
      })) ?? null
    )
  })
}
