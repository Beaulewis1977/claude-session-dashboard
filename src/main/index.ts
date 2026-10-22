import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, Notification, session, shell } from 'electron'
import { FIXTURES_NOW, setClockOffset } from '@shared/clock'
import { DEFAULT_PRICES, sanitizePrices } from '@shared/usage/pricing'
import {
  DEFAULT_WEIGHTS,
  sanitizePlan,
  sanitizeThresholds,
  sanitizeWeights
} from '@shared/usage/limits'
import type { ThemePref } from '@shared/types'
import {
  fixturesLayout,
  prepareFixtures,
  seedFixtureBridge,
  seedFixtureData,
  seedFixtureUsage
} from './fixtures'
import { registerIpc } from './ipc'
import { registerUsageIpc } from './ipc-usage'
import { createFixturesPlatform, createRealPlatform, type Platform } from './platform'
import { BridgeInstaller, createBridgeStore } from './services/bridge'
import { Launcher } from './services/launcher'
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
    s.prices = sanitizePrices(s.prices) ?? DEFAULT_PRICES.map((p) => ({ ...p }))
    s.plan = sanitizePlan(s.plan) ?? 'max5'
    if (typeof s.alertsEnabled !== 'boolean') s.alertsEnabled = true
    s.alertThresholds = sanitizeThresholds(s.alertThresholds) ?? [75, 90]
    s.capacityWeights = sanitizeWeights(s.capacityWeights) ?? { ...DEFAULT_WEIGHTS }
  })
  if (FIXTURES) {
    await seedFixtureData(appRoot, paths.archiveDir, metadata)
    await seedFixtureUsage(appRoot, paths.dataDir)
  }

  const sessions = new SessionService(platform, paths, metadata, settings)
  const watcher = new SourceWatcher(sessions)
  const launcher = new Launcher(platform, sessions, () => settings.value.terminal)
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
      prices: settings.value.prices
    }),
    (title, body) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body, icon: join(appRoot, 'resources', 'icon.png') })
      n.on('click', () => showUsage())
      n.show()
    }
  )
  usage.on('changed', () => limits.emit('changed'))
  registerUsageIpc({ usage, limits, installer, sessions, platform })

  nativeTheme.themeSource = settings.value.theme
  createWindow(settings.value.window)

  void sessions
    .start()
    .then(() => watcher.restart())
    .then(() => Promise.all([usage.start(), limits.start()]))
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
      await bridgeStore.flush().catch(() => undefined)
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
