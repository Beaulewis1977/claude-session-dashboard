// IPC for the Usage view (Phase 5).

import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { now } from '@shared/clock'
import { dayKey, localTimeZone } from '@shared/usage/time'
import { totalTokens } from '@shared/usage/parse'
import {
  buildTrends,
  compareTrends,
  type CompareSide,
  type TrendGroupBy
} from '@shared/usage/trends'
import type { CcusageComparison, Dimension, Period, UsageQuery } from '@shared/usage/types'
import { assertUserWrite } from './core/safe-paths'
import type { Platform } from './platform'
import type { BridgeInstaller } from './services/bridge'
import type { LimitsService } from './services/limits'
import type { SessionService } from './services/sessions'
import type { UsageService } from './services/usage'

const PERIODS: Period[] = ['hour', 'day', 'week', 'month']
const DIMENSIONS: Dimension[] = [
  'model',
  'session',
  'project',
  'env',
  'version',
  'billing',
  'source'
]

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
  limits: LimitsService
  installer: BridgeInstaller
  sessions: SessionService
  platform: Platform
  billingOf?: (key: string) => string
  sourceOf?: (key: string) => string
  /** Called after the bridge was enabled or disabled. */
  onBridgeChanged?: () => void
  weekStart: () => 'monday' | 'sunday'
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
  deps.limits.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('limits:changed')
  })

  const action = (v: unknown): 'install' | 'uninstall' =>
    v === 'uninstall' ? 'uninstall' : 'install'
  const source = (id: unknown) => {
    const src = deps.sessions.source(String(id))
    if (!src) throw new Error('Unknown environment')
    return src
  }
  ipcMain.handle('limits:state', () => deps.limits.state())
  const range = (v: unknown): { from: string; to: string } => {
    const o = (v ?? {}) as Record<string, unknown>
    const ymd = (x: unknown): string =>
      typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : '1970-01-01'
    const from = ymd(o.from)
    const to = ymd(o.to ?? o.from)
    return from <= to ? { from, to } : { from: to, to: from }
  }
  ipcMain.handle('limits:compareHealth', (_e, kind, a, b) =>
    deps.limits.compare(kind === 'seven_day' ? 'seven_day' : 'five_hour', range(a), range(b))
  )

  const side = (v: unknown): CompareSide => {
    const o = (v ?? {}) as Record<string, unknown>
    const n = (x: unknown): number | undefined =>
      typeof x === 'number' && Number.isFinite(x) ? x : undefined
    const t = (x: unknown): string | undefined =>
      typeof x === 'string' && x ? x.slice(0, 100) : undefined
    return { from: n(o.from), to: n(o.to), version: t(o.version), model: t(o.model) }
  }
  ipcMain.handle('usage:trends', async (_e, groupBy) => {
    const by: TrendGroupBy = groupBy === 'model' || groupBy === 'version' ? groupBy : 'all'
    // Limit-health scores ($ per 1%, per 1x of plan) mark capacity changes.
    const health = deps.limits.health('five_hour')
    return buildTrends({
      records: usage.allRecords(),
      turns: usage.allTurns(),
      readings: deps.limits.readings(),
      capacity: health.windows
        .filter((w) => w.closed && !w.excluded && w.dollars > 0)
        .map((w) => ({
          ts: w.resetsAt,
          kind: 'five_hour' as const,
          pct: w.pct,
          weighted: w.dollars,
          capacity: w.perPct / w.mult,
          mix: ''
        })),
      plans: health.plans,
      timeZone: localTimeZone(),
      weekStart: deps.weekStart(),
      groupBy: by
    })
  })
  ipcMain.handle('usage:compare', (_e, a, b) =>
    compareTrends(
      { records: usage.allRecords(), turns: usage.allTurns(), readings: deps.limits.readings() },
      side(a),
      side(b)
    )
  )
  ipcMain.handle('bridge:plan', (_e, id, a) => deps.installer.plan(source(id), action(a)))
  ipcMain.handle('bridge:apply', async (_e, id, a, token) => {
    const res = await deps.installer.apply(source(id), action(a), String(token))
    deps.onBridgeChanged?.()
    void deps.limits.scan()
    deps.limits.emit('changed')
    return res
  })
  ipcMain.handle('bridge:openBackups', async () => {
    await mkdir(deps.installer.backupDir, { recursive: true })
    await shell.openPath(deps.installer.backupDir)
  })

  ipcMain.handle('usage:report', (_e, q) =>
    usage.report(cleanQuery(q), deps.billingOf, deps.sourceOf)
  )
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
