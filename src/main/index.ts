import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell
} from 'electron'
import { DEFAULT_MOBILE } from '@shared/mobile'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import { addSnapshotExtras, DEFAULT_PRICES, sanitizePrices } from '@shared/usage/pricing'
import {
  DEFAULT_WEIGHTS,
  PLAN_LABEL,
  sanitizePlan,
  sanitizeThresholds,
  sanitizeWeights
} from '@shared/usage/limits'
import { sanitizeElsewhere, sanitizeHealth, sanitizePlanHistory } from '@shared/usage/health'
import { sanitizePace } from '@shared/usage/pace'
import type { ThemePref } from '@shared/types'
import { SOURCE_LABELS } from '@shared/source-label'
import { isDevServerUrl } from './core/app-url'
import { NO_CWD_SEARCH } from './core/launch'
import { callHandler, handle, setAppPage } from './ipc-guard'
import { JsonStore } from './core/json-store'
import { registerMobileIpc } from './ipc-mobile'
import { registerLiveIpc } from './ipc-live'
import { registerGitIpc } from './ipc-git'
import { GitLinksService } from './git/service'
import { createRealBackend } from './git/backend'
import { createFixturesBackend } from './git/fixtures'
import { createProcessRunner } from './git/runner'
import { sanitizeGitSettings } from '@shared/git/types'
import { wslRoots } from './core/wsl'
import { realProcChecker } from './core/procs'
import { createHooksStore, HooksInstaller } from './services/hooks'
import {
  CODEX_HOOKS,
  codexHookPaths,
  CodexHooksInstaller,
  createCodexHooksStore
} from './services/codex-hooks'
import { LiveService } from './services/live'
import { desktopText } from '@shared/live-alerts'
import type { MobileFile } from './mobile/devices'
import { MobileService, webAppFile, type KeyBox } from './mobile/service'
import { fakeTailscale, TailscaleClient } from './mobile/tailscale'
import { webAssets } from './mobile/web-assets'
import { registerTerminalIpc } from './ipc-terminal'
import { fakePc } from './terminal/fake'
import { realHostKeys, realProbe, realRunner } from './terminal/host'
import {
  emptyTerminalFile,
  sshUserName,
  TerminalService,
  type TerminalFile
} from './terminal/service'
import { fileExists } from './core/which'
import { readFile } from 'node:fs/promises'
import {
  fixturesLayout,
  prepareFixtures,
  seedFixtureBridge,
  seedFixtureLive,
  fixtureCodexReader,
  seedFixtureCodexLive,
  fixtureProcChecker,
  seedFixtureAccounts,
  seedFixtureData,
  seedFixtureUsage
} from './fixtures'
import { providerSettings, registerIpc } from './ipc'
import { claudeProvider } from './providers/claude'
import { createCodexProvider } from './providers/codex'
import { CompactTextCache } from './providers/codex/text-cache'
import { ProviderRegistry } from './providers/registry'
import { providerOf } from '@shared/provider'
import { createMeter } from './meter'
import { registerUsageIpc } from './ipc-usage'
import { registerAccountsIpc } from './ipc-accounts'
import { registerAskIpc } from './ipc-ask'
import { registerSummaryIpc } from './ipc-summaries'
import { registerContextIpc } from './ipc-context'
import { ContextCost, publishContextReadings } from './services/context-cost'
import { CodexLimitsService } from './services/codex-limits'
import { codexUsageSettings } from '@shared/usage/codex-settings'
import { sanitizeContextWarning } from '@shared/context'
import { PrintRunner } from './services/print-runner'
import { sanitizeSummarySettings, SUMMARY_USAGE_KEY, SUMMARY_USAGE_LABEL } from '@shared/summary'
import { AccountsService, createAccountsStore, type Encryptor } from './services/accounts'
import { httpsFetcher } from './services/anthropic-api'
import { BillingService } from './services/billing'
import { createFixturesPlatform, createRealPlatform, type Platform } from './platform'
import { mark, profileStartup, timed, watchEventLoop } from './timing'
import { HIDDEN_ARG, setStartWithWindows, startWithWindows } from './login-item'
import { createNotifier } from './notify'
import { CodexAppService, codexProtocolRegistered } from './providers/codex/app'
import { BridgeInstaller, cleanupSettingsLeftovers, createBridgeStore } from './services/bridge'
import { Launcher } from './services/launcher'
import { LineageService } from './services/lineage'
import { LimitsService } from './services/limits'
import { SessionService } from './services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from './services/store'
import { UsageService, usagePaths } from './services/usage'
import { SourceWatcher } from './services/watcher'
import {
  cleanEffortChoice,
  cleanModelChoice,
  DEFAULT_CHOICE,
  sanitizeProjectModels
} from '@shared/model-choice'
import { migrateLegacyKeys } from '@shared/project-key'
import { sanitizeLiveAlerts } from '@shared/live-alerts'
import { applyPendingRestore } from './core/backup-restore'
import { BackupService, createBackupStore } from './services/backup'
import { registerBackupIpc } from './ipc-backup'

