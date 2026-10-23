import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell
} from 'electron'
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
import {
  fixturesLayout,
  prepareFixtures,
  seedFixtureBridge,
  seedFixtureAccounts,
  seedFixtureData,
  seedFixtureUsage
} from './fixtures'
import { registerIpc } from './ipc'
import { createMeter } from './meter'
import { registerUsageIpc } from './ipc-usage'
import { registerAccountsIpc } from './ipc-accounts'
import { registerAskIpc } from './ipc-ask'
import { AccountsService, createAccountsStore, type Encryptor } from './services/accounts'
import { BillingService } from './services/billing'
import { createFixturesPlatform, createRealPlatform, type Platform } from './platform'
import { BridgeInstaller, createBridgeStore } from './services/bridge'
import { Launcher } from './services/launcher'
import { LineageService } from './services/lineage'
import { LimitsService } from './services/limits'
import { SessionService } from './services/sessions'
import { appPaths, createMetadataStore, createSettingsStore } from './services/store'
import { UsageService, usagePaths } from './services/usage'
import { SourceWatcher } from './services/watcher'

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

/** No network: block every request that isn't the local app or dev server. */
function blockNetwork(): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    const local =
      url.startsWith('file:') ||
      url.startsWith('devtools:') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      (devUrl !== undefined && (url.startsWith(devUrl) || /^wss?:\/\/localhost[:/]/.test(url)))
    cb({ cancel: !local })
  })
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  await app.whenReady()
  blockNetwork()

  let platform: Platform
  if (FIXTURES) {
    await prepareFixtures(appRoot, { usageHistory: true })
    const layout = fixturesLayout(appRoot)
    platform = createFixturesPlatform(layout.fixturesDir, layout.sourcesDir)
  } else {
    platform = createRealPlatform()
  }

  const paths = appPaths(dataDir)
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
  })
  if (FIXTURES) {
    await seedFixtureData(appRoot, paths.archiveDir, metadata)
    await seedFixtureUsage(appRoot, paths.dataDir)
  }

  const sessions = new SessionService(platform, paths, metadata, settings)
  const watcher = new SourceWatcher(sessions)
  const lineage = new LineageService(sessions)

  // API keys: encrypted with safeStorage (DPAPI on Windows). On Linux the
  // "basic_text" backend isn't real encryption, so keys are refused there.
  const encryptor: Encryptor = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (t) => safeStorage.encryptString(t),
    decrypt: (b) => safeStorage.decryptString(b)
  }
  const accountsStore = createAccountsStore(paths.dataDir)
  await accountsStore.load()
  if (FIXTURES) await seedFixtureAccounts(appRoot, accountsStore, metadata, settings)
  const accounts = new AccountsService(accountsStore, encryptor, {
    // Node's fetch in the main process: not routed through the window's session,
    // whose network stays blocked. Only reportUrl() URLs ever reach this.
    fetcher: (url, init) => fetch(url, { headers: init.headers, signal: init.signal }),
    userAgent: `ClaudeSessionDashboard/${app.getVersion()}`,
    sampleAdminDir: FIXTURES
      ? join(fixturesLayout(appRoot).fixturesDir, 'usage', 'admin')
      : undefined,
    refreshMinutes: () => settings.value.adminRefreshMinutes
  })
  let bridgeGuess: (sessionId: string) => 'subscription' | 'api' | 'unknown' = () => 'unknown'
  const billing = new BillingService(
    sessions,
    (sid) => bridgeGuess(sid),
    (id) => !!accounts.get(id)
  )
  const launcher = new Launcher(platform, sessions, () => settings.value.terminal, {
    keyFor: (id) => accounts.keyFor(id),
    label: (id) => {
      const a = accounts.get(id)
      return a ? `API · ${a.nickname}` : undefined
    },
    subscriptionLabel: () => `Subscription (${PLAN_LABEL[settings.value.plan]})`,
    launched: (s, opts, cwd) => {
      const tag = {
        mode: opts.billingAccountId ? ('api' as const) : ('subscription' as const),
        accountId: opts.billingAccountId,
        source: 'launch' as const,
        at: new Date().toISOString()
      }
      if (opts.fork || opts.newSession) billing.expect(s.sourceId, cwd, tag)
      else sessions.tagBilling(s.sessionId, tag)
      if (opts.fork) lineage.expectFork(s)
    }
  })
  const usage = new UsageService(sessions, usagePaths(paths.dataDir, paths.archiveDir), () => ({
    weekStart: settings.value.weekStart,
    prices: settings.value.prices
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
    onSettingsChanged: () => usage.emit('changed')
  })
  const bridgeStore = createBridgeStore(paths.dataDir)
  await bridgeStore.load()
  const installer = new BridgeInstaller(bridgeStore, {
    dataDir: paths.dataDir,
    scriptsDir: join(appRoot, 'resources', 'bridge'),
    gitBash: () => platform.gitBash()
  })
  const sourceOf = (key: string): string => {
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
      const n = new Notification({ title, body, icon: join(appRoot, 'resources', 'icon.png') })
      n.on('click', () => showUsage())
      n.show()
    },
    undefined,
    sourceOf
  )
  bridgeGuess = (sid) => limits.billingOf(sid)
  usage.on('changed', () => limits.emit('changed'))
  limits.on('changed', () => billing.refreshInferred())
  registerUsageIpc({
    usage,
    limits,
    installer,
    sessions,
    platform,
    weekStart: () => settings.value.weekStart,
    sourceOf,
    billingOf: (key) => {
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
  const askIpc = await registerAskIpc({
    dataDir: paths.dataDir,
    usage,
    limits,
    settings,
    simulate: FIXTURES
  })
  limits.on('changed', () => accounts.emit('changed'))

  nativeTheme.themeSource = settings.value.theme
  const loadRenderer = (w: BrowserWindow, hash: string): void => {
    if (process.env.ELECTRON_RENDERER_URL)
      void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
    else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  const meter = createMeter({
    settings,
    preload: join(__dirname, '../preload/index.cjs'),
    icon: join(appRoot, 'resources', 'icon.png'),
    background: () => CHROME[resolvedTheme()].bg,
    showUsage: () => showUsage(),
    loadRenderer
  })
  createWindow(settings.value.window)
  meter.restore()

  void sessions
    .start()
    .then(() => watcher.restart())
    .then(() => Promise.all([usage.start(), limits.start()]))
    .then(() => accounts.startAutoRefresh())
    .then(async () => {
      if (FIXTURES) await seedFixtureBridge(paths.dataDir, sessions, installer)
    })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    void (async () => {
      await watcher.close().catch(() => undefined)
      await sessions.idle().catch(() => undefined)
      await usage.idle().catch(() => undefined)
      limits.stop()
      accounts.stop()
      await accountsStore.flush().catch(() => undefined)
      await bridgeStore.flush().catch(() => undefined)
      await askIpc.flush().catch(() => undefined)
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
        spellcheck: true
      }
    })
    mainWindow = win
    if (bounds?.maximized) win.maximize()
    win.once('ready-to-show', () => win.show())

    // Links open in the default browser; the app itself never navigates away.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (e, url) => {
      const dev = process.env.ELECTRON_RENDERER_URL
      if (!(dev && url.startsWith(dev))) e.preventDefault()
    })

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
    else void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  function showUsage(): void {
    const w = mainWindow
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    w.webContents.send('app:showUsage')
  }

  app.on('window-all-closed', () => app.quit())
}

void main()
