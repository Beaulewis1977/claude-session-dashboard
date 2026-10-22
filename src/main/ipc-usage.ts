// IPC for the Usage view (Phase 5).

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { now } from '@shared/clock'
import { dayKey, localTimeZone } from '@shared/usage/time'
import { totalTokens } from '@shared/usage/parse'
import type { CcusageComparison, Dimension, Period, UsageQuery } from '@shared/usage/types'
import { assertUserWrite } from './core/safe-paths'
import type { Platform } from './platform'
import type { UsageService } from './services/usage'

const PERIODS: Period[] = ['day', 'week', 'month']
const DIMENSIONS: Dimension[] = ['model', 'session', 'project', 'env', 'version', 'billing']

export function cleanQuery(v: unknown): UsageQuery {
  const o = (v ?? {}) as Record<string, unknown>
  const t = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) ? x : undefined
  return {
    period: PERIODS.includes(o.period as Period) ? (o.period as Period) : 'day',
    from: t(o.from),
    to: t(o.to),
    models: Array.isArray(o.models)
      ? o.models.filter((m): m is string => typeof m === 'string').slice(0, 50)
      : undefined,
    groupBy: DIMENSIONS.includes(o.groupBy as Dimension) ? (o.groupBy as Dimension) : undefined,
    sessionKey: typeof o.sessionKey === 'string' ? o.sessionKey : undefined
  }
}

export interface UsageIpcDeps {
  usage: UsageService
  platform: Platform
  billingOf?: (key: string) => string
}

/** Parse `ccusage daily --json` output into per-day totals. */
export function parseCcusageDaily(text: string): Map<string, number> {
  const out = new Map<string, number>()
  const json = JSON.parse(text) as Record<string, unknown>
  const days = Array.isArray(json.daily) ? json.daily : Array.isArray(json) ? json : []
  for (const d of days as Record<string, unknown>[]) {
    const date = typeof d.date === 'string' ? d.date.slice(0, 10) : undefined
    if (!date) continue
    const total =
      typeof d.totalTokens === 'number'
        ? d.totalTokens
        : ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']
            .map((k) => (typeof d[k] === 'number' ? (d[k] as number) : 0))
            .reduce((a, b) => a + b, 0)
    out.set(date, (out.get(date) ?? 0) + total)
  }
  return out
}

export function registerUsageIpc(deps: UsageIpcDeps): void {
  const { usage } = deps
  const win = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0]

  usage.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('usage:changed')
  })

  ipcMain.handle('usage:report', (_e, q) => usage.report(cleanQuery(q), deps.billingOf))
  ipcMain.handle('usage:session', (_e, key) => usage.sessionUsage(String(key)))
  ipcMain.handle('usage:status', () => usage.status())
  ipcMain.handle('usage:recalculate', async () => {
    await usage.recalculate()
    return usage.status()
  })
  ipcMain.handle('usage:exportCsv', async (_e, q, perRecord) => {
    const w = win()
    const opts: Electron.SaveDialogOptions = {
      title: 'Export usage to CSV',
      defaultPath: `claude-usage-${dayKey(now(), localTimeZone())}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { saved: false }
    try {
      assertUserWrite(res.filePath)
      await writeFile(res.filePath, usage.csv(cleanQuery(q), perRecord === true), 'utf8')
      return { saved: true, path: res.filePath }
    } catch (err) {
      return { saved: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('usage:verifyCcusage', async (): Promise<CcusageComparison> => {
    const out = await deps.platform.runCcusage()
    if (out === undefined) {
      return {
        available: false,
        error: "ccusage isn't installed. Install it with `npm install -g ccusage` to compare.",
        rows: []
      }
    }
    let theirs: Map<string, number>
    try {
      theirs = parseCcusageDaily(out)
    } catch {
      return { available: true, error: "Couldn't read ccusage's output.", rows: [] }
    }
    // ccusage reads the Windows profile only, so compare against Windows sessions.
    const tz = localTimeZone()
    const ours = new Map<string, number>()
    for (const r of usage.allRecords()) {
      if (r.env !== 'windows') continue
      const d = dayKey(r.ts, tz)
      ours.set(d, (ours.get(d) ?? 0) + totalTokens(r))
    }
    const dates = [...new Set([...ours.keys(), ...theirs.keys()])].sort().reverse()
    return {
      available: true,
      rows: dates.map((date) => {
        const a = ours.get(date) ?? 0
        const b = theirs.get(date) ?? 0
        return { date, ours: a, theirs: b, diff: a - b }
      })
    }
  })
}
