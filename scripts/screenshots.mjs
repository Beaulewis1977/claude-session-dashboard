/* global window, document */
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
const scrollUsage = async (top) => {
  await win.evaluate(
    (y) => document.querySelector('[data-scroll="usage"]')?.scrollTo({ top: y }),
    top
  )
  await win.waitForTimeout(500)
}
const scrollUsageBy = async (dy) => {
  await win.evaluate(
    (d) => document.querySelector('[data-scroll="usage"]')?.scrollBy({ top: d }),
    dy
  )
  await win.waitForTimeout(400)
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
    // (Older sessions are far down the list, so filter to "Archived only" first.)
    await win.getByRole('button', { name: /Archived only/ }).click()
    await win.waitForTimeout(400)
    await selectByTitle('Canvas particle demo')
    await shot('archived')
    await win.keyboard.press('Control+Enter')
    await win.waitForSelector('[role="dialog"]')
    await shot('resume-dialog')
    await win.keyboard.press('Escape')
    await win.getByRole('button', { name: /All sessions/ }).click()
    await win.waitForTimeout(300)

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

    // Branch from here: the first-time explanation, the dialog, and a branch's family.
    await selectByTitle('Safari login loop')
    const bubble = win.locator('.group\\/msg').nth(3)
    await bubble.scrollIntoViewIfNeeded()
    await bubble.hover()
    await bubble.locator('button[aria-label="Branch from here"]').click()
    await win.waitForSelector('[role="dialog"]')
    await shot('branch-intro')
    await win.getByRole('button', { name: 'Continue' }).click()
    await win.waitForTimeout(900)
    await shot('branch-dialog')
    await win.keyboard.press('Escape')
    await selectByTitle('moment → dayjs instead')
    await win.getByRole('button', { name: 'Jump to branch point' }).click()
    await win.waitForTimeout(700)
    await shot('branches')
  }

  // Settings.
  await win.keyboard.press('Control+,')
  await win.waitForTimeout(400)
  await shot(`settings${suffix}`)
  await win.keyboard.press('Escape')

  // Usage & limits (Phase 5).
  await win.keyboard.press('Control+u')
  await win.waitForSelector('[data-shot="hero"]')
  await win.waitForTimeout(1200)
  await shot(`usage${suffix}`)
  const hero = win.locator('[data-shot="hero"]')
  await hero.screenshot({ path: join(out, `limits${suffix}.png`) })
  console.log('saved', `limits${suffix}`)
  await hero
    .locator(':scope > :nth-child(3)')
    .screenshot({ path: join(out, `credits${suffix}.png`) })
  console.log('saved', `credits${suffix}`)
  // Limit health ($ per 1% against the baseline) and where the limits went.
  const health = win.locator('[data-shot="health"]')
  await health.scrollIntoViewIfNeeded()
  await win.waitForTimeout(500)
  await health.screenshot({ path: join(out, `limit-health${suffix}.png`) })
  console.log('saved', `limit-health${suffix}`)
  if (theme === 'dark') {
    await win.getByRole('button', { name: 'Compare' }).click()
    await win.waitForTimeout(900)
    await health.screenshot({ path: join(out, 'limit-compare.png') })
    console.log('saved', 'limit-compare')
    await win.getByRole('button', { name: 'Compare' }).click()

    // Ask Claude: the preview of exactly what is sent, then the answer.
    await win.getByRole('button', { name: 'Ask Claude' }).first().click()
    await win.waitForTimeout(500)
    await win.getByRole('button', { name: 'Have my limits dropped?' }).click()
    await win.waitForSelector('text=What will be sent to Claude')
    await shot('ask-preview')
    await win.getByRole('button', { name: 'Send' }).click()
    await win.waitForSelector('text=Confidence', { timeout: 10_000 })
    await shot('ask-claude')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
  }
  await scrollUsage(640)
  await shot(`usage-charts${suffix}`)
  await win.locator('[data-shot="tabs"]').scrollIntoViewIfNeeded()
  await scrollUsageBy(-12)
  await shot(`trends${suffix}`)
  if (theme === 'dark') {
    await win.getByRole('tab', { name: 'Limit history' }).click()
    await win.waitForTimeout(500)
    await shot('limit-history')
    await win.getByRole('tab', { name: 'Credits' }).click()
    await win.waitForTimeout(500)
    await shot('credits-tab')
    await win.getByRole('tab', { name: 'Trends' }).click()

    // Mini meter.
    if (!(await win.evaluate(() => window.csd.toggleMiniMeter())))
      await win.evaluate(() => window.csd.toggleMiniMeter())
    await win.waitForTimeout(2500)
    const mini = app.windows().find((w) => w.url().includes('#mini'))
    if (mini) {
      await mini.screenshot({ path: join(out, 'mini-meter.png') })
      console.log('saved', 'mini-meter')
    }
    await win.evaluate(() => window.csd.toggleMiniMeter())

    // The enable dialog with the exact settings.json diff.
    await win.keyboard.press('Control+,')
    await win.waitForTimeout(500)
    await win.getByText('Live limits', { exact: true }).scrollIntoViewIfNeeded()
    await win.waitForTimeout(300)
    await shot('settings-live-limits')
    await win.getByRole('button', { name: 'Disable' }).first().click()
    await win.waitForSelector('[role="dialog"]')
    await win.waitForTimeout(600)
    await shot('disable-live-limits')
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    await win.getByRole('button', { name: 'Enable live limits' }).first().click()
    await win.waitForSelector('[role="dialog"]')
    await win.waitForTimeout(600)
    await shot('enable-live-limits')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
  }
  await win.keyboard.press('Escape')
}

await win.evaluate(() => window.csd.updateSettings({ theme: 'system' }))
await app.close()
