import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { clockOffset } from '@shared/clock'
import { sessionToMarkdown } from '@shared/markdown'
import { sanitizePrices } from '@shared/usage/pricing'
import { sanitizePlan, sanitizeThresholds, sanitizeWeights } from '@shared/usage/limits'
import { isUuid } from '@shared/jsonl'
import {
  PLAN_MULT,
  sanitizeElsewhere,
  sanitizeHealth,
  sanitizePlanHistory,
  toYmd
} from '@shared/usage/health'
import { sanitizePace } from '@shared/usage/pace'
import { cleanEffortChoice, cleanModelChoice, sanitizeProjectModels } from '@shared/model-choice'
import { normalizeProjectKey } from '@shared/project-key'
import type {
  AppInfo,
  AppSettings,
  BranchRequest,
  LaunchOptions,
  SessionMeta,
  TerminalPref,
  ThemePref
} from '@shared/types'
import { archiveStats } from './core/archive'
import type { JsonStore } from './core/json-store'
import { handle } from './ipc-guard'
import { assertUserWrite, isInside } from './core/safe-paths'
import { windowsPathToWsl } from './core/wsl'
import type { Platform } from './platform'
import type { Launcher } from './services/launcher'
import type { SessionService } from './services/sessions'
import type { AppPaths, SettingsFile } from './services/store'
import type { SourceWatcher } from './services/watcher'
import { importIntoCatalogue } from './services/imports'
import type { MetadataFile } from './services/store'

export interface IpcDeps {
  platform: Platform
  paths: AppPaths
  sessions: SessionService
  launcher: Launcher
  settings: JsonStore<SettingsFile>
  metadata: JsonStore<MetadataFile>
  watcher: SourceWatcher
  applyTheme: (theme: ThemePref, resolved?: 'light' | 'dark') => void
  onSettingsChanged?: () => void
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v
}

const TERMINALS: TerminalPref[] = ['wt', 'powershell', 'cmd']
const THEMES: ThemePref[] = ['light', 'dark', 'system']

function publicSettings(s: SettingsFile): AppSettings {
  return {
    skipPermissionsDefault: s.skipPermissionsDefault,
    terminal: s.terminal,
    theme: s.theme,
    extraFolders: [...s.extraFolders],
    scanStoppedDistros: s.scanStoppedDistros,
    weekStart: s.weekStart === 'sunday' ? 'sunday' : 'monday',
    prices: s.prices.map((p) => ({ ...p })),
    plan: s.plan,
    alertsEnabled: s.alertsEnabled,
    alertThresholds: [...s.alertThresholds],
    capacityWeights: { ...s.capacityWeights },
    defaultBilling: s.defaultBilling,
    projectBilling: { ...s.projectBilling },
    adminRefreshMinutes: s.adminRefreshMinutes,
    branchConfirmed: s.branchConfirmed === true,
    planHistory: s.planHistory.map((p) => ({ ...p })),
    health: { ...s.health },
    pace: { ...s.pace },
    elsewhere: s.elsewhere.map((e) => ({ ...e })),
    askSkipPreview: s.askSkipPreview,
    askTimeoutSec: s.askTimeoutSec,
    remoteControlDefault: s.remoteControlDefault === true,
    defaultModel: s.defaultModel,
    defaultEffort: s.defaultEffort,
    projectModels: Object.fromEntries(
      Object.entries(s.projectModels ?? {}).map(([k, v]) => [k, { ...v }])
    )
  }
}

const billingValue = (v: unknown): string | undefined =>
  typeof v === 'string' && (v === 'subscription' || /^acct-[A-Za-z0-9-]{1,40}$/.test(v))
    ? v
    : undefined

function branchRequest(v: unknown): BranchRequest | undefined {
  if (!v || typeof v !== 'object') return undefined
  const b = v as Record<string, unknown>
  if (typeof b.at !== 'string' || !b.at || b.at.length > 200) return undefined
  return {
    at: b.at,
    mode: b.mode === 'before' ? 'before' : 'include',
    newSessionId: isUuid(b.newSessionId) ? b.newSessionId : undefined,
    createOnly: b.createOnly === true
  }
}

function launchOpts(v: unknown): LaunchOptions {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    key: str(o.key, 'key'),
    fork: o.fork === true,
    skipPermissions: o.skipPermissions === true,
    cwdOverride: typeof o.cwdOverride === 'string' && o.cwdOverride ? o.cwdOverride : undefined,
    billingAccountId:
      typeof o.billingAccountId === 'string' && o.billingAccountId ? o.billingAccountId : undefined,
    newSession: o.newSession === true,
    branch: branchRequest(o.branch),
    terminal: TERMINALS.includes(o.terminal as TerminalPref)
      ? (o.terminal as TerminalPref)
      : undefined,
    remoteControl: o.remoteControl === true
  }
}

