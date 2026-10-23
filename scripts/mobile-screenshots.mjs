/* global window, document */
// The phone companion, end to end in fixtures mode: starts the built app,
// turns phone access on, pairs a phone-sized browser with a real pairing code,
// and saves phone-sized screenshots (plus Settings → Phone) to docs/.
// Usage: npm run build && node scripts/mobile-screenshots.mjs

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, chromium } from 'playwright'
import electronPath from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'mobile')
await mkdir(out, { recursive: true })

const args = [root, '--fixtures']
if (process.platform === 'linux') args.push('--no-sandbox')
const app = await electron.launch({
  executablePath: electronPath,
  args,
  env: { ...process.env, CSD_FIXTURES: '1' }
})
const desk = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setContentSize(1440, 900)
  w.center()
})
await desk.waitForSelector('[role="option"]')

// Turn phone access on and open pairing, as the Settings screen does.
// Its own port, so a running copy of the app (real data) can keep 47821.
await desk.evaluate(() => window.csd.mobileUpdate({ port: 47831, mode: 'tailscale' }))
let status = await desk.evaluate(() => window.csd.mobileStart())
if (!status.running) throw new Error(`Companion didn't start: ${status.error}`)
const base = `http://${status.listening}`
console.log('companion listening on', base, '· phone URL', status.url)

// Uses the installed Chrome if Playwright's own Chromium isn't downloaded.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }))
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
})
const page = await phone.newPage()
page.on('pageerror', (e) => console.error('phone page error:', e.message))
const shot = async (name) => {
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log('saved', name)
}

// Pair with a fresh one-time code from the PC.
const pairing = await desk.evaluate(() => window.csd.mobilePair())
await page.goto(`${base}/#pair=${pairing.code}`)
await page.waitForSelector('text=Connect to your PC')
await shot('pair')
await page.getByRole('button', { name: 'Pair this phone' }).click()
await page.waitForSelector('text=Sessions')
await page.waitForSelector('text=Live', { timeout: 15_000 })

for (const theme of ['dark', 'light']) {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => window.scrollTo(0, 0))
  const s = theme === 'dark' ? '' : '-light'

  // Sessions list.
  await page.getByRole('button', { name: 'Sessions' }).first().click()
  await page.waitForTimeout(600)
  await shot(`sessions${s}`)

  // A session, read in chat bubbles.
  await page.locator('button', { hasText: 'Safari login loop' }).first().click()
  await page.waitForSelector('text=Resume on PC')
  await page.waitForTimeout(800)
  await shot(`session${s}`)

  // Resume with Remote Control.
  await page.getByRole('button', { name: 'Resume on PC' }).click()
  await page.waitForSelector('text=Remote Control on')
  await shot(`resume${s}`)
  if (theme === 'dark') {
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.waitForSelector('text=Open in Claude app')
    await shot('resumed')
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Back to the list (the session screen's back button is the last "Sessions" button).
  await page.getByRole('button', { name: 'Sessions' }).last().click()
  await page.waitForTimeout(400)

  // Filters.
  await page.getByRole('button', { name: 'Filter and sort' }).click()
  await page.waitForTimeout(400)
  await shot(`filters${s}`)
  await page.keyboard.press('Escape')

  // Usage.
  await page.getByRole('button', { name: 'Usage', exact: true }).click()
  await page.waitForSelector('[data-shot="hero"]')
  await page.waitForTimeout(1200)
  await shot(`usage${s}`)
  await page.evaluate(() => document.querySelector('[data-scroll="usage"]')?.scrollBy({ top: 900 }))
  await shot(`usage-charts${s}`)

  // Settings (the safe subset).
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForTimeout(500)
  await shot(`settings${s}`)
}

// Desktop: Settings → Phone and the wizard.
await desk.evaluate(() => window.csd.updateSettings({ theme: 'dark' }))
await desk.reload()
await desk.waitForSelector('[role="option"]')
await desk.keyboard.press('Control+,')
await desk.waitForSelector('text=Paired phones')
await desk.locator('h2', { hasText: 'Phone' }).first().scrollIntoViewIfNeeded()
await desk.waitForTimeout(600)
await desk.screenshot({ path: join(out, 'desktop-settings-phone.png') })
console.log('saved desktop-settings-phone')
await desk.getByRole('button', { name: 'Connect your phone…' }).click()
await desk.waitForSelector('text=Step 1')
await desk.waitForTimeout(800)
await desk.screenshot({ path: join(out, 'desktop-wizard.png') })
console.log('saved desktop-wizard')
await desk.getByRole('button', { name: /Pair your phone/ }).click()
await desk.getByRole('button', { name: 'Show pairing code' }).click()
await desk.waitForSelector('text=Or type this code')
await desk.waitForTimeout(500)
await desk.screenshot({ path: join(out, 'desktop-wizard-pair.png') })
console.log('saved desktop-wizard-pair')

status = await desk.evaluate(() => window.csd.mobileStop())
await browser.close()
await app.close()
console.log('done; companion running after stop:', status.running)
