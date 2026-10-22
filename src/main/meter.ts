// The tray icon (5-hour % ring, drawn by the renderer) and the optional
// always-on-top mini meter window.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'
import type { JsonStore } from './core/json-store'
import type { SettingsFile } from './services/store'

export interface MeterDeps {
  settings: JsonStore<SettingsFile>
  preload: string
  icon: string
  /** Background colour for new windows (matches the theme). */
  background: () => string
  showUsage: () => void
  loadRenderer: (win: BrowserWindow, hash: string) => void
}

export function createMeter(deps: MeterDeps): { closeAll: () => void; restore: () => void } {
  let tray: Tray | undefined
  let mini: BrowserWindow | undefined

  const isOpen = (): boolean => !!mini && !mini.isDestroyed()

  const buildMenu = (): Menu =>
    Menu.buildFromTemplate([
      { label: 'Open Usage', click: () => deps.showUsage() },
      { label: 'Mini meter', type: 'checkbox', checked: isOpen(), click: () => toggle() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])

  const remember = (open: boolean): void => {
    deps.settings.update((s) => {
      const b = mini && !mini.isDestroyed() ? mini.getBounds() : undefined
      s.miniMeter = { ...(s.miniMeter ?? {}), open, ...(b ? { x: b.x, y: b.y } : {}) }
    })
  }

  const open = (): void => {
    if (isOpen()) {
      mini!.show()
      return
    }
    const pos = deps.settings.value.miniMeter
    mini = new BrowserWindow({
      width: 288,
      height: 148,
      x: pos?.x,
      y: pos?.y,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'Claude usage',
      backgroundColor: deps.background(),
      icon: deps.icon,
      webPreferences: {
        preload: deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    mini.setAlwaysOnTop(true, 'floating')
    mini.once('ready-to-show', () => mini?.showInactive())
    mini.on('moved', () => remember(true))
    mini.on('closed', () => {
      mini = undefined
      tray?.setContextMenu(buildMenu())
    })
    deps.loadRenderer(mini, 'mini')
    remember(true)
    tray?.setContextMenu(buildMenu())
  }

  const close = (): void => {
    remember(false)
    if (isOpen()) mini!.close()
  }

  const toggle = (): boolean => {
    if (isOpen()) close()
    else open()
    return isOpen()
  }

  ipcMain.handle('mini:toggle', () => toggle())
  ipcMain.handle('mini:close', () => close())
  ipcMain.handle('tray:set', (_e, dataUrl: unknown, tooltip: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return
    try {
      const img = nativeImage.createFromDataURL(dataUrl)
      if (img.isEmpty()) return
      if (!tray) {
        tray = new Tray(img)
        tray.on('click', () => deps.showUsage())
        tray.setContextMenu(buildMenu())
      } else {
        tray.setImage(img)
      }
      tray.setToolTip(typeof tooltip === 'string' ? tooltip.slice(0, 120) : 'Claude usage')
    } catch {
      // No tray on this desktop.
    }
  })

  return {
    closeAll: () => {
      if (isOpen()) mini!.destroy()
      tray?.destroy()
      tray = undefined
    },
    restore: () => {
      if (deps.settings.value.miniMeter?.open) open()
    }
  }
}
