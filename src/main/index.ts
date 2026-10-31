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
import { callHandler, setAppPage } from './ipc-guard'
import { JsonStore } from './core/json-store'
import { registerMobileIpc } from './ipc-mobile'
import type { MobileFile } from './mobile/devices'
import { MobileService, webAppFile } from './mobile/service'
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
import { httpsFetcher } from './services/anthropic-api'
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
let mobile: MobileService

/**
 * "Confirm on PC": ask before a phone launches anything. No answer within a
 * minute counts as no.
 */
async function confirmOnPc(device: string, what: string): Promise<boolean> {
  const w = mainWindow
  if (!w || w.isDestroyed()) return false
  if (w.isMinimized()) w.restore()
  w.show()
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
  setAppPage(RENDERER_INDEX, process.env.ELECTRON_RENDERER_URL)

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
    if (typeof s.remoteControlDefault !== 'boolean') s.remoteControlDefault = false
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
    // whose network stays blocked. Only reportUrl() URLs ever reach this, and
    // redirects are never followed.
    fetcher: httpsFetcher,
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
    launched: (s, opts, cwd, ctx) => {
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
    onSettingsChanged: () => {
      usage.emit('changed')
      mobile?.push('settings')
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
    rescanSources: async () => {
      await sessions.rescan()
      await watcher.restart()
    },
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
    keys: encryptor,
    appVersion: app.getVersion(),
    fixtures: FIXTURES,
    claudePath: async () => (await platform.launchTools()).claude,
    proposeKey: (device, key) => terminal.proposeKey(device, key)
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
  usage.on('changed', () => mobile.push('usage'))
  limits.on('changed', () => mobile.push('limits'))
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
  createWindow(settings.value.window)
  meter.restore()

  void sessions
    .start()
    .then(() => watcher.restart())
    // A fixed bridge script only reaches an existing install this way.
    .then(() =>
      installer
        .refreshScripts(sessions.sources)
        .catch((err: unknown) => console.warn('could not refresh bridge scripts', err))
    )
    .then(() => Promise.all([usage.start(), limits.start()]))
    .then(() => accounts.startAutoRefresh())
    .then(async () => {
      if (FIXTURES) await seedFixtureBridge(paths.dataDir, sessions, installer)
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
        spellcheck: false
      }
    })
    mainWindow = win
    if (bounds?.maximized) win.maximize()
    win.once('ready-to-show', () => win.show())
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
