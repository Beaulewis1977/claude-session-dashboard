import { app, BrowserWindow, clipboard, dialog, nativeTheme, shell } from 'electron'
import { sentOf, sessionsDelta, type SentList } from '@shared/sessions-delta'
import { coalesce } from './core/coalesce'
import {
  CUT,
  cutForViewer,
  matchesInCut,
  toolInputOf,
  toolResultOf,
  type CutLimits
} from '@shared/transcript-cut'
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
import {
  CODEX_EFFORT_LEVELS,
  cleanEffortChoice,
  cleanFastChoice,
  cleanModelChoice,
  DEFAULT_CHOICE,
  sanitizeProjectModels
} from '@shared/model-choice'
import { isProviderView, sanitizeProviderToggles } from '@shared/provider'
import { normalizeProjectKey } from '@shared/project-key'
import { isOpenIn, PROJECT_ID_RE, sanitizeProjectOpenIn } from '@shared/codex-app'
import { sanitizeLiveAlerts } from '@shared/live-alerts'
import { sanitizeSummarySettings } from '@shared/summary'
import { sanitizeContextWarning } from '@shared/context'
import { sanitizeGitSettings } from '@shared/git/types'
import { patchAskSessions, sanitizeAskSessions } from '@shared/ask-sessions/types'
import { codexSettingsPatch, codexUsageSettings } from '@shared/usage/codex-settings'
import {
  isCodexArchiveMode,
  type AppInfo,
  type AppSettings,
  type BranchRequest,
  type LaunchOptions,
  type SessionDetail,
  type SessionsPayload,
  type SessionMeta,
  type TerminalPref,
  type ThemePref
} from '@shared/types'
import { archiveStats } from './core/archive'
import type { JsonStore } from './core/json-store'
import { handle } from './ipc-guard'
import { toRenderer } from './outgoing'
import { assertUserWrite, isInside } from './core/safe-paths'
import { isValidDistroName, windowsPathToWsl } from './core/wsl'
import type { Platform } from './platform'
import type { Launcher } from './services/launcher'
import type { SessionService } from './services/sessions'
import type { AppPaths, SettingsFile } from './services/store'
import type { SourceWatcher } from './services/watcher'
import { importIntoCatalogue } from './services/imports'
import type { MetadataFile } from './services/store'
import { timed } from './timing'

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
    ...(s.coworkSource === true ? { coworkSource: true } : {}),
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
    defaultFast: cleanFastChoice(s.defaultFast) ?? 'off',
    projectModels: Object.fromEntries(
      Object.entries(s.projectModels ?? {}).map(([k, v]) => [k, { ...v }])
    ),
    liveAlerts: sanitizeLiveAlerts(s.liveAlerts),
    summaries: sanitizeSummarySettings(s.summaries),
    contextWarning: sanitizeContextWarning(s.contextWarning),
    ...providerSettings(s),
    ...codexUsageSettings(s),
    gitLinks: sanitizeGitSettings(s.gitLinks),
    askSessions: sanitizeAskSessions(s.askSessions)
  }
}

/** The Codex-era settings, with their defaults (absent from older settings files). */
export function providerSettings(
  s: Partial<SettingsFile>
): Required<
  Pick<
    AppSettings,
    | 'providers'
    | 'providerView'
    | 'codexArchive'
    | 'showSubagents'
    | 'codexDefaultModel'
    | 'codexDefaultEffort'
    | 'codexDefaultFast'
    | 'codexProjectModels'
    | 'codexOpenInDefault'
    | 'codexProjectOpenIn'
  >
