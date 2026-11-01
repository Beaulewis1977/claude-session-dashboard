// IPC for "Ask Claude" (usage questions through `claude -p`).

import { now } from '@shared/clock'
import { buildAskData } from '@shared/ask'
import { localTimeZone } from '@shared/usage/time'
import type { JsonStore } from './core/json-store'
import { handle } from './ipc-guard'
import { AskService, createAskStore } from './services/ask'
import type { PrintRunner } from './services/print-runner'
import type { LimitsService } from './services/limits'
import type { SettingsFile } from './services/store'
import type { UsageService } from './services/usage'

export async function registerAskIpc(deps: {
  dataDir: string
  usage: UsageService
  limits: LimitsService
  settings: JsonStore<SettingsFile>
  runner?: PrintRunner
  simulate: boolean
}): Promise<{ flush: () => Promise<void> }> {
  const store = createAskStore(deps.dataDir)
  await store.load()
  const ask = new AskService({
    store,
    dataDir: deps.dataDir,
    printRunner: deps.runner,
    simulate: deps.simulate,
    timeoutSec: () => deps.settings.value.askTimeoutSec,
    data: async () => {
      const s = deps.settings.value
      const state = await deps.limits.state()
      return buildAskData({
        now: now(),
        timeZone: localTimeZone(),
        plan: s.plan,
        planHistory: s.planHistory,
        health5h: state.health5h,
        health7d: state.health7d,
        pace5h: state.pace5h,
        pace7d: state.pace7d,
        records: deps.usage.allRecords(),
        limitHits: deps.usage.limitHits(),
        prices: s.prices,
        elsewhere: s.elsewhere
      })
    }
  })
  const text = (v: unknown, max: number): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error('Type a question first.')
    return v.trim().slice(0, max)
  }
  handle('ask:status', () => ask.status())
  handle('ask:preview', (_e, q) => ask.preview(text(q, 1000)))
  handle('ask:run', (_e, id) => ask.run(text(id, 64)))
  handle('ask:cancel', (_e, id) => ask.cancel(text(id, 64)))
  handle('ask:history', () => ask.history())
  return { flush: () => store.flush() }
}
