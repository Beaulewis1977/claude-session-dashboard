// IPC for "Ask Claude" (usage questions through `claude -p`).

import { now } from '@shared/clock'
import { buildAskData, type AskCodexInput } from '@shared/ask'
import type { ModelPrice } from '@shared/usage/pricing'
import type { CodexLimitsService } from './services/codex-limits'
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
  /** Codex's numbers too (when Codex is on). */
  codex?: { limits: Pick<CodexLimitsService, 'state'>; prices: () => ModelPrice[] }
  settings: JsonStore<SettingsFile>
  runner?: PrintRunner
  simulate: boolean
}): Promise<{ flush: () => Promise<void> }> {
  // Codex's numbers, when Codex is on (none of its text).
  const codexAsk = async (): Promise<{ codex?: AskCodexInput }> => {
    const c = deps.codex
    if (!c) return {}
    const st = c.limits.state()
    if (!st.hasData && !deps.usage.codexRecords().length) return {}
    const windows = [st.fiveHour, st.sevenDay, ...st.otherWindows.map((w) => w.gauge)]
      .filter((g): g is NonNullable<typeof g> => !!g && !g.expired)
      .map((g) => ({
        minutes:
          g.windowStart && g.resetsAt ? Math.round((g.resetsAt - g.windowStart) / 60_000) : 0,
        pct: g.pct,
        resetsAt: g.resetsAt
      }))
    return {
      codex: {
        plan: st.plan.label,
        multiplier: st.plan.mult,
        health5h: st.health5h,
        health7d: st.health7d,
        pace5h: st.pace5h,
        pace7d: st.pace7d,
        records: deps.usage.codexRecords(),
        prices: c.prices(),
        windows
      }
    }
  }
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
        elsewhere: s.elsewhere,
        ...(await codexAsk())
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