> {
  return {
    providers: sanitizeProviderToggles(s.providers),
    providerView: isProviderView(s.providerView) ? s.providerView : 'all',
    codexArchive: isCodexArchiveMode(s.codexArchive) ? s.codexArchive : 'off',
    showSubagents: s.showSubagents === true,
    codexDefaultModel: cleanModelChoice(s.codexDefaultModel) ?? DEFAULT_CHOICE,
    codexDefaultEffort:
      cleanEffortChoice(s.codexDefaultEffort, CODEX_EFFORT_LEVELS) ?? DEFAULT_CHOICE,
    codexDefaultFast: cleanFastChoice(s.codexDefaultFast) ?? 'off',
    codexProjectModels: sanitizeProjectModels(s.codexProjectModels, CODEX_EFFORT_LEVELS),
    codexOpenInDefault: isOpenIn(s.codexOpenInDefault) ? s.codexOpenInDefault : 'terminal',
    codexProjectOpenIn: sanitizeProjectOpenIn(s.codexProjectOpenIn)
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
    remoteControl: o.remoteControl === true,
    continueFresh: continueRequest(o.continueFresh),
    ...(o.openIn === 'codex-app' || o.openIn === 'claude-app' ? { openIn: o.openIn } : {}),
    ...(o.allowDuplicate === true ? { allowDuplicate: true } : {}),
    ...acceptedProject(o.codexAppProject),
    ...placeOpts(o)
  }
}

/** "Use that project anyway?": the Codex app project the dialog showed (id and root). */
function acceptedProject(v: unknown): Pick<LaunchOptions, 'codexAppProject'> {
  if (!v || typeof v !== 'object') return {}
  const p = v as Record<string, unknown>
  return typeof p.id === 'string' &&
    PROJECT_ID_RE.test(p.id) &&
    typeof p.root === 'string' &&
    p.root.length > 0 &&
    p.root.length < 2000
    ? { codexAppProject: { id: p.id, root: p.root } }
    : {}
}

/** The opt-in for a session in a WSL-only folder, and its distro (see Launcher.place). */
function placeOpts(o: Record<string, unknown>): Pick<LaunchOptions, 'wslFolder' | 'distro'> {
  return {
    ...(o.wslFolder === true ? { wslFolder: true } : {}),
    ...(typeof o.distro === 'string' && isValidDistroName(o.distro) ? { distro: o.distro } : {})
  }
}