function safeFileName(title: string): string {
  return (
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'session'
  )
}

export function registerIpc(deps: IpcDeps): void {
  const { sessions, settings, paths, platform } = deps
  const win = (): BrowserWindow | undefined => BrowserWindow.getAllWindows()[0]

  sessions.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('sessions:changed', sessions.payload())
  })

  const rescan = async (): Promise<void> => {
    await sessions.rescan()
    await deps.watcher.restart()
  }

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    fixtures: platform.fixtures,
    clockOffset: clockOffset(),
    dataDir: paths.dataDir,
    archiveDir: paths.archiveDir
  }))

  handle('sessions:list', () => sessions.payload())
  handle('sessions:get', (_e, key) => sessions.detail(str(key, 'key')))
  handle('sessions:search', (_e, q) => sessions.searchKeys(str(q, 'query')))
  handle('sessions:updateMeta', (_e, key, patch) =>
    sessions.updateMeta(str(key, 'key'), (patch ?? {}) as Partial<SessionMeta>)
  )
  handle('sessions:applyClaudeNames', (_e, keys) =>
    sessions.applyClaudeNames(
      (Array.isArray(keys) ? keys : []).slice(0, 10_000).map((k) => str(k, 'key'))
    )
  )
  handle('sessions:rescan', () => rescan())

  handle('settings:get', () => publicSettings(settings.value))
  handle('settings:update', async (_e, patch: Partial<AppSettings>) => {
    const p = patch ?? {}
    const before = settings.value
    const rescanNeeded =
      'scanStoppedDistros' in p && p.scanStoppedDistros !== before.scanStoppedDistros
    settings.update((s) => {
      if (typeof p.skipPermissionsDefault === 'boolean')
        s.skipPermissionsDefault = p.skipPermissionsDefault
      if (TERMINALS.includes(p.terminal as TerminalPref)) s.terminal = p.terminal as TerminalPref
      if (THEMES.includes(p.theme as ThemePref)) s.theme = p.theme as ThemePref
      if (typeof p.scanStoppedDistros === 'boolean') s.scanStoppedDistros = p.scanStoppedDistros
      if (p.weekStart === 'monday' || p.weekStart === 'sunday') s.weekStart = p.weekStart
      if ('prices' in p) {
        const prices = sanitizePrices(p.prices)
        if (prices) s.prices = prices
      }
      if ('planHistory' in p) s.planHistory = sanitizePlanHistory(p.planHistory)
      const plan = sanitizePlan(p.plan)
      if (plan && plan !== s.plan && !('planHistory' in p)) {
        // Record the switch so older windows keep their old plan's multiplier.
        const today = toYmd(new Date())
        const hist = s.planHistory.length
          ? s.planHistory
          : [{ from: '2000-01-01', plan: s.plan, mult: PLAN_MULT[s.plan] }]
        s.planHistory = sanitizePlanHistory([
          ...hist.filter((h) => h.from !== today),
          { from: today, plan, mult: PLAN_MULT[plan] }
        ])
      }
      if (plan) s.plan = plan
      if ('health' in p) s.health = sanitizeHealth({ ...s.health, ...(p.health ?? {}) })
      if ('pace' in p) s.pace = sanitizePace({ ...s.pace, ...(p.pace ?? {}) })
      if ('elsewhere' in p) s.elsewhere = sanitizeElsewhere(p.elsewhere)
      if (typeof p.askSkipPreview === 'boolean') s.askSkipPreview = p.askSkipPreview
      if (typeof p.askTimeoutSec === 'number' && p.askTimeoutSec >= 15)
        s.askTimeoutSec = Math.min(1800, Math.round(p.askTimeoutSec))
      if (typeof p.alertsEnabled === 'boolean') s.alertsEnabled = p.alertsEnabled
      const th = sanitizeThresholds(p.alertThresholds)
      if (th) s.alertThresholds = th
      const w = sanitizeWeights(p.capacityWeights)
      if (w && 'capacityWeights' in p) s.capacityWeights = w
      const db = billingValue(p.defaultBilling)
      if (db) s.defaultBilling = db
      if (p.projectBilling && typeof p.projectBilling === 'object') {
        const next: Record<string, string> = {}
        for (const [k, v] of Object.entries(p.projectBilling).slice(0, 500)) {
          const b = billingValue(v)
          // Legacy WSL keys (bare paths) are kept until they can be migrated.
          const key = normalizeProjectKey(k, true)
          if (b && key) next[key] = b
        }
        s.projectBilling = next
      }
      if (typeof p.branchConfirmed === 'boolean') s.branchConfirmed = p.branchConfirmed
      if (typeof p.remoteControlDefault === 'boolean')
        s.remoteControlDefault = p.remoteControlDefault
      if ('defaultModel' in p) {
        const m = cleanModelChoice(p.defaultModel)
        if (m) s.defaultModel = m
      }
      if ('defaultEffort' in p) {
        const e = cleanEffortChoice(p.defaultEffort)
        if (e) s.defaultEffort = e
      }
      if ('projectModels' in p) s.projectModels = sanitizeProjectModels(p.projectModels)
      if (typeof p.adminRefreshMinutes === 'number' && p.adminRefreshMinutes >= 0)
        s.adminRefreshMinutes = Math.min(1440, Math.round(p.adminRefreshMinutes))
    })
    deps.onSettingsChanged?.()
    await settings.flush()
    if (p.theme) deps.applyTheme(settings.value.theme)
    if (rescanNeeded) void rescan()
    return publicSettings(settings.value)
  })
  handle('settings:addFolder', async () => {
    const w = win()
    const res = w
      ? await dialog.showOpenDialog(w, {
          title: 'Add a folder to scan',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Add a folder to scan',
          properties: ['openDirectory']
        })
    const folder = res.filePaths[0]
    if (!res.canceled && folder && !isInside(folder, paths.dataDir)) {
      settings.update((s) => {
        if (!s.extraFolders.some((f) => f.toLowerCase() === folder.toLowerCase()))
          s.extraFolders.push(folder)
      })
      await settings.flush()
      void rescan()
    }
    return publicSettings(settings.value)
  })
  handle('settings:removeFolder', async (_e, folder) => {
    const f = str(folder, 'folder')
    settings.update((s) => {
      s.extraFolders = s.extraFolders.filter((x) => x !== f)
    })
    await settings.flush()
    void rescan()
    return publicSettings(settings.value)
  })

  handle('archive:stats', async () => ({
    dir: paths.archiveDir,
    ...(await archiveStats(paths.archiveDir))
  }))
  handle('import:claudeAi', async () => {
    const w = win()
    const opts: Electron.OpenDialogOptions = {
      title: 'Import a claude.ai data export',
      properties: ['openFile'],
      filters: [{ name: 'claude.ai export', extensions: ['zip'] }]
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    const file = res.filePaths[0]
    if (res.canceled || !file) return null
    return importIntoCatalogue(file, paths, deps.metadata, sessions)
  })
  handle('archive:open', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.archiveDir, { recursive: true })
    await shell.openPath(paths.archiveDir)
  })
  handle('sessions:showFile', (_e, key) => {
    const s = sessions.get(str(key, 'key'))
    if (s) shell.showItemInFolder(s.filePath)
  })
  handle('sources:openSettings', async (_e, id) => {
    // Opens Claude's settings folder in Explorer. The app never edits it.
    const src = sessions.source(str(id, 'id'))
    if (src?.claudeSettingsPath) await shell.openPath(dirname(src.claudeSettingsPath))
  })

  handle('launch:preview', (_e, opts) => deps.launcher.preview(launchOpts(opts)))
  handle('launch:run', (_e, opts) => deps.launcher.launch(launchOpts(opts)))
  handle('launch:pickCwd', async (_e, key) => {
    const s = sessions.get(str(key, 'key'))
    if (!s) return null
    const w = win()
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the working folder',
      properties: ['openDirectory']
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    const picked = res.filePaths[0]
    if (res.canceled || !picked) return null
    if (s.env === 'wsl') return windowsPathToWsl(picked, s.distro) ?? null
    return picked
  })

  handle('export:markdown', async (_e, key) => {
    const detail = await sessions.detail(str(key, 'key'))
    if (!detail) return { saved: false, error: 'Session not found' }
    const w = win()
    const opts: Electron.SaveDialogOptions = {
      title: 'Export session to Markdown',
      defaultPath: `${safeFileName(detail.summary.title)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { saved: false }
    try {
      assertUserWrite(res.filePath)
      await writeFile(res.filePath, sessionToMarkdown(detail), 'utf8')
      return { saved: true, path: res.filePath }
    } catch (err) {
      return { saved: false, error: (err as Error).message }
    }
  })

  handle('clipboard:write', (_e, text) => clipboard.writeText(str(text, 'text')))
  handle('theme:set', (_e, theme, resolved) => {
    if (THEMES.includes(theme)) deps.applyTheme(theme, resolved === 'dark' ? 'dark' : 'light')
  })
  handle('shell:openExternal', async (_e, url) => {
    const u = str(url, 'url')
    if (/^https?:\/\//i.test(u)) await shell.openExternal(u)
  })

  nativeTheme.on('updated', () => deps.applyTheme(settings.value.theme))
}