// Windows looks for a program in the current folder before PATH. The app
// starts programs by absolute path anyway; this documented opt-out also covers
// anything found by name, here (libuv honours it) and in every process the app
// starts (cmd.exe honours it, e.g. for the `node` that npm's claude.cmd runs).
if (process.platform === 'win32') process.env[NO_CWD_SEARCH] = '1'

const FIXTURES = process.argv.includes('--fixtures') || process.env.CSD_FIXTURES === '1'
const appRoot = app.getAppPath()
// Fixtures mode runs on the sample data's clock, so "today" has data.
if (FIXTURES) setClockOffset(FIXTURES_NOW - Date.now())

// All of the app's own data (including Chromium's cache) lives in
// %APPDATA%\ClaudeSessionDashboard — or .fixtures-data/appdata in fixtures mode.
const dataDir = FIXTURES
  ? fixturesLayout(appRoot).dataDir
  : join(app.getPath('appData'), 'ClaudeSessionDashboard')
app.setPath('userData', dataDir)
app.setPath('sessionData', join(dataDir, 'chromium'))

const CHROME = {
  light: { bg: '#f5f5f4', symbol: '#3f3f46' },
  dark: { bg: '#131315', symbol: '#d4d4d8' }
}

let mainWindow: BrowserWindow | undefined
/**
 * Windows identifies a desktop app's notifications by its AppUserModelID and
 * the Toast Activator CLSID Electron registers for it (Electron also writes
 * both into the app's Start Menu shortcut). The installed and portable app
 * use the installer's appId; `npm run dev` its own id, so development
 * notifications never mix with the installed app's. Without them Electron used
 * its default id and a new random CLSID on every start, so Windows had to take
 * in a changed registration at the first notification of each run.
 */
const APP_ID = 'com.beaulewis.claude-session-dashboard'
const APP_USER_MODEL_ID = app.isPackaged ? APP_ID : `${APP_ID}.dev`
const TOAST_ACTIVATOR_CLSID = app.isPackaged
  ? '{6D3F2B8A-5C41-4E7B-9A0D-2F8E1C7B4A63}'
  : '{B1E94C27-3A6F-4D85-8C12-7E5A9F0D3B48}'

function setAppIdentity(): void {
  if (process.platform !== 'win32') return
  app.setAppUserModelId(APP_USER_MODEL_ID)
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID)
}

/** Started at login (Settings → Start with Windows): only the tray icon until it's opened. */
const START_HIDDEN = process.argv.includes(HIDDEN_ARG)
/** The window was maximized when last closed, and a hidden start hasn't shown it yet. */
let maximizeOnReveal = false