function continueRequest(v: unknown): LaunchOptions['continueFresh'] {
  if (!v || typeof v !== 'object') return undefined
  const c = v as Record<string, unknown>
  return { newSessionId: isUuid(c.newSessionId) ? c.newSessionId : undefined }
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

  // The session list goes to each window as changes to what it has (see
  // sessions-delta.ts): at most one a half second, one a second while a
  // scan runs. A window that loaded (or asked for the list) gets it in full.
  // Every list a window gets has a version, and each delta says which version
  // it applies to: the window applies it only to that one (else it asks for
  // the full list), so no change is ever lost or applied to the wrong list.
  const sent = new Map<number, { list: SentList; sources: string; scan: string; version: number }>()
  let versions = 0
  const remember = (id: number, p: SessionsPayload): SessionsPayload => {
    const version = ++versions
    sent.set(id, {
      list: sentOf(p),
      sources: JSON.stringify(p.sources),
      scan: JSON.stringify(p.scan),
      version
    })
    return { ...p, version }
  }
  const pushSessions = coalesce(
    () => {
      const p = sessions.payload()
      for (const w of BrowserWindow.getAllWindows()) {
        const wc = w.webContents
        const prev = sent.get(wc.id)
        if (!prev) {
          wc.send('sessions:changed', toRenderer(remember(wc.id, p)))
          continue
        }
        const { delta, next } = sessionsDelta(prev.list, p)
        const sources = JSON.stringify(p.sources)
        const scan = JSON.stringify(p.scan)
        const same =
          !delta.upserts.length &&
          !delta.removed.length &&
          !delta.keys &&
          sources === prev.sources &&
          scan === prev.scan
        if (same) continue
        const version = ++versions
        sent.set(wc.id, { list: next, sources, scan, version })
        wc.send('sessions:delta', toRenderer({ ...delta, base: prev.version, version }))
      }
    },
    () => (sessions.scanning ? 1000 : 500)
  )
  sessions.on('changed', pushSessions)
  // A window that loads again starts from the full list.
  app.on('web-contents-created', (_e, wc) => {
    const forget = (): void => void sent.delete(wc.id)
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) forget()
    })
    wc.on('render-process-gone', forget)
    wc.on('destroyed', forget)
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

  handle('sessions:list', (e) => {
    const p = sessions.payload()
    // What this window has now: later changes are sent as a delta from it.
    return e.sender?.id !== undefined ? remember(e.sender.id, p) : p
  })
  // The viewer asks for its transcript with long tool outputs and inputs cut (see
  // transcript-cut.ts); the full one is kept a little while for Show all,
  // Copy output and find in a cut part, then let go.
  let full:
    { key: string; detail: SessionDetail; limits: CutLimits; timer: NodeJS.Timeout } | undefined
  // The limits the viewer's copy of each session was cut with (find looks past the same cut).
  const cutWith = new Map<string, CutLimits>()
  const keepFull = (key: string, detail: SessionDetail, limits?: CutLimits): void => {
    if (full) clearTimeout(full.timer)
    const timer = setTimeout(() => (full = undefined), 120_000)
    timer.unref()
    if (limits) {
      cutWith.delete(key)
      cutWith.set(key, limits)
      if (cutWith.size > 50) cutWith.delete(cutWith.keys().next().value!)
    }
    full = { key, detail, limits: limits ?? cutWith.get(key) ?? CUT, timer }
  }
  const fullDetail = async (key: string): Promise<SessionDetail | null> => {
    if (full?.key === key) return full.detail
    const d = await sessions.detail(key)
    if (d) keepFull(key, d)
    return d
  }
  handle('sessions:get', async (_e, key, opts) => {
    const k = str(key, 'key')
    if ((opts as { cut?: unknown } | undefined)?.cut !== true) return sessions.detail(k)
    const d = await sessions.detail(k)
    if (!d) return d
    const sent = cutForViewer(d.messages)
    keepFull(k, d, sent.limits)
    return { ...d, messages: sent.messages }
  })
  handle('sessions:toolResult', async (_e, key, id) => {
    const d = await fullDetail(str(key, 'key'))
    return d ? (toolResultOf(d.messages, str(id, 'id')) ?? null) : null
  })
  handle('sessions:toolInput', async (_e, key, id) => {
    const d = await fullDetail(str(key, 'key'))
    return d ? (toolInputOf(d.messages, str(id, 'id')) ?? null) : null
  })
  handle('sessions:findInCut', async (_e, key, q) => {
    const k = str(key, 'key')
    const d = await fullDetail(k)
    return d ? matchesInCut(d.messages, str(q, 'query'), cutWith.get(k) ?? CUT) : []
  })
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
      ('scanStoppedDistros' in p && p.scanStoppedDistros !== before.scanStoppedDistros) ||
      (typeof p.coworkSource === 'boolean' && p.coworkSource !== (before.coworkSource === true))
    const archiveBefore = providerSettings(before).codexArchive
    settings.update((s) => {
      if ('providers' in p)
        s.providers = sanitizeProviderToggles({
          ...sanitizeProviderToggles(s.providers),
          ...((p.providers ?? {}) as object)
        })
      if (isProviderView(p.providerView)) s.providerView = p.providerView
      if (isCodexArchiveMode(p.codexArchive)) s.codexArchive = p.codexArchive
      if (typeof p.showSubagents === 'boolean') s.showSubagents = p.showSubagents
      if ('codexDefaultModel' in p) {
        const m = cleanModelChoice(p.codexDefaultModel)
        if (m) s.codexDefaultModel = m
      }
      if ('codexDefaultEffort' in p) {
        const e = cleanEffortChoice(p.codexDefaultEffort, CODEX_EFFORT_LEVELS)
        if (e) s.codexDefaultEffort = e
      }
      if ('codexDefaultFast' in p) {
        const f = cleanFastChoice(p.codexDefaultFast)
        if (f) s.codexDefaultFast = f
      }
      if ('codexProjectModels' in p)
        s.codexProjectModels = sanitizeProjectModels(p.codexProjectModels, CODEX_EFFORT_LEVELS)
      if (isOpenIn(p.codexOpenInDefault)) s.codexOpenInDefault = p.codexOpenInDefault
      if ('codexProjectOpenIn' in p)
        s.codexProjectOpenIn = sanitizeProjectOpenIn(p.codexProjectOpenIn)
      if (typeof p.skipPermissionsDefault === 'boolean')
        s.skipPermissionsDefault = p.skipPermissionsDefault
      if (TERMINALS.includes(p.terminal as TerminalPref)) s.terminal = p.terminal as TerminalPref
      if (THEMES.includes(p.theme as ThemePref)) s.theme = p.theme as ThemePref
      if (typeof p.scanStoppedDistros === 'boolean') s.scanStoppedDistros = p.scanStoppedDistros
      if (typeof p.coworkSource === 'boolean') s.coworkSource = p.coworkSource
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
      if ('defaultFast' in p) {
        const f = cleanFastChoice(p.defaultFast)
        if (f) s.defaultFast = f
      }
      if ('projectModels' in p) s.projectModels = sanitizeProjectModels(p.projectModels)
      // A partial change (one toggle) keeps the rest, quiet hours included.
      if ('liveAlerts' in p) {
        const cur = sanitizeLiveAlerts(s.liveAlerts)
        const next = (p.liveAlerts ?? {}) as Partial<typeof cur>
        s.liveAlerts = sanitizeLiveAlerts(
          { ...cur, ...next, quiet: { ...cur.quiet, ...(next.quiet ?? {}) } },
          cur
        )
      }
      // A partial change (one toggle) keeps the rest.
      if ('summaries' in p)
        s.summaries = sanitizeSummarySettings({
          ...sanitizeSummarySettings(s.summaries),
          ...((p.summaries ?? {}) as object)
        })
      // Ask across sessions: on only with the current notice accepted; a new
      // default model or effort replaces the Ask screen's remembered choice.
      if ('askSessions' in p && p.askSessions && typeof p.askSessions === 'object')
        s.askSessions = patchAskSessions(
          sanitizeAskSessions(s.askSessions),
          p.askSessions as unknown as Record<string, unknown>
        )
      if ('contextWarning' in p)
        s.contextWarning = sanitizeContextWarning({
          ...sanitizeContextWarning(s.contextWarning),
          ...((p.contextWarning ?? {}) as object)
        })
      if (typeof p.adminRefreshMinutes === 'number' && p.adminRefreshMinutes >= 0)
        s.adminRefreshMinutes = Math.min(1440, Math.round(p.adminRefreshMinutes))
      Object.assign(s, codexSettingsPatch(p, s))
    })
    deps.onSettingsChanged?.()
    await settings.flush()
    if (p.theme) deps.applyTheme(settings.value.theme)
    // Turning a provider on or off: scan (and watch) only the ones that are on.
    const toggled = sessions.providers.setEnabled(providerSettings(settings.value).providers)
    // A provider turned off leaves the list now, before the (slow) rescan.
    if (toggled) sessions.dropDisabled()
    if (rescanNeeded || toggled) void rescan()
    if (providerSettings(settings.value).codexArchive !== archiveBefore) sessions.archiveWantedNow()
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
    // Every provider's copies, on or off (a provider that's off keeps its archive).
    ...(await archiveStats(paths.archiveDir, ['.jsonl', '.jsonl.zst']))
  }))
  handle('archive:codexEstimate', () => sessions.codexArchiveEstimate())
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

  handle('launch:preview', (_e, opts) =>
    timed('launch:preview (total)', deps.launcher.preview(launchOpts(opts)))
  )
  handle('launch:run', (_e, opts) => deps.launcher.launch(launchOpts(opts)))
  // Which Codex models offer fast mode (read only from Codex's models_cache.json; null: unknown).
  handle('launch:fastModels', async () => ({
    codex: (await deps.launcher.codexFastModels?.get().catch(() => undefined)) ?? {}
  }))
  handle('launch:openInAgentApp', async (_e, key) => {
    const s = sessions.get(str(key, 'key'))
    if (!s) throw new Error('Session not found')
    // Built here from the session id (never a URL from the renderer), and only the
    // agent's own app scheme: a local link handled on this PC, not a network call.
    const link = sessions.providerOf(s).launch.appLink?.(s.sessionId)
    if (!link || !/^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(link))
      throw new Error("This session can't be opened in its app.")
    await shell.openExternal(link)
  })
  handle('launch:pickCwd', async (_e, key, where) => {
    const found = sessions.get(str(key, 'key'))
    if (!found) return null
    // As the session will run (WSL for a Codex desktop session with a Linux folder, …).
    const { s } = await deps.launcher.place(
      found,
      placeOpts((where ?? {}) as Record<string, unknown>)
    )
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
