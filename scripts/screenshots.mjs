/* global window */
// Launches the built app in fixtures mode and saves screenshots to docs/.
// Usage: npm run screenshots   (on Linux without a display: xvfb-run -a npm run screenshots)

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronPath from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs')
await mkdir(out, { recursive: true })

const args = [root, '--fixtures']
if (process.platform === 'linux') args.push('--no-sandbox')

const app = await electron.launch({
  executablePath: electronPath,
  args,
  env: { ...process.env, CSD_FIXTURES: '1' }
})
const win = await app.firstWindow()
// Size the real window (viewport emulation breaks reloads in Electron).
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setContentSize(1440, 900)
  w.center()
})
await win.waitForSelector('[role="option"]')
await win.waitForTimeout(800)

const shot = async (name) => {
  await win.waitForTimeout(350)
  await win.screenshot({ path: join(out, `${name}.png`) })
  console.log('saved', name)
}
const setTheme = async (theme) => {
  await win.evaluate((t) => window.csd.updateSettings({ theme: t }), theme)
  await win.reload()
  await win.waitForSelector('[role="option"]')
  await win.waitForTimeout(700)
}
const selectByTitle = async (text) => {
  await win.locator('[role="option"]', { hasText: text }).first().dispatchEvent('mousedown')
  await win.waitForTimeout(500)
}

for (const theme of ['dark', 'light']) {
  await setTheme(theme)
  const suffix = theme === 'dark' ? '' : '-light'

  // Main screen with a rich session open.
  await selectByTitle('Safari login loop')
  await shot(`main${suffix}`)

  // Expanded tool calls.
  await selectByTitle('Cursor-based pagination')
  const tools = win.locator('button[aria-expanded="false"]', { hasText: 'Edit' })
  if (await tools.count()) await tools.first().click()
  const bash = win.locator('button[aria-expanded="false"]', { hasText: 'go test ./internal/http' })
  if (await bash.count()) await bash.first().click()
  await win.locator('button', { hasText: 'Edit' }).first().scrollIntoViewIfNeeded()
  await shot(`tools${suffix}`)

  if (theme === 'dark') {
    // Find in session.
    await win.keyboard.press('Control+f')
    await win.keyboard.type('cursor')
    await win.waitForTimeout(400)
    await shot('find')
    await win.keyboard.press('Escape')

    // Archived-only session + resume dialog with restore.
    await selectByTitle('Canvas particle demo')
    await shot('archived')
    await win.keyboard.press('Control+Enter')
    await win.waitForSelector('[role="dialog"]')
    await shot('resume-dialog')
    await win.keyboard.press('Escape')

    // Command palette.
    await win.keyboard.press('Control+k')
    await win.waitForTimeout(250)
    await win.keyboard.type('fork')
    await shot('command-palette')
    await win.keyboard.press('Escape')

    // Search.
    await win.keyboard.press('/')
    await win.keyboard.type('cookie')
    await win.waitForTimeout(500)
    await shot('search')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')

    // Shortcuts.
    await win.locator('#session-list').focus()
    await win.keyboard.press('Shift+?')
    await win.waitForSelector('[role="dialog"]')
    await shot('shortcuts')
    await win.keyboard.press('Escape')
  }

  // Settings.
  await win.keyboard.press('Control+,')
  await win.waitForTimeout(400)
  await shot(`settings${suffix}`)
  await win.keyboard.press('Escape')
}

await win.evaluate(() => window.csd.updateSettings({ theme: 'system' }))
await app.close()
