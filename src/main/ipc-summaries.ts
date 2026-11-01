// IPC for session summaries (claude -p on the subscription) and their queue.

import { BrowserWindow } from 'electron'
import { now } from '@shared/clock'
import { sanitizeSummarySettings } from '@shared/summary'
import { planAt } from '@shared/usage/health'
import type { JsonStore } from './core/json-store'
import { handle } from './ipc-guard'
import type { LimitsService } from './services/limits'
import type { PrintRunner } from './services/print-runner'
import type { SessionService } from './services/sessions'
import type { SettingsFile } from './services/store'
import { SummaryService } from './services/summaries'
import type { UsageService } from './services/usage'

export function registerSummaryIpc(deps: {
  dataDir: string
  sessions: SessionService
  usage: UsageService
  limits: LimitsService
  settings: JsonStore<SettingsFile>
  runner: PrintRunner
  simulate: boolean
}): SummaryService {
  const { settings, limits } = deps
  const summaries = new SummaryService({
    sessions: deps.sessions,
    dataDir: deps.dataDir,
    runner: deps.runner,
    simulate: deps.simulate,
    settings: () => sanitizeSummarySettings(settings.value.summaries),
    // A long session takes longer than a usage question.
    timeoutSec: () => Math.max(300, settings.value.askTimeoutSec),
    prices: () => settings.value.prices,
    fiveHourPct: async () => {
      const g = (await limits.state()).fiveHour
      return g && !g.expired ? g.pct : undefined
    },
    dollarsPerPct: () => {
      const h = limits.health('five_hour')
      if (!h.baseline) return undefined
      return h.baseline.value * planAt(h.plans, now()).mult
    },
    recordUsage: (recs) => deps.usage.addDashboardRecords(recs)
  })
  summaries.on('changed', () => {
    const st = summaries.state()
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('summaries:changed', st)
  })

  const key = (v: unknown): string => {
    if (typeof v !== 'string' || !v || v.length > 300) throw new Error('Bad session')
    return v
  }
  const keys = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).slice(0, 500).map((k) => key(k))

  handle('summaries:state', () => summaries.state())
  handle('summaries:preview', (_e, k) => summaries.preview(key(k)))
  handle('summaries:estimate', (_e, ks) => summaries.estimate(keys(ks)))
  handle('summaries:enqueue', (_e, ks, origin) =>
    summaries.enqueue(keys(ks), origin === 'bulk' ? 'bulk' : 'manual')
  )
  handle('summaries:cancel', (_e, k) => summaries.cancel(k === undefined ? undefined : key(k)))
  handle('summaries:resume', () => summaries.resume())
  handle('summaries:clear', () => summaries.clearFinished())
  handle('summaries:save', (_e, k, patch) => summaries.save(key(k), patch))
  handle('summaries:remove', (_e, k) => summaries.remove(key(k)))
  handle('summaries:autoPreview', () => summaries.autoPreview())

  // Auto-summarize: opt-in; checks every 10 minutes and soon after a session changes.
  let soon: NodeJS.Timeout | undefined
  deps.sessions.on('changed', () => {
    if (soon || !sanitizeSummarySettings(settings.value.summaries).autoEnabled) return
    soon = setTimeout(() => {
      soon = undefined
      void summaries.autoTick()
    }, 60_000)
    soon.unref?.()
  })
  summaries.startAuto()
  return summaries
}