/** Show and focus the main window (also the first time after a hidden start). */
function revealMain(): BrowserWindow | undefined {
  const w = mainWindow
  if (!w || w.isDestroyed()) return undefined
  if (maximizeOnReveal) {
    maximizeOnReveal = false
    w.maximize()
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  return w
}
let mobile: MobileService

/**
 * "Confirm on PC": ask before a phone launches anything. No answer within a
 * minute counts as no.
 */
async function confirmOnPc(device: string, what: string): Promise<boolean> {
  const w = revealMain()
  if (!w) return false
  w.flashFrame(true)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 60_000)
  try {
    const r = await dialog.showMessageBox(w, {
      type: 'question',
      buttons: ['Allow', 'Deny'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Launch from your phone',
      message: `“${device}” wants to ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
      detail:
        'It opens in a terminal on this PC with Remote Control on, on your Claude subscription, with permission prompts on. Nothing happens unless you allow it (no answer in 1 minute = Deny).',
      signal: ac.signal
    })
    return r.response === 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    w.flashFrame(false)
  }
}

function resolvedTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function applyTheme(theme: ThemePref, resolved?: 'light' | 'dark'): void {
  nativeTheme.themeSource = theme
  const r = resolved ?? resolvedTheme()
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  w.setBackgroundColor(CHROME[r].bg)
  if (process.platform !== 'darwin') {
    try {
      w.setTitleBarOverlay({ color: CHROME[r].bg, symbolColor: CHROME[r].symbol, height: 44 })
    } catch {
      // Not supported on this platform/window.
    }
  }
}

/**
 * No network: block every request that isn't the local app or dev server.
 * Spellcheck is off (its dictionaries would be downloaded), and the pages get
 * no web permissions (camera, notifications, …): the app uses none.
 */
function blockNetwork(): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    const local =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      isDevServerUrl(url, devUrl)
    cb({ cancel: !local })
  })
  ses.setSpellCheckerEnabled(false)
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

/** The app's windows never navigate away or open other windows (links go to the browser). */
function lockNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDevServerUrl(url, process.env.ELECTRON_RENDERER_URL)) e.preventDefault()
  })
}

const RENDERER_INDEX = join(__dirname, '../renderer/index.html')

async function main(): Promise<void> {
  // Windows: the app's identity for its notifications, set before any is shown.
  setAppIdentity()
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    revealMain()
  })

  await app.whenReady()
  mark('app ready')
  watchEventLoop()
  await profileStartup()
  blockNetwork()
  setAppPage(RENDERER_INDEX, process.env.ELECTRON_RENDERER_URL)

  let platform: Platform
  if (FIXTURES) {
    await prepareFixtures(appRoot, { usageHistory: true, codex: true })
    const layout = fixturesLayout(appRoot)
    platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  } else {
    platform = createRealPlatform()
  }

  const paths = appPaths(dataDir)
  // Every desktop notification, and what Windows did with it, is logged
  // (logs/notifications.jsonl; no titles or text).
  const notify = createNotifier({
    isSupported: () => Notification.isSupported(),
    create: ({ title, body }) =>
      new Notification({ title, body, icon: join(appRoot, 'resources', 'icon.png') }),
    logFile: join(paths.dataDir, 'logs', 'notifications.jsonl'),
    identity: () => ({
      appUserModelId: APP_USER_MODEL_ID,
      toastActivatorCLSID: process.platform === 'win32' ? app.toastActivatorCLSID : undefined,
      packaged: app.isPackaged,
      version: app.getVersion()
    })
  })
  // A restore staged before the restart (Settings → Backup) is finished first,
  // before any of the app's data is loaded.
  const restored = await applyPendingRestore(paths.dataDir, {
    archiveDir: paths.archiveDir,
    now: Date.now()
  }).catch((err: unknown) => {
    console.warn('could not finish the restore', err)
    return undefined
  })
  const metadata = createMetadataStore(paths)
  const settings = createSettingsStore(paths)
  await Promise.all([metadata.load(), settings.load()])
  // Settings files from before Phase 5 lack the new keys.
  settings.update((s) => {
    if (s.weekStart !== 'sunday') s.weekStart = 'monday'
    const saved = sanitizePrices(s.prices)
    s.prices = saved ? addSnapshotExtras(saved) : DEFAULT_PRICES.map((p) => ({ ...p }))
    s.plan = sanitizePlan(s.plan) ?? 'max5'
    if (typeof s.alertsEnabled !== 'boolean') s.alertsEnabled = true
    s.alertThresholds = sanitizeThresholds(s.alertThresholds) ?? [75, 90]
    s.capacityWeights = sanitizeWeights(s.capacityWeights) ?? { ...DEFAULT_WEIGHTS }
    if (typeof s.defaultBilling !== 'string') s.defaultBilling = 'subscription'
    if (!s.projectBilling || typeof s.projectBilling !== 'object') s.projectBilling = {}
    if (typeof s.adminRefreshMinutes !== 'number') s.adminRefreshMinutes = 60
    s.planHistory = sanitizePlanHistory(s.planHistory)
    s.health = sanitizeHealth(s.health)
    s.pace = sanitizePace(s.pace)
    s.elsewhere = sanitizeElsewhere(s.elsewhere)
    if (typeof s.askSkipPreview !== 'boolean') s.askSkipPreview = false
    if (typeof s.askTimeoutSec !== 'number') s.askTimeoutSec = 180
    if (typeof s.remoteControlDefault !== 'boolean') s.remoteControlDefault = false
    s.defaultModel = cleanModelChoice(s.defaultModel) ?? DEFAULT_CHOICE
    s.defaultEffort = cleanEffortChoice(s.defaultEffort) ?? DEFAULT_CHOICE
    s.projectModels = sanitizeProjectModels(s.projectModels)
    s.liveAlerts = sanitizeLiveAlerts(s.liveAlerts)
    s.summaries = sanitizeSummarySettings(s.summaries)
    s.contextWarning = sanitizeContextWarning(s.contextWarning)
  })
  if (FIXTURES) {
    await seedFixtureData(appRoot, paths.archiveDir, metadata)
    await seedFixtureUsage(appRoot, paths.dataDir)
  }

  // Claude Code and Codex; Settings → Providers can turn either off (never both).
  const providers = new ProviderRegistry([
    claudeProvider,
    // Big Codex rollouts' compact text is kept in the app's cache folder (never backed up).
    createCodexProvider({
      textCache: new CompactTextCache(join(paths.dataDir, 'cache', 'codex'), paths.dataDir)
    })
  ])
  providers.setEnabled(providerSettings(settings.value).providers)
  const sessions = new SessionService(platform, paths, metadata, settings, providers)
  const watcher = new SourceWatcher(sessions)
  const lineage = new LineageService(sessions)

  // API keys and a remembered backup password: encrypted with safeStorage
  // (DPAPI on Windows), through its asynchronous API (keys saved with the old
  // synchronous one decrypt the same way). Availability is checked once, now.
  // On Linux the "basic_text" backend isn't real encryption, so keys are
  // refused there.
  const canEncrypt =
    (await safeStorage.isAsyncEncryptionAvailable().catch(() => false)) &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  const encryptor: Encryptor = {
    available: () => canEncrypt,
    encrypt: (t) => safeStorage.encryptStringAsync(t),
    decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result
  }
  // The phone companion's own TLS and push keys: the same asynchronous API.
  // Keys it saved with the synchronous one are re-encrypted on first read
  // (see mobile/secrets.ts).
  const phoneKeys: KeyBox = {
    available: () => canEncrypt,
    encrypt: (t) => safeStorage.encryptStringAsync(t),
    decrypt: (b) => safeStorage.decryptStringAsync(b)
  }
  const accountsStore = createAccountsStore(paths.dataDir)
  await accountsStore.load()
  if (FIXTURES) await seedFixtureAccounts(appRoot, accountsStore, metadata, settings)
  const accounts = new AccountsService(accountsStore, encryptor, {
    // Node's fetch in the main process: not routed through the window's session,
    // whose network stays blocked. Only reportUrl() URLs ever reach this, and
    // redirects are never followed.
    fetcher: httpsFetcher,
    userAgent: `ClaudeSessionDashboard/${app.getVersion()}`,
    sampleAdminDir: FIXTURES
      ? join(fixturesLayout(appRoot).fixturesDir, 'usage', 'admin')
      : undefined,
    refreshMinutes: () => settings.value.adminRefreshMinutes,
    // A restored account took over another account with the same key: every
    // session tagged with the old one, and every default, points to it now.
    onMerge: async (from, to) => {
      for (const [sid, m] of Object.entries(metadata.value.sessions))
        if (m.billing?.mode === 'api' && m.billing.accountId === from)
          sessions.tagBilling(sid, { ...m.billing, accountId: to })
      settings.update((st) => {
        if (st.defaultBilling === from) st.defaultBilling = to
        for (const [k, v] of Object.entries(st.projectBilling))
          if (v === from) st.projectBilling[k] = to
      })
      await Promise.all([metadata.flush(), settings.flush()]).catch(() => undefined)
      mobile?.push('settings')
    }
  })
  await accounts.init()
  let bridgeGuess: (sessionId: string) => 'subscription' | 'api' | 'unknown' = () => 'unknown'
  const billing = new BillingService(
    sessions,
    (sid) => bridgeGuess(sid),
    (id) => !!accounts.get(id)
  )
  const launcher = new Launcher(
    platform,
    sessions,
    () => settings.value.terminal,
    {
      keyFor: (id) => accounts.keyFor(id),
      label: (id) => {
        const a = accounts.get(id)
        return a ? `API · ${a.nickname}` : undefined
      },
      subscriptionLabel: () => `Subscription (${PLAN_LABEL[settings.value.plan]})`,
      launched: (s, opts, cwd, ctx) => {
        // Billing tags and Remote Control are Claude Code's.
        if (providerOf(s) !== 'claude') return
        const at = new Date().toISOString()
        const tag = {
          mode: opts.billingAccountId ? ('api' as const) : ('subscription' as const),
          accountId: opts.billingAccountId,
          source: 'launch' as const,
          at
        }
        const remote = opts.remoteControl ? { at, via: ctx.via, device: ctx.device } : undefined
        if (opts.fork || opts.newSession) billing.expect(s.sourceId, cwd, tag, remote)
        else {
          sessions.tagBilling(s.sessionId, tag)
          if (remote) sessions.tagRemote(s.sessionId, remote)
        }
        if (opts.fork) lineage.expectFork(s)
      }
    },
    () => settings.value,
    paths.dataDir
  )
  // The mini meter, once it exists: fit it to what it shows after a settings change.
  let refitMeter = (): void => undefined
  // Codex's settings (plan, baseline, its own price table), with defaults; worked out
  // again only when the settings change.
  let codexCache: { from: unknown; value: ReturnType<typeof codexUsageSettings> } | undefined
  const codexSettings = (): ReturnType<typeof codexUsageSettings> => {
    const s = settings.value
    const key = [
      s.codexPlan,
      s.codexAccounts,
      s.codexPlanMults,
      s.codexHealth,
      s.codexElsewhere,
      s.codexPrices,
      s.meterProvider,
      s.usageSplit
    ]
    if (!codexCache || (codexCache.from as unknown[]).some((v, i) => v !== key[i]))
      codexCache = { from: key, value: codexUsageSettings(s) }
    return codexCache.value
  }
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: settings.value.weekStart,
    prices: settings.value.prices,
    codexPrices: codexSettings().codexPrices
  }))
  registerIpc({
    platform,
    paths,
    sessions,
    launcher,
    settings,
    metadata,
    watcher,
    applyTheme,
    onSettingsChanged: () => {
      usage.emit('changed')
      mobile?.push('settings')
      refitMeter()
    }
  })
  const bridgeStore = createBridgeStore(paths.dataDir)
  await bridgeStore.load()
  const installer = new BridgeInstaller(bridgeStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(appRoot, 'resources', 'bridge'),
    gitBash: () => platform.gitBash()
  })
  const sourceOf = (key: string): string => {
    if (key === SUMMARY_USAGE_KEY) return SUMMARY_USAGE_LABEL
    const ses = sessions.get(key)
    return ses ? SOURCE_LABELS[ses.source] : SOURCE_LABELS.unknown
  }
  const limits = new LimitsService(
    sessions,
    usage,
    installer,
    bridgeStore,
    join(paths.dataDir, 'limits-history.ndjson'),
    paths.dataDir,
    () => ({
      plan: settings.value.plan,
      alertsEnabled: settings.value.alertsEnabled,
      alertThresholds: settings.value.alertThresholds,
      weights: settings.value.capacityWeights,
      prices: settings.value.prices,
      health: settings.value.health,
      planHistory: settings.value.planHistory,
      pace: settings.value.pace,
      elsewhere: settings.value.elsewhere
    }),
    (title, body) => {
      if (!Notification.isSupported()) return
      // Paired phones get the same alert as a toast.
      mobile.toast(title, body)
      notify({ kind: 'limits', title, body, onClick: () => showUsage() })
    },
    undefined,
    sourceOf
  )
  const codexLimits = new CodexLimitsService(
    usage,
    () => {
      const c = codexSettings()
      return {
        plan: c.codexPlan,
        accounts: c.codexAccounts,
        mults: c.codexPlanMults,
        health: c.codexHealth,
        elsewhere: c.codexElsewhere,
        prices: c.codexPrices,
        pace: settings.value.pace,
        weights: settings.value.capacityWeights,
        alertsEnabled: settings.value.alertsEnabled,
        alertThresholds: settings.value.alertThresholds
      }
    },
    (title, body) => {
      mobile.toast(title, body)
      notify({ kind: 'codex-limits', title, body, onClick: () => showUsage() })
    },
    sourceOf
  )
  bridgeGuess = (sid) => limits.billingOf(sid)
  sessions.contextResolver = (sid) => limits.contextOf(sid)
  publishContextReadings(limits, sessions)
  const contextCost = new ContextCost({
    limits,
    usage,
    settings: () => settings.value,
    codex: { limits: codexLimits, prices: () => codexSettings().codexPrices }
  })
  launcher.contextEstimate = (s, l) => contextCost.estimate(s, l)
  // "Open in Codex app" (Windows): reads the app's project list, opens codex:// links.
  launcher.codexApp = {
    service: new CodexAppService({
      supported: process.platform === 'win32' && !FIXTURES,
      home: () => (process.platform === 'win32' ? join(platform.windowsHome, '.codex') : undefined),
      protocolRegistered: codexProtocolRegistered
    }),
    open: (link) => shell.openExternal(link)
  }
  registerContextIpc({ sessions, launcher, cost: contextCost })
  usage.on('changed', () => limits.emit('changed'))
  limits.on('changed', () => billing.refreshInferred())
  registerUsageIpc({
    usage,
    limits,
    codexLimits,
    installer,
    sessions,
    platform,
    rescanSources: async () => {
      await sessions.rescan()
      await watcher.restart()
    },
    weekStart: () => settings.value.weekStart,
    sourceOf,
    billingOf: (key) => {
      // Summaries only ever run on the subscription.
      if (key === SUMMARY_USAGE_KEY) return PLAN_LABEL[settings.value.plan]
      const b = sessions.get(key)?.billing
      if (!b || b.mode === 'unknown') return 'Unknown'
      if (b.mode === 'subscription') return PLAN_LABEL[settings.value.plan]
      const a = b.accountId ? accounts.get(b.accountId) : undefined
      return a ? `API · ${a.nickname}` : 'API'
    }
  })
  const creditsDeps = {
    accounts,
    sessions,
    usage,
    readings: () => limits.readings(),
    settings: () => ({
      prices: settings.value.prices,
      weekStart: settings.value.weekStart,
      defaultBilling: settings.value.defaultBilling
    })
  }
  registerAccountsIpc(creditsDeps)
  // One claude -p runner (CLI lookup, subscription check) for Ask Claude and summaries.
  const printRunner = new PrintRunner()
  const askIpc = await registerAskIpc({
    dataDir: paths.dataDir,
    usage,
    limits,
    codex: { limits: codexLimits, prices: () => codexSettings().codexPrices },
    settings,
    runner: printRunner,
    simulate: FIXTURES
  })
  const summaries = registerSummaryIpc({
    dataDir: paths.dataDir,
    sessions,
    usage,
    limits,
    settings,
    runner: printRunner,
    simulate: FIXTURES
  })
  limits.on('changed', () => accounts.emit('changed'))

  // Backups of the app's own data to a folder I pick (see services/backup.ts).
  const backupStore = createBackupStore(paths.dataDir)
  await backupStore.load()
  const backup = new BackupService({
    store: backupStore,
    dataDir: paths.dataDir,
    appVersion: app.getVersion(),
    encryptor,
    // A backup missed while the app was closed has run (done or failed).
    notify: (title, body) => notify({ kind: 'backup', title, body, onClick: () => showBackup() }),
    beforeBackup: async () => {
      await Promise.all([
        metadata.flush(),
        settings.flush(),
        accountsStore.flush(),
        askIpc.flush()
      ]).catch(() => undefined)
    }
  })
  if (restored) backup.recordRestore(restored)
  await backup.init()
  // Opt-in (off by default): restore safety copies older than 30 days.
  void backup.autoCleanSafety()
  const devServer = !!process.env.ELECTRON_RENDERER_URL
  registerBackupIpc({
    backup,
    dataDir: paths.dataDir,
    canRelaunch: !devServer,
    restart: () => {
      // In development the dev server owns the window's page: quit only.
      if (!devServer) app.relaunch()
      app.quit()
    }
  })
  backup.start()

  // Settings → Start with Windows (minimized to tray): read from and written to Windows itself.
  const loginEnv = { platform: process.platform, execPath: process.execPath, env: process.env }
  handle('app:startWithWindows', () => startWithWindows(app, loginEnv))
  handle('app:setStartWithWindows', (_e, on) => setStartWithWindows(app, loginEnv, on === true))

  // Phone companion: off by default, 127.0.0.1 only (see mobile/).
  const mobileStore = new JsonStore<MobileFile>(
    join(paths.dataDir, 'mobile.json'),
    paths.dataDir,
    () => ({
      version: 1,
      devices: [],
      activity: []
    })
  )
  await mobileStore.load()
  const rendererDir = join(__dirname, '../renderer')
  const appIcon = nativeImage.createFromPath(join(appRoot, 'resources', 'icon.png'))
  const iconCache = new Map<number, Buffer>()
  mobile = new MobileService({
    store: mobileStore,
    settings: () => ({ ...DEFAULT_MOBILE, ...settings.value.mobile }),
    saveSettings: async (next) => {
      settings.update((s) => {
        s.mobile = next
      })
      await settings.flush()
    },
    call: callHandler,
    launch: {
      session: (key) => sessions.get(key),
      preview: (opts) => launcher.preview(opts),
      launch: (opts, ctx) => launcher.launch(opts, ctx),
      settings: () => ({
        terminal: settings.value.terminal,
        branchConfirmed: settings.value.branchConfirmed === true
      }),
      confirm: (device, what) => confirmOnPc(device.name, what)
    },
    web: webAssets(rendererDir, (size) => {
      if (appIcon.isEmpty()) return undefined
      if (!iconCache.has(size))
        iconCache.set(size, appIcon.resize({ width: size, height: size, quality: 'best' }).toPNG())
      return iconCache.get(size)
    }),
    webAppFile: webAppFile(rendererDir),
    tailscale: FIXTURES
      ? fakeTailscale({ dnsName: 'ryzen-desktop.tail1234.ts.net' })
      : new TailscaleClient(),
    keys: phoneKeys,
    appVersion: app.getVersion(),
    fixtures: FIXTURES,
    claudePath: async () => (await platform.launchTools()).claude,
    proposeKey: (device, key) => terminal.proposeKey(device, key),
    // Running now is created below; this runs only for a phone's request.
    resolveLiveRef: (deviceId, ref) => live.resolveRef(deviceId, ref)
  })
  registerMobileIpc({ mobile, store: mobileStore, fixtures: FIXTURES })

  // Terminal access: Windows' OpenSSH Server over Tailscale (see terminal/).
  const terminalStore = new JsonStore<TerminalFile>(
    join(paths.dataDir, 'terminal.json'),
    paths.dataDir,
    emptyTerminalFile
  )
  await terminalStore.load()
  const fakeSsh = FIXTURES
    ? fakePc({
        config: await readFile(join(fixturesLayout(appRoot).fixturesDir, 'ssh', 'sshd_config')),
        installed: false
      })
    : undefined
  const terminal = new TerminalService({
    store: terminalStore,
    dataDir: paths.dataDir,
    supported: process.platform === 'win32' && !FIXTURES,
    simulated: FIXTURES,
    run: fakeSsh?.run ?? realRunner(join(paths.dataDir, 'terminal-work')),
    probe: fakeSsh?.probe ?? realProbe,
    hostKeys: fakeSsh?.hostKeys ?? realHostKeys,
    tailscale: () => mobile.refreshTailscale(),
    exists: fileExists,
    user: FIXTURES ? 'beau' : sshUserName()
  })
  registerTerminalIpc({ terminal, launcher, dataDir: paths.dataDir })
  // Phones show or hide "Open terminal here" from this.
  terminal.on('changed', () => mobile.push('policy'))
  sessions.on('changed', () => mobile.push('sessions'))
  // Billing defaults from 1.4.0 and older keyed WSL projects by path alone:
  // move them to "wsl:<distro>:<path>" once their sessions are known.
  const migrateBillingKeys = (): void => {
    const before = settings.value.projectBilling
    const next = migrateLegacyKeys(before, sessions.list())
    if (next === before) return
    settings.update((s) => {
      s.projectBilling = next
    })
    void settings.flush().catch(() => undefined)
    mobile.push('settings')
  }
  sessions.on('changed', migrateBillingKeys)
  usage.on('changed', () => mobile.push('usage'))
  limits.on('changed', () => mobile.push('limits'))
  codexLimits.on('changed', () => mobile.push('limits'))

  // Running now and session alerts (the opt-in hook bridge, see services/hooks.ts).
  const hooksStore = createHooksStore(paths.dataDir)
  await hooksStore.load()
  const hooks = new HooksInstaller(hooksStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(appRoot, 'resources', 'bridge'),
    readScript: (p) => readFile(p, 'utf8')
  })
  const codexHooksStore = createCodexHooksStore(paths.dataDir)
  await codexHooksStore.load()
  const codexHooks = new CodexHooksInstaller(codexHooksStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(appRoot, 'resources', 'bridge'),
    readScript: (p) => readFile(p, 'utf8')
  })
  const live = new LiveService({
    sessions,
    hooks,
    codexHooks,
    ...(FIXTURES ? { codexReader: fixtureCodexReader() } : {}),
    procs: FIXTURES ? fixtureProcChecker() : realProcChecker(),
    settings: () => sanitizeLiveAlerts(settings.value.liveAlerts),
    distroRoot: (id) => sessions.source(id)?.distroRoot,
    notify: (alert, title) => {
      const t = desktopText(alert, title)
      notify({ kind: 'session-alert', ...t, onClick: () => showLive(alert.key) })
    },
    push: (kind, refFor) => mobile.webPush({ kind, ref: refFor })
  })
  registerLiveIpc({ live, hooks, codexHooks, sessions, fixtures: FIXTURES })

  // Git links: commits, branches and PRs per session, read-only (see git/service.ts).
  // Fixtures mode uses sample repos and starts no git or gh.
  const gitLinks = new GitLinksService({
    sessions,
    backend: FIXTURES
      ? await createFixturesBackend(fixturesLayout(appRoot).fixturesDir)
      : createRealBackend(createProcessRunner({ cwd: paths.dataDir }), {
          exists: fileExists,
          wslRoots
        }),
    platform,
    dataDir: paths.dataDir,
    settings: () => ({
      git: sanitizeGitSettings(settings.value.gitLinks),
      scanStoppedDistros: settings.value.scanStoppedDistros
    })
  })
  sessions.gitBadgeResolver = (key) => gitLinks.badge(key)
  sessions.gitFilter = (q) => gitLinks.filter(q)
  registerGitIpc({
    git: gitLinks,
    settings,
    onSettingsChanged: () => mobile.push('settings')
  })
  live.on('changed', () => mobile.push('live'))
  accounts.on('changed', () => mobile.push('credits'))

  nativeTheme.themeSource = settings.value.theme
  const loadRenderer = (w: BrowserWindow, hash: string): void => {
    if (process.env.ELECTRON_RENDERER_URL)
      void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    else void w.loadFile(RENDERER_INDEX, { hash })
  }
  const meter = createMeter({
    settings,
    preload: join(__dirname, '../preload/index.cjs'),
    icon: join(appRoot, 'resources', 'icon.png'),
    background: () => CHROME[resolvedTheme()].bg,
    showUsage: () => showUsage(),
    loadRenderer,
    lockNavigation
  })
  refitMeter = meter.refit
  mark('services ready, window created')
  // Find Windows Terminal, Claude Code and Codex now, before the first scan
  // fills Node's file threads: the first Resume dialog then doesn't wait for it.
  void timed('startup: terminal and Claude lookup', platform.launchTools()).catch(() => undefined)
  createWindow(settings.value.window)
  // A hidden start has no window to open from: the tray icon is there at once
  // (the renderer paints the usage ring onto it once the limits load).
  if (START_HIDDEN) meter.ensureTray()
  meter.restore()

  void sessions
    .start()
    .then(() => mark('first session scan done'))
    .then(() => migrateBillingKeys())
    .then(() => watcher.restart())
    // Git links read repos in the background, after the scan and the forks' lineage
    // (a fork's copied history is its parent's work). Nothing waits for them.
    .then(() => {
      void lineage
        .refresh()
        .then(() => gitLinks.start())
        .catch((err: unknown) => console.warn('git links start failed', err))
    })
    // An interrupted save of settings.json: the app's own leftovers go
    // (a moved-aside file is put back only where settings.json is missing).
    .then(async () => {
      for (const src of sessions.sources) {
        if (src.kind !== 'auto' || src.status !== 'ok' || !src.claudeSettingsPath) continue
        const r = await cleanupSettingsLeftovers(
          src.claudeSettingsPath,
          installer.backupDir,
          paths.dataDir
        ).catch(() => undefined)
        if (r?.removed || r?.restored) console.info('settings.json leftovers tidied', src.id, r)
      }
      // The same for Codex's hooks.json (Codex session alerts).
      for (const src of sessions.sources) {
        const p = codexHookPaths(src)
        if (!p || src.status !== 'ok') continue
        const r = await cleanupSettingsLeftovers(
          p.hooksPath,
          codexHooks.backupDir,
          paths.dataDir,
          CODEX_HOOKS
        ).catch(() => undefined)
        if (r?.removed || r?.restored) console.info('hooks.json leftovers tidied', src.id, r)
      }
    })
    // A fixed bridge script only reaches an existing install this way.
    .then(() =>
      installer
        .refreshScripts(sessions.sources)
        .then(() => hooks.refreshScripts(sessions.sources))
        .then(() => codexHooks.refreshScripts(sessions.sources))
        .catch((err: unknown) => console.warn('could not refresh bridge scripts', err))
    )
    // Usage indexing runs alongside the rest: a full re-read of the history
    // (a parser update) can take minutes, and nothing below needs it. Codex
    // alerts start once the saved data is loaded, before the scan, so a
    // crossing the scan finds still alerts (what was saved never does).
    .then(() => {
      void Promise.all([usage.start(), limits.start()]).catch((err: unknown) =>
        console.warn('usage start failed', err)
      )
      void usage
        .whenLoaded()
        .then(() => codexLimits.start())
        .catch((err: unknown) => console.warn('Codex alerts start failed', err))
    })
    .then(() => accounts.startAutoRefresh())
    .then(async () => {
      if (FIXTURES) await seedFixtureBridge(paths.dataDir, sessions, installer)
      if (FIXTURES) await seedFixtureLive(paths.dataDir, sessions, hooks)
      if (FIXTURES) await seedFixtureCodexLive(sessions)
      live.start()
    })
    .then(() => mobile.autoStart())

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    void (async () => {
      await mobile.shutdown().catch(() => undefined)
      await mobileStore.flush().catch(() => undefined)
      await terminalStore.flush().catch(() => undefined)
      await watcher.close().catch(() => undefined)
      await sessions.idle().catch(() => undefined)
      await gitLinks.flush().catch(() => undefined)
      await usage.idle().catch(() => undefined)
      limits.stop()
      live.stop()
      summaries.stopAuto()
      summaries.cancel()
      await hooksStore.flush().catch(() => undefined)
      accounts.stop()
      await accountsStore.flush().catch(() => undefined)
      await bridgeStore.flush().catch(() => undefined)
      await askIpc.flush().catch(() => undefined)
      // A backup still running is just cut short: only complete snapshots count.
      backup.stop()
      await backupStore.flush().catch(() => undefined)
      await Promise.all([metadata.flush(), settings.flush()]).catch(() => undefined)
      app.quit()
    })()
  })

  function createWindow(bounds?: {
    width: number
    height: number
    x?: number
    y?: number
    maximized?: boolean
  }): void {
    const theme = resolvedTheme()
    const win = new BrowserWindow({
      width: bounds?.width ?? 1440,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 980,
      minHeight: 620,
      show: false,
      title: 'Claude Session Dashboard',
      backgroundColor: CHROME[theme].bg,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(process.platform !== 'darwin'
        ? {
            titleBarOverlay: {
              color: CHROME[theme].bg,
              symbolColor: CHROME[theme].symbol,
              height: 44
            }
          }
        : {}),
      icon: join(appRoot, 'resources', 'icon.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    mainWindow = win
    // Started with Windows (--hidden): no window, just the tray icon, until
    // it's opened (maximize() would show it, so that waits too).
    if (bounds?.maximized) {
      if (START_HIDDEN) maximizeOnReveal = true
      else win.maximize()
    }
    win.once('ready-to-show', () => {
      mark('window ready to show')
      if (!START_HIDDEN) win.show()
    })
    win.webContents.once('did-finish-load', () => mark('window page loaded'))
    lockNavigation(win)

    const saveBounds = (): void => {
      if (win.isDestroyed()) return
      const maximized = win.isMaximized()
      const b = maximized ? (settings.value.window ?? win.getNormalBounds()) : win.getBounds()
      settings.update((s) => {
        s.window = { width: b.width, height: b.height, x: b.x, y: b.y, maximized }
      })
    }
    // Closing the main window quits the app, mini meter included.
    win.on('closed', () => meter.closeAll())
    win.on('resized', saveBounds)
    win.on('moved', saveBounds)
    win.on('maximize', saveBounds)
    win.on('unmaximize', saveBounds)

    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(RENDERER_INDEX)
  }

  /** A session alert was clicked: show the window on that session. */
  function showLive(key: string): void {
    revealMain()?.webContents.send('app:showLive', key)
  }

  function showBackup(): void {
    revealMain()?.webContents.send('app:showSettings', 'backup')
  }

  function showUsage(): void {
    revealMain()?.webContents.send('app:showUsage')
  }

  app.on('window-all-closed', () => app.quit())
}

void main()
